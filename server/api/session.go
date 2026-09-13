package api

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"next-terminal/server/common"
	"next-terminal/server/common/maps"
	"next-terminal/server/common/nt"
	"next-terminal/server/common/term"
	"next-terminal/server/global/session"
	"next-terminal/server/log"
	"next-terminal/server/model"
	"next-terminal/server/repository"
	"next-terminal/server/service"
	"next-terminal/server/utils"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"

	"github.com/labstack/echo/v4"
)

type SessionApi struct{}

// recordingCache 断开会话的录屏存在性缓存：断开后录屏状态不再变化，
// 避免会话列表每页每条记录一次磁盘 stat（sessionId → exists）
var recordingCache sync.Map

func (api SessionApi) SessionPagingEndpoint(c echo.Context) error {
	pageIndex, _ := strconv.Atoi(c.QueryParam("pageIndex"))
	pageSize, _ := strconv.Atoi(c.QueryParam("pageSize"))
	status := c.QueryParam("status")
	userId := c.QueryParam("userId")
	clientIp := c.QueryParam("clientIp")
	assetId := c.QueryParam("assetId")
	protocol := c.QueryParam("protocol")
	reviewed := c.QueryParam("reviewed")

	items, total, err := repository.SessionRepository.Find(context.TODO(), pageIndex, pageSize, status, userId, clientIp, assetId, protocol, reviewed)

	if err != nil {
		return err
	}

	for i := 0; i < len(items); i++ {
		if status == nt.Disconnected && len(items[i].Recording) > 0 {

			var recording string
			if items[i].Mode == nt.Native || items[i].Mode == nt.Terminal {
				recording = items[i].Recording
			} else {
				recording = items[i].Recording + "/recording"
			}

			// 录屏存在性缓存：断开会话录屏状态不变，命中缓存跳过磁盘 stat
			if v, ok := recordingCache.Load(items[i].ID); ok {
				if v.(bool) {
					items[i].Recording = "1"
				} else {
					items[i].Recording = "0"
				}
			} else {
				exists := utils.FileExists(recording)
				recordingCache.Store(items[i].ID, exists)
				if exists {
					items[i].Recording = "1"
				} else {
					items[i].Recording = "0"
				}
			}
		} else {
			items[i].Recording = "0"
		}
	}

	return Success(c, maps.Map{
		"total": total,
		"items": items,
	})
}

func (api SessionApi) SessionDeleteEndpoint(c echo.Context) error {
	sessionIds := strings.Split(c.Param("id"), ",")
	err := service.SessionService.DeleteByIds(context.TODO(), sessionIds)
	if err != nil {
		return err
	}

	return Success(c, nil)
}

func (api SessionApi) SessionClearEndpoint(c echo.Context) error {
	err := service.SessionService.ClearOfflineSession()
	if err != nil {
		return err
	}
	return Success(c, nil)
}

func (api SessionApi) SessionReviewedEndpoint(c echo.Context) error {
	sessionIds := strings.Split(c.Param("id"), ",")
	if err := repository.SessionRepository.UpdateReadByIds(context.TODO(), true, sessionIds); err != nil {
		return err
	}
	return Success(c, nil)
}

func (api SessionApi) SessionUnViewedEndpoint(c echo.Context) error {
	sessionIds := strings.Split(c.Param("id"), ",")
	if err := repository.SessionRepository.UpdateReadByIds(context.TODO(), false, sessionIds); err != nil {
		return err
	}
	return Success(c, nil)
}

func (api SessionApi) SessionReviewedAllEndpoint(c echo.Context) error {
	if err := service.SessionService.ReviewedAll(); err != nil {
		return err
	}
	return Success(c, nil)
}

func (api SessionApi) SessionConnectEndpoint(c echo.Context) error {
	sessionId := c.Param("id")

	s := model.Session{}
	s.ID = sessionId
	s.Status = nt.Connected
	s.ConnectedTime = common.NowJsonTime()

	if err := repository.SessionRepository.UpdateById(context.TODO(), &s, sessionId); err != nil {
		return err
	}

	o, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	asset, err := repository.AssetRepository.FindById(context.TODO(), o.AssetId)
	if err != nil {
		return err
	}
	if !asset.Active {
		asset.Active = true
		_ = repository.AssetRepository.UpdateById(context.TODO(), &asset, asset.ID)
	}

	return Success(c, nil)
}

