package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"next-terminal/server/common/nt"
	"next-terminal/server/common/term"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"next-terminal/server/common"
	"next-terminal/server/common/guacamole"
	"next-terminal/server/config"
	"next-terminal/server/env"
	"next-terminal/server/global/session"
	"next-terminal/server/log"
	"next-terminal/server/model"
	"next-terminal/server/repository"
	"next-terminal/server/utils"

	"gorm.io/gorm"
)

var SessionService = new(sessionService)

type sessionService struct {
	baseService
}

func (service sessionService) FixSessionState() error {
	sessions, err := repository.SessionRepository.FindByStatus(context.TODO(), nt.Connected)
	if err != nil {
		return err
	}

	if len(sessions) > 0 {
		for i := range sessions {
			s := model.Session{
				Status:           nt.Disconnected,
				DisconnectedTime: common.NowJsonTime(),
			}

			_ = repository.SessionRepository.UpdateById(context.TODO(), &s, sessions[i].ID)
		}
	}
	return nil
}

func (service sessionService) EmptyPassword() error {
	return repository.SessionRepository.EmptyPassword(context.TODO())
}

func (service sessionService) ClearOfflineSession() error {
	sessions, err := repository.SessionRepository.FindByStatus(context.TODO(), nt.Disconnected)
	if err != nil {
		return err
	}
	sessionIds := make([]string, 0)
	for i := range sessions {
		sessionIds = append(sessionIds, sessions[i].ID)
	}
	return service.DeleteByIds(context.TODO(), sessionIds)
}

