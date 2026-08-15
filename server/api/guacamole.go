package api

import (
	"context"
	"fmt"
	"net/http"
	"next-terminal/server/common/guacamole"
	"next-terminal/server/common/nt"
	"path"
	"strconv"
	"strings"
	"time"

	"next-terminal/server/config"
	"next-terminal/server/global/session"
	"next-terminal/server/log"
	"next-terminal/server/model"
	"next-terminal/server/repository"
	"next-terminal/server/service"
	"next-terminal/server/utils"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
)

const (
	TunnelClosed             int = -1
	Normal                   int = 0
	NotFoundSession          int = 800
	NewTunnelError           int = 801
	ForcedDisconnect         int = 802
	AccessGatewayUnAvailable int = 803
	AccessGatewayCreateError int = 804
	AssetNotActive           int = 805
	NewSshClientError        int = 806
)

var UpGrader = websocket.Upgrader{
	ReadBufferSize:  32768,
	WriteBufferSize: 32768,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // 同源请求无 Origin 头
		}
		corsOrigins := config.GlobalCfg.Server.CorsOrigins
		if len(corsOrigins) == 0 {
			// 未配置 CORS 时，仅允许同源
			host := r.Host
			return strings.HasPrefix(origin, "http://"+host) || strings.HasPrefix(origin, "https://"+host)
		}
		for _, allowed := range corsOrigins {
			if allowed == "*" || allowed == origin {
				return true
			}
		}
		return false
	},
	Subprotocols: []string{"guacamole"},
}

type GuacamoleApi struct {
}