func (api SessionApi) SessionDisconnectEndpoint(c echo.Context) error {
	sessionIds := c.Param("id")

	split := strings.Split(sessionIds, ",")
	for i := range split {
		// 会话保持（tmux）分层语义：管理员强断 = 真正终止远端任务。
		// 连接还活着时先发 kill-session（关闭链随后才断开 SSH）；连接已死
		// （宽限期内的 Detached 会话）时无法执行，由后续 TTL 清理任务兜底。
		if s := session.GlobalSessionManager.GetById(split[i]); s != nil &&
			s.NextTerminal != nil && s.NextTerminal.Keep {
			// 独立 channel 执行（不能复用主数据会话——它已 Start，Run 会报 session already started）
			if err := term.KillTmux(s.NextTerminal.SshClient, split[i]); err != nil {
				log.Warn("强断时终止 tmux 会话失败", log.String("sessionId", split[i]), log.NamedError("err", err))
			}
		}
		service.SessionService.CloseSessionById(split[i], ForcedDisconnect, "管理员强制关闭了此会话")
	}
	return Success(c, nil)
}

// SessionCleanupKeepAliveEndpoint 手动清理已断开的 keep-alive 会话：
// 用资产凭证 SSH 上去 kill tmux，然后删除会话记录。
// 不等 24h TTL，用户主动回收。
func (api SessionApi) SessionCleanupKeepAliveEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	err := service.SessionService.CleanupKeepAliveSession(sessionId)
	if err != nil {
		return err
	}
	return Success(c, nil)
}

func (api SessionApi) SessionResizeEndpoint(c echo.Context) error {
	width := c.QueryParam("width")
	height := c.QueryParam("height")
	sessionId := c.Param("id")

	if len(width) == 0 || len(height) == 0 {
		return errors.New("参数异常")
	}

	intWidth, _ := strconv.Atoi(width)
	intHeight, _ := strconv.Atoi(height)

	if err := repository.SessionRepository.UpdateWindowSizeById(context.TODO(), intWidth, intHeight, sessionId); err != nil {
		return err
	}
	return Success(c, "")
}

func (api SessionApi) SessionCreateEndpoint(c echo.Context) error {
	assetId := c.QueryParam("assetId")
	mode := c.QueryParam("mode")

	if mode == nt.Native {
		mode = nt.Native
	} else {
		mode = nt.Guacd
	}

	user, _ := GetCurrentAccount(c)

	s, err := service.SessionService.Create(c.RealIP(), assetId, mode, user)
	if err != nil {
		return err
	}

	return Success(c, echo.Map{
		"id":         s.ID,
		"upload":     s.Upload,
		"download":   s.Download,
		"delete":     s.Delete,
		"rename":     s.Rename,
		"edit":       s.Edit,
		"storageId":  s.StorageId,
		"fileSystem": s.FileSystem,
		"copy":       s.Copy,
		"paste":      s.Paste,
		// 断线重连令牌：HMAC(sessionId)，会话存活期有效（前端存 sessionStorage，跨刷新可用）
		"reconnectToken": session.ReconnectToken(s.ID),
	})
}

// checkSessionOwner 校验调用者是否有权操作该会话的文件系统。
//
// 为什么必须在这里做：middleware/auth.go 的 allowUrls 已把这些会话文件端点从
// RBAC 菜单权限中显式放行（它们不在任何菜单下，靠会话归属自身定权），
// 因此 handler 内的归属判定是唯一防线。
//
// 判定基准是「调用者」而非「会话创建时的策略位」——端点内已有的
// `s.Download != "1"` 之类的检查只说明「该会话被允许下载」，不代表
// 「当前调用者有权操作这个会话」，两者是不同维度，缺一不可。
func checkSessionOwner(c echo.Context, s model.Session) error {
	user, found := GetCurrentAccount(c)
	if !found || user == nil {
		return Fail(c, -1, "您的登录信息已失效，请重新登录后再试。")
	}
	if user.Type != nt.TypeAdmin && user.ID != s.Creator {
		return Fail(c, -1, "无权限访问此会话")
	}
	return nil
}