// safeRecordingPath 把会话 ID 解析为录屏目录下的路径，拒绝任何逃出录屏根的输入。
//
// 必要性：sessionIds 直接来自 URL（DELETE /sessions/:id 支持逗号分隔的多个 ID），
// 未做过存在性校验。id 为 ".." 时 path.Join(recordingPath, "..") 会归一化为
// 录屏目录的父目录——默认配置下即 data/，其中包含 SQLite 数据库文件与 drive 存储，
// 一次 os.RemoveAll 就会连库一起删掉。
//
// 正常会话 ID 由 utils.UUID() 生成，不含路径分隔符，故这里做的是防御性校验。
func safeRecordingPath(recordingPath, sessionId string) (string, bool) {
	if sessionId == "" || strings.ContainsAny(sessionId, `/\`) {
		return "", false
	}
	base := filepath.Clean(recordingPath)
	target := filepath.Clean(filepath.Join(base, sessionId))
	if target == base || !strings.HasPrefix(target, base+string(filepath.Separator)) {
		return "", false
	}
	return target, true
}

func (service sessionService) DeleteByIds(c context.Context, sessionIds []string) error {
	// 先删数据库行，再删录屏文件。
	//
	// 原实现顺序相反：一旦 DELETE 失败（例如参数超过 SQLite 上限、连接超时），
	// 就会出现「录屏已经删掉、记录还留在列表里」的不一致——用户看到一条永远点不
	// 开回放的会话。反过来先删行，最坏情况只是留下几个无人引用的录屏文件。
	if err := repository.SessionRepository.DeleteByIds(c, sessionIds); err != nil {
		return err
	}

	recordingPath := config.GlobalCfg.Guacd.Recording
	for i := range sessionIds {
		target, ok := safeRecordingPath(recordingPath, sessionIds[i])
		if !ok {
			log.Warn("跳过非法录屏路径", log.String("sessionId", sessionIds[i]))
			continue
		}
		// 删除失败只记录：数据库行已删，此处失败不应让调用方误判为整体失败
		if err := os.RemoveAll(target); err != nil {
			log.Warn("删除录屏失败", log.String("sessionId", sessionIds[i]), log.NamedError("err", err))
		}
	}
	return nil
}

// CleanupKeepAliveSession 手动清理单个 keep-alive 会话：
// 用资产凭证 SSH 上去 kill tmux（不等 24h TTL），然后删除会话记录+录屏。
// tmux kill 失败不阻断删除——tmux 可能已自行退出，或资产已不可达；
// 记录警告后继续删除，不让用户的清理操作被远端故障卡住。
func (service sessionService) CleanupKeepAliveSession(sessionId string) error {
	ctx := context.TODO()
	s, err := repository.SessionRepository.FindById(ctx, sessionId)
	if err != nil {
		return fmt.Errorf("会话不存在: %w", err)
	}

	// kill tmux（仅 keep-alive 会话有意义）
	if s.KeepAlive == "1" && s.AssetId != "" && s.AssetId != "-" {
		asset, err := AssetService.FindByIdAndDecrypt(ctx, s.AssetId)
		if err == nil && asset.ID != "" {
			client, err := term.NewSshClient(s.IP, s.Port, asset.Username, asset.Password, asset.PrivateKey, asset.Passphrase)
			if err == nil {
				if err := term.KillTmux(client, sessionId); err != nil {
					log.Warn("手动清理：kill tmux 失败（继续删除记录）", log.String("sessionId", sessionId), log.NamedError("err", err))
				}
				client.Close()
			} else {
				log.Warn("手动清理：SSH 连接失败（继续删除记录）", log.String("sessionId", sessionId), log.NamedError("err", err))
			}
		}
	}

	// 删除会话记录 + 录屏文件
	return service.DeleteByIds(ctx, []string{sessionId})
}

func (service sessionService) ReviewedAll() error {
	// 一条 UPDATE 完成，不再「全量查 ID → 分批 UPDATE」：
	// 后者要把数万行读进内存并发出数百条 SQL，单连接下长时间独占数据库。
	if _, err := repository.SessionRepository.MarkAllReviewed(context.TODO(), true); err != nil {
		return err
	}
	return nil
}

var mutex sync.Mutex

func (service sessionService) CloseSessionById(sessionId string, code int, reason string) {
	// 临界区只保留「摘取会话 + 从管理器移除」这类内存操作。
	//
	// 原实现用 defer 把整个函数包在全局互斥锁里，其中包含向 WebSocket 写关闭消息
	// （每次写带 10s WriteDeadline）与 DisDBSess 的数据库事务。管理员批量断开 N 个
	// 会话时，N 次关闭全部串行排队，任一慢写会让整体卡住 10s。
	//
	// 摘取与移除仍是原子的：并发的第二个调用者会拿到 nil 且条目已被移除，
	// 行为与原实现一致（两者最终都会执行 DisDBSess）。
	mutex.Lock()
	nextSession := session.GlobalSessionManager.GetById(sessionId)
	session.GlobalSessionManager.Del(sessionId)
	mutex.Unlock()

	if nextSession != nil {
		log.Debug("会话关闭", log.String("会话ID", sessionId), log.String("原因", reason))
		service.WriteCloseMessage(nextSession, nextSession.Mode, code, reason)

		if nextSession.Observer != nil {
			nextSession.Observer.Range(func(key string, ob *session.Session) {
				service.WriteCloseMessage(ob, ob.Mode, code, reason)
				log.Debug("强制踢出会话的观察者", log.String("会话ID", sessionId))
			})
		}
	}

	service.DisDBSess(sessionId, code, reason)
}

// MarkDisconnected 标记会话连接已断开（不关闭隧道，保留重连可能）
func (service sessionService) MarkDisconnected(sessionId string) {
	log.Warn("会话标记为断开状态，保留隧道可重连", log.String("sessionId", sessionId))
	session.GlobalSessionManager.Del(sessionId)
	service.DisDBSess(sessionId, 0, "连接断开")
}

func (service sessionService) WriteCloseMessage(sess *session.Session, mode string, code int, reason string) {
	switch mode {
	case nt.Guacd:
		err := guacamole.NewInstruction("error", "", strconv.Itoa(code))
		_ = sess.WriteString(err.String())
		disconnect := guacamole.NewInstruction("disconnect")
		_ = sess.WriteString(disconnect.String())
	case nt.Native, nt.Terminal:
		msg := `0` + reason
		_ = sess.WriteString(msg)
	}
}

func (service sessionService) DisDBSess(sessionId string, code int, reason string) {
	_ = env.GetDB().Transaction(func(tx *gorm.DB) error {
		c := service.Context(tx)
		s, err := repository.SessionRepository.FindById(c, sessionId)
		if err != nil {
			return err
		}

		if s.Status == nt.Disconnected {
			return nil
		}

		if s.Status == nt.Connecting {
			// 会话还未建立成功，无需保留数据
			if err := repository.SessionRepository.DeleteById(c, sessionId); err != nil {
				return err
			}
			return nil
		}

		ss := model.Session{}
		ss.ID = sessionId
		ss.Status = nt.Disconnected
		ss.DisconnectedTime = common.NowJsonTime()
		ss.Code = code
		ss.Message = reason
		ss.Password = "-"
		ss.PrivateKey = "-"
		ss.Passphrase = "-"

		if err := repository.SessionRepository.UpdateById(c, &ss, sessionId); err != nil {
			return err
		}

		return nil
	})
}

func (service sessionService) FindByIdAndDecrypt(c context.Context, id string) (o model.Session, err error) {
	sess, err := repository.SessionRepository.FindById(c, id)
	if err != nil {
		return o, err
	}
	if err := service.Decrypt(&sess); err != nil {
		return o, err
	}
	return sess, nil
}

func (service sessionService) Decrypt(item *model.Session) error {
	if item.Password != "" && item.Password != "-" {
		origData, err := base64.StdEncoding.DecodeString(item.Password)
		if err != nil {
			return err
		}
		decryptedCBC, err := utils.AesDecryptCBC(origData, config.GlobalCfg.EncryptionPassword)
		if err != nil {
			return err
		}
		item.Password = string(decryptedCBC)
	}
	if item.PrivateKey != "" && item.PrivateKey != "-" {
		origData, err := base64.StdEncoding.DecodeString(item.PrivateKey)
		if err != nil {
			return err
		}
		decryptedCBC, err := utils.AesDecryptCBC(origData, config.GlobalCfg.EncryptionPassword)
		if err != nil {
			return err
		}
		item.PrivateKey = string(decryptedCBC)
	}
	if item.Passphrase != "" && item.Passphrase != "-" {
		origData, err := base64.StdEncoding.DecodeString(item.Passphrase)
		if err != nil {
			return err
		}
		decryptedCBC, err := utils.AesDecryptCBC(origData, config.GlobalCfg.EncryptionPassword)
		if err != nil {
			return err
		}
		item.Passphrase = string(decryptedCBC)
	}
	return nil
}

func (service sessionService) renderBoolToStr(b *bool) string {
	if *(b) == true {
		return "1"
	}
	return "0"
}

func (service sessionService) Create(clientIp, assetId, mode string, user *model.User) (*model.Session, error) {
	asset, err := repository.AssetRepository.FindById(context.TODO(), assetId)
	if err != nil {
		return nil, err
	}

	var (
		upload     = "1"
		download   = "1"
		_delete    = "1"
		rename     = "1"
		edit       = "1"
		fileSystem = "1"
		_copy      = "1"
		paste      = "1"
	)

	if asset.Owner != user.ID && nt.TypeUser == user.Type {
		// 普通用户访问非自己创建的资产需要校验权限
		authorised, err := AuthorisedService.GetAuthorised(user.ID, assetId)
		if err != nil {
			return nil, err
		}

		if authorised == nil || authorised.ID == "" {
			return nil, errors.New("您没有权限访问此资产")
		}
		strategyId := authorised.StrategyId
		if strategyId != "" {
			strategy, err := repository.StrategyRepository.FindById(context.TODO(), strategyId)
			if err != nil {
				if !errors.Is(err, gorm.ErrRecordNotFound) {
					return nil, err
				}
			} else {
				upload = service.renderBoolToStr(strategy.Upload)
				download = service.renderBoolToStr(strategy.Download)
				_delete = service.renderBoolToStr(strategy.Delete)
				rename = service.renderBoolToStr(strategy.Rename)
				edit = service.renderBoolToStr(strategy.Edit)
				_copy = service.renderBoolToStr(strategy.Copy)
				paste = service.renderBoolToStr(strategy.Paste)
			}
		}
	}

	var storageId = ""
	if nt.RDP == asset.Protocol {
		attr, err := repository.AssetRepository.FindAssetAttrMapByAssetId(context.TODO(), assetId)
		if err != nil {
			return nil, err
		}
		if "true" == attr[guacamole.EnableDrive] {
			fileSystem = "1"
			storageId = attr[guacamole.DrivePath]
			if storageId == "" {
				storageId = user.ID
			}
		} else {
			fileSystem = "0"
		}
	}
	if fileSystem != "1" {
		fileSystem = "0"
	}
	if upload != "1" {
		upload = "0"
	}
	if download != "1" {
		download = "0"
	}
	if _delete != "1" {
		_delete = "0"
	}
	if rename != "1" {
		rename = "0"
	}
	if edit != "1" {
		edit = "0"
	}
	if _copy != "1" {
		_copy = "0"
	}
	if paste != "1" {
		paste = "0"
	}

	s := &model.Session{
		ID:              utils.UUID(),
		AssetId:         asset.ID,
		Username:        asset.Username,
		Password:        asset.Password,
		PrivateKey:      asset.PrivateKey,
		Passphrase:      asset.Passphrase,
		Protocol:        asset.Protocol,
		IP:              asset.IP,
		Port:            asset.Port,
		Status:          nt.NoConnect,
		ClientIP:        clientIp,
		Mode:            mode,
		FileSystem:      fileSystem,
		Upload:          upload,
		Download:        download,
		Delete:          _delete,
		Rename:          rename,
		Edit:            edit,
		Copy:            _copy,
		Paste:           paste,
		StorageId:       storageId,
		AccessGatewayId: asset.AccessGatewayId,
		Reviewed:        false,
	}
	if nt.Anonymous != user.Type {
		s.Creator = user.ID
	}

	if asset.AccountType == "credential" {
		credential, err := repository.CredentialRepository.FindById(context.TODO(), asset.CredentialId)
		if err != nil {
			return nil, err
		}

		if credential.Type == nt.Custom {
			s.Username = credential.Username
			s.Password = credential.Password
		} else {
			s.Username = credential.Username
			s.PrivateKey = credential.PrivateKey
			s.Passphrase = credential.Passphrase
		}
	}

	if err := repository.SessionRepository.Create(context.TODO(), s); err != nil {
		return nil, err
	}
	if err := repository.AssetRepository.UpdateLastAccessTime(context.Background(), s.AssetId, common.NowJsonTime()); err != nil {
		return nil, err
	}
	return s, nil
}

func (service sessionService) FixSshMode() error {
	return repository.SessionRepository.UpdateMode(context.TODO())
}