func (api GuacamoleApi) Guacamole(c echo.Context) error {
	ws, err := UpGrader.Upgrade(c.Response().Writer, c.Request(), nil)
	if err != nil {
		log.Warn("升级为WebSocket协议失败", log.NamedError("err", err))
		return err
	}
	ctx := context.TODO()
	width := c.QueryParam("width")
	height := c.QueryParam("height")
	dpi := c.QueryParam("dpi")
	sessionId := c.Param("id")

	// 断线重连：会话仍在内存（宽限期内或在线）时只允许挂接，不允许重复新建（防覆盖泄漏）
	if reconnectSession := session.GlobalSessionManager.GetById(sessionId); reconnectSession != nil {
		// 归属校验：非管理员仅可重连本人会话
		s, err := repository.SessionRepository.FindById(ctx, sessionId)
		if err != nil {
			guacamole.Disconnect(ws, NotFoundSession, "获取会话失败")
			return nil
		}
		user, _ := GetCurrentAccount(c)
		if user != nil && user.Type != nt.TypeAdmin && user.ID != s.Creator {
			guacamole.Disconnect(ws, ForcedDisconnect, "无权限访问此会话")
			return nil
		}

		if reconnectSession.TryReattach(c.QueryParam("reconnectToken"), ws) {
			// 协议类型守卫：SSH 会话的 GuacdTunnel 为 nil，错误端点+有效令牌会导致空指针
			if reconnectSession.GuacdTunnel == nil {
				guacamole.Disconnect(ws, ForcedDisconnect, "会话类型不匹配")
				return nil
			}
			log.Info("Guacamole 会话重连成功", log.String("sessionId", sessionId))
			// 输入循环：浏览器 → 既有 guacd 隧道（旧 handler 经 Session 写路径自动向新 ws 转发，
			// 此处不新建 handler——双读者会撕裂隧道帧）
			for {
				_, message, err := ws.ReadMessage()
				if err != nil {
					log.Warn("RDP 重连 WebSocket 读取失败，再次进入宽限期", log.String("sessionId", sessionId), log.NamedError("err", err))
					reconnectSession.Detach(func() {
						service.SessionService.CloseSessionById(sessionId, TunnelClosed, "断线重连超时")
					})
					return nil
				}
				reconnectSession.UpdateLastActive()
				_, err = reconnectSession.GuacdTunnel.WriteAndFlush(message)
				if err != nil {
					service.SessionService.CloseSessionById(sessionId, TunnelClosed, "远程连接已关闭")
					return nil
				}
			}
		}
		guacamole.Disconnect(ws, ForcedDisconnect, "会话已存在且重连令牌无效")
		return nil
	}

	intWidth, _ := strconv.Atoi(width)
	intHeight, _ := strconv.Atoi(height)

	configuration := guacamole.NewConfiguration()

	propertyMap := repository.PropertyRepository.FindAllMap(ctx)

	configuration.SetParameter("width", width)
	configuration.SetParameter("height", height)
	configuration.SetParameter("dpi", dpi)
	s, err := service.SessionService.FindByIdAndDecrypt(ctx, sessionId)
	if err != nil {
		return err
	}

	// 会话归属校验：非管理员仅可访问本人会话（此前 Guacamole 主路径完全缺失该校验）
	user, _ := GetCurrentAccount(c)
	if user != nil && user.Type != nt.TypeAdmin && user.ID != s.Creator {
		guacamole.Disconnect(ws, ForcedDisconnect, "无权限访问此会话")
		return nil
	}

	api.setConfig(propertyMap, s, configuration)

	if s.AccessGatewayId != "" && s.AccessGatewayId != "-" {
		g, err := service.GatewayService.GetGatewayById(s.AccessGatewayId)
		if err != nil {
			guacamole.Disconnect(ws, AccessGatewayUnAvailable, "获取接入网关失败："+err.Error())
			return nil
		}

		defer g.CloseSshTunnel(s.ID)
		exposedIP, exposedPort, err := g.OpenSshTunnel(s.ID, s.IP, s.Port)
		if err != nil {
			guacamole.Disconnect(ws, AccessGatewayCreateError, "创建SSH隧道失败："+err.Error())
			return nil
		}
		s.IP = exposedIP
		s.Port = exposedPort
	}

	configuration.SetParameter("hostname", s.IP)
	configuration.SetParameter("port", strconv.Itoa(s.Port))

	// 加载资产配置的属性，优先级比全局配置的高，因此最后加载，覆盖掉全局配置
	attributes, err := repository.AssetRepository.FindAssetAttrMapByAssetId(ctx, s.AssetId)
	if err != nil {
		return err
	}
	if len(attributes) > 0 {
		api.setAssetConfig(attributes, s, configuration)
	}
	for name := range configuration.Parameters {
		// 替换数据库空格字符串占位符为真正的空格
		if configuration.Parameters[name] == "-" {
			configuration.Parameters[name] = ""
		}
	}

	addr := config.GlobalCfg.Guacd.Hostname + ":" + strconv.Itoa(config.GlobalCfg.Guacd.Port)
	asset := fmt.Sprintf("%s:%s", configuration.GetParameter("hostname"), configuration.GetParameter("port"))
	log.Debug("新建 guacd 会话", log.String("sessionId", sessionId), log.String("addr", addr), log.String("asset", asset))

	guacdTunnel, err := guacamole.NewTunnel(addr, configuration)
	if err != nil {
		guacamole.Disconnect(ws, NewTunnelError, err.Error())
		log.Error("建立连接失败", log.String("sessionId", sessionId), log.NamedError("err", err))
		return err
	}

	nextSession := &session.Session{
		ID:          sessionId,
		Protocol:    s.Protocol,
		Mode:        s.Mode,
		WebSocket:   ws,
		GuacdTunnel: guacdTunnel,
	}

	if configuration.Protocol == nt.SSH {
		nextTerminal, err := CreateNextTerminalBySession(s)
		if err != nil {
			guacamole.Disconnect(ws, NewSshClientError, "建立SSH客户端失败: "+err.Error())
			log.Debug("建立 ssh 客户端失败", log.String("sessionId", sessionId), log.NamedError("err", err))
			return err
		}
		nextSession.NextTerminal = nextTerminal
	}

	nextSession.Observer = session.NewObserver(sessionId)
	session.GlobalSessionManager.Add(nextSession)
	sess := model.Session{
		ConnectionId: guacdTunnel.UUID,
		Width:        intWidth,
		Height:       intHeight,
		Status:       nt.Connected,
		Recording:    configuration.GetParameter(guacamole.RecordingPath),
	}
	if sess.Recording == "" {
		// 未录屏时无需审计
		sess.Reviewed = true
	}
	// 创建新会话
	log.Debug("新建会话成功", log.String("sessionId", sessionId))
	if err := repository.SessionRepository.UpdateById(ctx, &sess, sessionId); err != nil {
		return err
	}

	guacamoleHandler := NewGuacamoleHandler(nextSession, guacdTunnel)
	guacamoleHandler.Start()
	defer guacamoleHandler.Stop()

	// guacd nop 保活：每 15s 发 nop 指令，防止 guacd 检测到 "User is not responding" 而断开
	// 会话级生命周期：宽限期内隧道需持续保活，Session.Close 时停止（原函数级 defer 不适用）
	startNopKeepalive(guacdTunnel, nextSession.ID, nextSession.EnsureNopDone())

	for {
		_, message, err := ws.ReadMessage()
		if err != nil {
			log.Warn("RDP Guacamole WebSocket 读取失败，进入宽限期等待重连", log.String("sessionId", sessionId), log.NamedError("err", err))
			// 不关闭隧道：保留底层连接等待重连，宽限期到由回调执行完整关闭链
			nextSession.Detach(func() {
				service.SessionService.CloseSessionById(sessionId, TunnelClosed, "断线重连超时")
			})
			return nil
		}
		nextSession.UpdateLastActive()
		_, err = guacdTunnel.WriteAndFlush(message)
		if err != nil {
			log.Warn("guacd 写入失败，关闭 RDP 会话", log.String("sessionId", sessionId), log.NamedError("err", err))
			service.SessionService.CloseSessionById(sessionId, TunnelClosed, "远程连接已关闭")
			return nil
		}
	}
}