// hasParentDirSegment 判断路径中是否包含 ".." 层级（路径穿越）
// 按 "/" 分段精确匹配，避免误伤含连续点号的正常文件名（如 a..b.txt）
func hasParentDirSegment(p string) bool {
	for _, segment := range strings.Split(p, "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}

func (api SessionApi) SessionUploadEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	// 会话归属校验：非管理员仅可操作本人创建的会话（附带执行目标机文件操作，防越权）
	if err := checkSessionOwner(c, s); err != nil {
		return err
	}
	if s.Upload != "1" {
		return errors.New("禁止操作")
	}

	file, err := c.FormFile("file")
	if err != nil {
		return err
	}

	filename := file.Filename
	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()

	remoteDir := c.QueryParam("dir")
	remoteFile := path.Join(remoteDir, filename)

	// 记录日志
	account, _ := GetCurrentAccount(c)
	_ = service.StorageLogService.Save(context.Background(), s.AssetId, sessionId, account.ID, nt.StorageLogActionUpload, remoteFile)

	if "ssh" == s.Protocol {
		nextSession := session.GlobalSessionManager.GetById(sessionId)
		if nextSession == nil {
			return errors.New("获取会话失败")
		}

		// 走 GetSftpClient：直接读字段会绕过懒初始化锁，可能拿到未初始化的 nil
		sftpClient, err := nextSession.NextTerminal.GetSftpClient()
		if err != nil {
			return err
		}

		// 路径安全校验：拒绝 ".." 上级目录引用，防止越出会话工作目录写入文件
		// dir 取自 URL 查询参数，Echo 的 QueryParam 已完成 URL 解码（%2e%2e 同样还原为 ..），此处按解码后的值判断即可
		// 注：绝对路径不拦截——会话文件管理器以 / 为起点浏览并上传到当前绝对目录，属既有合法用法，
		// 其可写范围由 SFTP 登录账号自身的系统权限约束
		if hasParentDirSegment(remoteDir) || hasParentDirSegment(remoteFile) {
			log.Warn("上传路径非法：包含上级目录引用", log.String("sessionId", sessionId), log.String("dir", remoteDir), log.String("file", remoteFile))
			return errors.New("非法请求：路径中禁止包含 ..")
		}

		// 文件夹不存在时自动创建文件夹
		if _, err := sftpClient.Stat(remoteDir); os.IsNotExist(err) {
			if err := sftpClient.MkdirAll(remoteDir); err != nil {
				return err
			}
		}

		dstFile, err := sftpClient.Create(remoteFile)
		if err != nil {
			return err
		}
		defer dstFile.Close()

		counter := &WriteCounter{Resp: c.Response()}

		c.Response().Header().Set(echo.HeaderContentType, `text/event-stream`)
		c.Response().WriteHeader(http.StatusOK)

		srcReader := io.TeeReader(src, counter)
		if _, err = io.Copy(dstFile, srcReader); err != nil {
			return err
		}
		return Success(c, nil)
	} else if "rdp" == s.Protocol {
		if err := service.StorageService.StorageUpload(c, file, s.StorageId); err != nil {
			return err
		}
		return Success(c, nil)
	}

	return errors.New("当前协议不支持此操作")
}

func (api SessionApi) SessionEditEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	// 会话归属校验：非管理员仅可操作本人创建的会话（附带执行目标机文件操作，防越权）
	if err := checkSessionOwner(c, s); err != nil {
		return err
	}
	if s.Edit != "1" {
		return errors.New("禁止操作")
	}
	file := c.FormValue("file")
	fileContent := c.FormValue("fileContent")

	if "ssh" == s.Protocol {
		nextSession := session.GlobalSessionManager.GetById(sessionId)
		if nextSession == nil {
			return errors.New("获取会话失败")
		}

		// 走 GetSftpClient：直接读字段会绕过懒初始化锁，可能拿到未初始化的 nil
		sftpClient, err := nextSession.NextTerminal.GetSftpClient()
		if err != nil {
			return err
		}
		dstFile, err := sftpClient.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
		if err != nil {
			return err
		}
		defer dstFile.Close()
		write := bufio.NewWriter(dstFile)
		// replace \r\n to \n
		if _, err := write.WriteString(strings.Replace(fileContent, "\r\n", "\n", -1)); err != nil {
			return err
		}
		// fix neoel
		if !strings.HasSuffix(fileContent, "\n") {
			if _, err := write.WriteString("\n"); err != nil {
				return err
			}
		}
		if err := write.Flush(); err != nil {
			return err
		}
		return Success(c, nil)
	} else if "rdp" == s.Protocol {
		if err := service.StorageService.StorageEdit(file, fileContent, s.StorageId); err != nil {
			return err
		}
		return Success(c, nil)
	}
	return errors.New("当前协议不支持此操作")
}

func (api SessionApi) SessionDownloadEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	// 会话归属校验：非管理员仅可操作本人创建的会话（附带执行目标机文件操作，防越权）
	if err := checkSessionOwner(c, s); err != nil {
		return err
	}
	if s.Download != "1" {
		return errors.New("禁止操作")
	}
	file := c.QueryParam("file")

	// 记录日志
	account, _ := GetCurrentAccount(c)
	_ = service.StorageLogService.Save(context.Background(), s.AssetId, sessionId, account.ID, nt.StorageLogActionDownload, file)

	// 获取带后缀的文件名称
	filenameWithSuffix := path.Base(file)
	if "ssh" == s.Protocol {
		nextSession := session.GlobalSessionManager.GetById(sessionId)
		if nextSession == nil {
			return errors.New("获取会话失败")
		}

		sftpClient, err := nextSession.NextTerminal.GetSftpClient()
		if err != nil {
			return err
		}
		dstFile, err := sftpClient.Open(file)
		if err != nil {
			log.Warn("文件预览 SFTP 打开失败", log.String("sessionId", sessionId), log.String("file", file), log.NamedError("err", err))
			return err
		}

		defer dstFile.Close()
		c.Response().Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filenameWithSuffix))
		c.Response().Header().Set("Content-Type", echo.MIMEOctetStream)
		c.Response().WriteHeader(http.StatusOK)

		_, err = io.Copy(c.Response().Writer, dstFile)
		return err
	} else if "rdp" == s.Protocol {
		storageId := s.StorageId
		return service.StorageService.StorageDownload(c, file, storageId)
	}

	return errors.New("当前协议不支持此操作")
}

func (api SessionApi) SessionPreviewEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	// 会话归属校验：非管理员仅可操作本人创建的会话（附带执行目标机文件操作，防越权）
	if err := checkSessionOwner(c, s); err != nil {
		return err
	}
	if s.Download != "1" {
		return errors.New("禁止操作")
	}
	file := c.QueryParam("file")

	filenameWithSuffix := path.Base(file)
	contentType := echo.MIMEOctetStream
	switch strings.ToLower(path.Ext(file)) {
	case ".png":
		contentType = "image/png"
	case ".jpg", ".jpeg":
		contentType = "image/jpeg"
	case ".gif":
		contentType = "image/gif"
	case ".webp":
		contentType = "image/webp"
	case ".svg":
		contentType = "image/svg+xml"
	case ".bmp":
		contentType = "image/bmp"
	case ".pdf":
		contentType = "application/pdf"
	case ".md":
		contentType = "text/plain; charset=utf-8"
	case ".html":
		contentType = "text/html; charset=utf-8"
	}

	if "ssh" == s.Protocol {
		nextSession := session.GlobalSessionManager.GetById(sessionId)
		if nextSession == nil {
			return errors.New("获取会话失败")
		}
		sftpClient, err := nextSession.NextTerminal.GetSftpClient()
		if err != nil {
			return err
		}
		// 相对路径解析：通过 SFTP RealPath 获取实际工作目录
		if !strings.HasPrefix(file, "/") {
			if homeDir, err := sftpClient.RealPath("."); err == nil {
				file = path.Join(homeDir, file)
			}
		}
		dstFile, err := sftpClient.Open(file)
		if err != nil {
			log.Warn("文件预览 SFTP 打开失败", log.String("sessionId", sessionId), log.String("file", file), log.NamedError("err", err))
			return err
		}
		defer dstFile.Close()
		c.Response().Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%s", filenameWithSuffix))
		c.Response().Header().Set("Content-Type", contentType)
		c.Response().WriteHeader(http.StatusOK)
		_, err = io.Copy(c.Response().Writer, dstFile)
		return err
	} else if "rdp" == s.Protocol {
		return service.StorageService.StorageDownload(c, file, s.StorageId)
	}
	return errors.New("当前协议不支持此操作")
}