func (api GuacamoleApi) setAssetConfig(attributes map[string]string, s model.Session, configuration *guacamole.Configuration) {
	for key, value := range attributes {
		if guacamole.DrivePath == key {
			// 忽略该参数
			continue
		}
		if guacamole.EnableDrive == key && value == "true" {
			storageId := attributes[guacamole.DrivePath]
			if storageId == "" || storageId == "-" {
				// 默认空间ID和用户ID相同
				storageId = s.Creator
			}
			realPath := path.Join(service.StorageService.GetBaseDrivePath(), storageId)
			configuration.SetParameter(guacamole.EnableDrive, "true")
			configuration.SetParameter(guacamole.DriveName, "Filesystem")
			configuration.SetParameter(guacamole.DrivePath, realPath)
		} else {
			configuration.SetParameter(key, value)
		}
	}
}

func (api GuacamoleApi) GuacamoleMonitor(c echo.Context) error {
	ws, err := UpGrader.Upgrade(c.Response().Writer, c.Request(), nil)
	if err != nil {
		log.Warn("升级为WebSocket协议失败", log.NamedError("err", err))
		return err
	}
	ctx := context.TODO()
	sessionId := c.Param("id")

	s, err := repository.SessionRepository.FindById(ctx, sessionId)
	if err != nil {
		return err
	}

	// 权限检查：仅允许会话创建者、管理员或被授权用户监控
	user, _ := GetCurrentAccount(c)
	if user != nil && user.Type != nt.TypeAdmin && user.ID != s.Creator {
		guacamole.Disconnect(ws, ForcedDisconnect, "无权限监控此会话")
		return nil
	}

	if err != nil {
		return err
	}
	if s.Status != nt.Connected {
		guacamole.Disconnect(ws, AssetNotActive, "会话离线")
		return nil
	}
	connectionId := s.ConnectionId
	configuration := guacamole.NewConfiguration()
	configuration.ConnectionID = connectionId
	sessionId = s.ID
	configuration.SetParameter("width", strconv.Itoa(s.Width))
	configuration.SetParameter("height", strconv.Itoa(s.Height))
	configuration.SetParameter("dpi", "96")
	configuration.SetReadOnlyMode()

	addr := config.GlobalCfg.Guacd.Hostname + ":" + strconv.Itoa(config.GlobalCfg.Guacd.Port)

	guacdTunnel, err := guacamole.NewTunnel(addr, configuration)
	if err != nil {
		guacamole.Disconnect(ws, NewTunnelError, err.Error())
		return err
	}

	nextSession := &session.Session{
		ID:          sessionId,
		Protocol:    s.Protocol,
		Mode:        s.Mode,
		WebSocket:   ws,
		GuacdTunnel: guacdTunnel,
	}

	// 要监控会话
	forObsSession := session.GlobalSessionManager.GetById(sessionId)
	if forObsSession == nil {
		guacamole.Disconnect(ws, NotFoundSession, "获取会话失败")
		return nil
	}
	nextSession.ID = utils.UUID()
	forObsSession.Observer.Add(nextSession)

	guacamoleHandler := NewGuacamoleHandler(nextSession, guacdTunnel)

	// guacd nop 保活：每 15s 发 nop 指令，防止 guacd 检测到 "User is not responding" 而断开
	// nop 无回复不干扰浏览器
	done := make(chan struct{})
	defer close(done)
	startNopKeepalive(guacdTunnel, nextSession.ID, done)

	guacamoleHandler.Start()
	defer guacamoleHandler.Stop()

	for {
		_, message, err := ws.ReadMessage()
		if err != nil {
			// guacdTunnel.Read() 会阻塞，所以要先把guacdTunnel客户端关闭，才能退出Guacd循环
			_ = guacdTunnel.Close()

			observerId := nextSession.ID
			forObsSession.Observer.Del(observerId)
			return nil
		}

		_, err = guacdTunnel.WriteAndFlush(message)
		if err != nil {
			// 监控端写失败只清理本监控连接，不得关闭被监控的主会话（原实现误杀主会话）
			log.Warn("guacd 监控隧道写入失败，关闭监控连接", log.String("sessionId", sessionId), log.NamedError("err", err))
			_ = guacdTunnel.Close()
			observerId := nextSession.ID
			forObsSession.Observer.Del(observerId)
			return nil
		}
	}
}