func (api SessionApi) SessionLsEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := service.SessionService.FindByIdAndDecrypt(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	// 会话归属校验：非管理员仅可列出本人会话的目标机目录（防越权探测）
	if err := checkSessionOwner(c, s); err != nil {
		return err
	}

	// partial（新版浮动选择器）：用户打字的中间输入，需分离目录+前缀，如 "ops/di" → dir="ops/", prefix="di"
	// dir（旧版 FileSystem）：直接指定目录路径，不做拆分
	partial := c.FormValue("partial")
	legacyDir := c.FormValue("dir")
	namePrefix := ""
	remoteDir := "."

	if partial != "" {
		// 新版选择器语义：拆分为目录 + 文件名前缀
		if strings.HasSuffix(partial, "/") {
			remoteDir = partial
		} else {
			lastSlash := strings.LastIndex(partial, "/")
			if lastSlash >= 0 {
				remoteDir = partial[:lastSlash+1]
				namePrefix = partial[lastSlash+1:]
			} else if strings.HasPrefix(partial, "/") {
				remoteDir = partial
			} else {
				namePrefix = partial
			}
		}
	} else if legacyDir != "" {
		// 旧版 FileSystem 语义：直接列出目录
		remoteDir = legacyDir
	}
	if "ssh" == s.Protocol {
		nextSession := session.GlobalSessionManager.GetById(sessionId)
		if nextSession == nil {
			return errors.New("获取会话失败")
		}

		sftpClient, err := nextSession.NextTerminal.GetSftpClient()
		if err != nil {
			return err
		}

		// 相对路径解析：通过 SFTP RealPath 获取实际工作目录
		if !strings.HasPrefix(remoteDir, "/") {
			if homeDir, err := sftpClient.RealPath("."); err == nil {
				remoteDir = path.Join(homeDir, remoteDir)
			}
		}

		fileInfos, err := sftpClient.ReadDir(remoteDir)
		if err != nil {
			log.Warn("目录列表 SFTP 读取失败", log.String("sessionId", sessionId), log.String("dir", remoteDir), log.NamedError("err", err))
			return err
		}

		var files = make([]service.File, 0)
		for i := range fileInfos {
			if namePrefix != "" && !strings.HasPrefix(fileInfos[i].Name(), namePrefix) {
				continue
			}

			file := service.File{
				Name:    fileInfos[i].Name(),
				Path:    path.Join(remoteDir, fileInfos[i].Name()),
				IsDir:   fileInfos[i].IsDir(),
				Mode:    fileInfos[i].Mode().String(),
				IsLink:  fileInfos[i].Mode()&os.ModeSymlink == os.ModeSymlink,
				ModTime: common.NewJsonTime(fileInfos[i].ModTime()),
				Size:    fileInfos[i].Size(),
			}

			files = append(files, file)
		}

		return Success(c, files)
	} else if "rdp" == s.Protocol {
		storageId := s.StorageId
		err, files := service.StorageService.StorageLs(remoteDir, storageId)
		if err != nil {
			return err
		}
		return Success(c, files)
	}

	return errors.New("当前协议不支持此操作")
}

func (api SessionApi) SessionMkDirEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	// 会话归属校验：非管理员仅可操作本人创建的会话（附带执行目标机文件操作，防越权）
	if err := checkSessionOwner(c, s); err != nil {
		return err
	}
	if s.Upload != "1" {
		return errors.New("禁止操作")
	}
	remoteDir := c.QueryParam("dir")

	// 记录日志
	account, _ := GetCurrentAccount(c)
	_ = service.StorageLogService.Save(context.Background(), s.AssetId, sessionId, account.ID, nt.StorageLogActionMkdir, remoteDir)

	if "ssh" == s.Protocol {
		nextSession := session.GlobalSessionManager.GetById(sessionId)
		if nextSession == nil {
			return errors.New("获取会话失败")
		}
		sftpClient, err := nextSession.NextTerminal.GetSftpClient()
		if err != nil {
			return err
		}
		if err := sftpClient.Mkdir(remoteDir); err != nil {
			return err
		}
		return Success(c, nil)
	} else if "rdp" == s.Protocol {
		storageId := s.StorageId
		if err := service.StorageService.StorageMkDir(remoteDir, storageId); err != nil {
			return err
		}
		return Success(c, nil)
	}
	return errors.New("当前协议不支持此操作")
}