func (api GuacamoleApi) setConfig(propertyMap map[string]string, s model.Session, configuration *guacamole.Configuration) {
	if propertyMap[guacamole.EnableRecording] == "true" {
		configuration.SetParameter(guacamole.RecordingPath, path.Join(config.GlobalCfg.Guacd.Recording, s.ID))
		configuration.SetParameter(guacamole.CreateRecordingPath, "true")
	} else {
		configuration.SetParameter(guacamole.RecordingPath, "")
	}

	configuration.Protocol = s.Protocol
	switch configuration.Protocol {
	case "rdp":
		configuration.SetParameter("username", s.Username)
		configuration.SetParameter("password", s.Password)

		configuration.SetParameter("security", "any")
		configuration.SetParameter("ignore-cert", "true")
		configuration.SetParameter("create-drive-path", "true")
		configuration.SetParameter("resize-method", "reconnect")
		configuration.SetParameter("jpeg-quality", "80")
		configuration.SetParameter("webp-quality", "80")
		configuration.SetParameter(guacamole.EnableWallpaper, propertyMap[guacamole.EnableWallpaper])
		configuration.SetParameter(guacamole.EnableTheming, propertyMap[guacamole.EnableTheming])
		configuration.SetParameter(guacamole.EnableFontSmoothing, propertyMap[guacamole.EnableFontSmoothing])
		configuration.SetParameter(guacamole.EnableFullWindowDrag, propertyMap[guacamole.EnableFullWindowDrag])
		configuration.SetParameter(guacamole.EnableDesktopComposition, propertyMap[guacamole.EnableDesktopComposition])
		configuration.SetParameter(guacamole.EnableMenuAnimations, propertyMap[guacamole.EnableMenuAnimations])
		configuration.SetParameter(guacamole.DisableBitmapCaching, propertyMap[guacamole.DisableBitmapCaching])
		configuration.SetParameter(guacamole.DisableOffscreenCaching, propertyMap[guacamole.DisableOffscreenCaching])
		configuration.SetParameter(guacamole.ColorDepth, propertyMap[guacamole.ColorDepth])
		configuration.SetParameter(guacamole.ForceLossless, propertyMap[guacamole.ForceLossless])
		configuration.SetParameter(guacamole.PreConnectionId, propertyMap[guacamole.PreConnectionId])
		configuration.SetParameter(guacamole.PreConnectionBlob, propertyMap[guacamole.PreConnectionBlob])
	case "ssh":
		if len(s.PrivateKey) > 0 && s.PrivateKey != "-" {
			configuration.SetParameter("username", s.Username)
			configuration.SetParameter("private-key", s.PrivateKey)
			configuration.SetParameter("passphrase", s.Passphrase)
		} else {
			configuration.SetParameter("username", s.Username)
			configuration.SetParameter("password", s.Password)
		}

		configuration.SetParameter(guacamole.FontSize, propertyMap[guacamole.FontSize])
		configuration.SetParameter(guacamole.FontName, propertyMap[guacamole.FontName])
		configuration.SetParameter(guacamole.ColorScheme, propertyMap[guacamole.ColorScheme])
		configuration.SetParameter(guacamole.Backspace, propertyMap[guacamole.Backspace])
		configuration.SetParameter(guacamole.TerminalType, propertyMap[guacamole.TerminalType])
	case "vnc":
		configuration.SetParameter("username", s.Username)
		configuration.SetParameter("password", s.Password)
	case "telnet":
		configuration.SetParameter("username", s.Username)
		configuration.SetParameter("password", s.Password)

		configuration.SetParameter(guacamole.FontSize, propertyMap[guacamole.FontSize])
		configuration.SetParameter(guacamole.FontName, propertyMap[guacamole.FontName])
		configuration.SetParameter(guacamole.ColorScheme, propertyMap[guacamole.ColorScheme])
		configuration.SetParameter(guacamole.Backspace, propertyMap[guacamole.Backspace])
		configuration.SetParameter(guacamole.TerminalType, propertyMap[guacamole.TerminalType])
	case "kubernetes":
		configuration.SetParameter(guacamole.FontSize, propertyMap[guacamole.FontSize])
		configuration.SetParameter(guacamole.FontName, propertyMap[guacamole.FontName])
		configuration.SetParameter(guacamole.ColorScheme, propertyMap[guacamole.ColorScheme])
		configuration.SetParameter(guacamole.Backspace, propertyMap[guacamole.Backspace])
		configuration.SetParameter(guacamole.TerminalType, propertyMap[guacamole.TerminalType])
	default:

	}
}