func (api SessionApi) SessionRmEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	// 会话归属校验：非管理员仅可操作本人创建的会话（附带执行目标机文件操作，防越权）
	if err := checkSessionOwner(c, s); err != nil {
		return err
	}
	if s.Delete != "1" {
		return errors.New("禁止操作")
	}
	// 文件夹或者文件
	file := c.FormValue("file")

	// 记录日志
	account, _ := GetCurrentAccount(c)
	_ = service.StorageLogService.Save(context.Background(), s.AssetId, sessionId, account.ID, nt.StorageLogActionRm, file)

	if "ssh" == s.Protocol {
		nextSession := session.GlobalSessionManager.GetById(sessionId)
		if nextSession == nil {
			return errors.New("获取会话失败")
		}

		// 走 GetSftpClient：直接读字段会绕过懒初始化锁，可能拿到未初始化的 nil
		sftpClient, err := nextSession.NextTerminal.GetSftpClient()
		if err != nil {
			return err
		}

		stat, err := sftpClient.Stat(file)
		if err != nil {
			return err
		}

		if stat.IsDir() {
			fileInfos, err := sftpClient.ReadDir(file)
			if err != nil {
				return err
			}

			for i := range fileInfos {
				if err := sftpClient.Remove(path.Join(file, fileInfos[i].Name())); err != nil {
					return err
				}
			}

			if err := sftpClient.RemoveDirectory(file); err != nil {
				return err
			}
		} else {
			if err := sftpClient.Remove(file); err != nil {
				return err
			}
		}

		return Success(c, nil)
	} else if "rdp" == s.Protocol {
		storageId := s.StorageId
		if err := service.StorageService.StorageRm(file, storageId); err != nil {
			return err
		}
		return Success(c, nil)
	}

	return errors.New("当前协议不支持此操作")
}

func (api SessionApi) SessionRenameEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	// 会话归属校验：非管理员仅可操作本人创建的会话（附带执行目标机文件操作，防越权）
	if err := checkSessionOwner(c, s); err != nil {
		return err
	}
	if s.Rename != "1" {
		return errors.New("禁止操作")
	}
	oldName := c.QueryParam("oldName")
	newName := c.QueryParam("newName")

	// 记录日志
	account, _ := GetCurrentAccount(c)
	_ = service.StorageLogService.Save(context.Background(), s.AssetId, sessionId, account.ID, nt.StorageLogActionRename, oldName)

	if "ssh" == s.Protocol {
		nextSession := session.GlobalSessionManager.GetById(sessionId)
		if nextSession == nil {
			return errors.New("获取会话失败")
		}

		// 走 GetSftpClient：直接读字段会绕过懒初始化锁，可能拿到未初始化的 nil
		sftpClient, err := nextSession.NextTerminal.GetSftpClient()
		if err != nil {
			return err
		}

		if err := sftpClient.Rename(oldName, newName); err != nil {
			return err
		}

		return Success(c, nil)
	} else if "rdp" == s.Protocol {
		storageId := s.StorageId
		if err := service.StorageService.StorageRename(oldName, newName, storageId); err != nil {
			return err
		}
		return Success(c, nil)
	}
	return errors.New("当前协议不支持此操作")
}

func (api SessionApi) SessionRecordingEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}

	var recording string
	if s.Mode == nt.Native || s.Mode == nt.Terminal {
		recording = s.Recording
	} else {
		recording = s.Recording + "/recording"
	}
	_ = repository.SessionRepository.UpdateReadByIds(context.TODO(), true, []string{sessionId})

	http.ServeFile(c.Response(), c.Request(), recording)
	return nil
}

func (api SessionApi) SessionGetEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(context.TODO(), sessionId)
	if err != nil {
		return err
	}
	return Success(c, s)
}

func (api SessionApi) SessionStatsEndpoint(c echo.Context) error {
	sessionId := c.Param("id")
	s, err := service.SessionService.FindByIdAndDecrypt(context.TODO(), sessionId)
	if err != nil {
		return err
	}

	// 会话归属校验：非管理员仅可拉取本人会话的远端主机统计（附带执行 SSH 命令，防越权）
	user, _ := GetCurrentAccount(c)
	if user != nil && user.Type != nt.TypeAdmin && user.ID != s.Creator {
		return Fail(c, -1, "无权限访问此会话")
	}

	if "ssh" != s.Protocol {
		return Fail(c, -1, "不支持当前协议")
	}

	nextSession := session.GlobalSessionManager.GetById(sessionId)
	if nextSession == nil {
		return errors.New("获取会话失败")
	}

	stats, err := GetAllStats(nextSession)
	if err != nil {
		return err
	}
	return Success(c, stats)
}