const (
	nopKeepaliveInterval      = 15 * time.Second
	nopKeepaliveRetryInterval = 5 * time.Second
	nopKeepaliveMaxFailures   = 3
)

// startNopKeepalive 启动 guacd nop 保活 goroutine；done 由调用方提供（主路径为会话级，
// 宽限期内保活持续；监控路径为函数级，随监控连接结束）
// 允许连续 nopKeepaliveMaxFailures 次失败，防止网络瞬断导致保活退出；
// 超过阈值走完整关闭链（原实现仅 return，会话悬挂且状态不一致）
func startNopKeepalive(tunnel *guacamole.Tunnel, sessionId string, done chan struct{}) {
	go func() {
		defer func() {
			if err := recover(); err != nil {
				log.Error("nop keepalive goroutine panic", log.String("panic", fmt.Sprintf("%v", err)))
			}
		}()
		ticker := time.NewTicker(nopKeepaliveInterval)
		defer ticker.Stop()
		failures := 0
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if _, err := tunnel.WriteAndFlush([]byte("3.nop;")); err != nil {
					failures++
					if failures >= nopKeepaliveMaxFailures {
						log.Warn("guacd nop 保活连续失败，判定 guacd 连接断开，关闭会话", log.String("sessionId", sessionId))
						service.SessionService.CloseSessionById(sessionId, TunnelClosed, "远程连接已关闭")
						return
					}
					ticker.Reset(nopKeepaliveRetryInterval)
				} else {
					if failures > 0 {
						failures = 0
						ticker.Reset(nopKeepaliveInterval)
					}
				}
			}
		}
	}()
}
