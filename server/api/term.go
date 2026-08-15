package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"next-terminal/server/common/nt"
	"path"
	"strconv"

	"next-terminal/server/common/guacamole"
	"next-terminal/server/common/term"
	"next-terminal/server/config"
	"next-terminal/server/dto"
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
	Closed    = 0
	Connected = 1
	Data      = 2
	Resize    = 3
	Ping      = 4
)

type WebTerminalApi struct {
}

func (api WebTerminalApi) SshEndpoint(c echo.Context) error {
	ws, err := UpGrader.Upgrade(c.Response().Writer, c.Request(), nil)
	if err != nil {
		return err
	}

	defer func() {
		_ = ws.Close()
	}()
	ctx := context.TODO()

	sessionId := c.Param("id")
	cols, _ := strconv.Atoi(c.QueryParam("cols"))
	rows, _ := strconv.Atoi(c.QueryParam("rows"))

	s, err := service.SessionService.FindByIdAndDecrypt(ctx, sessionId)
	if err != nil {
		return WriteMessage(ws, dto.NewMessage(Closed, "获取会话或解密数据失败"))
	}

	// Session ownership: non-admin users can only access their own sessions
	user, _ := GetCurrentAccount(c)
	if user != nil && user.Type != nt.TypeAdmin && user.ID != s.Creator {
		return WriteMessage(ws, dto.NewMessage(Closed, "无权限访问此会话"))
	}

	// 断线重连：会话仍在内存（宽限期内或在线）时只允许挂接既有 SSH 连接，不允许重复新建
	if existSession := session.GlobalSessionManager.GetById(sessionId); existSession != nil {
		if existSession.TryReattach(c.QueryParam("reconnectToken"), ws) {
			// 协议类型守卫：RDP 会话的 NextTerminal 为 nil，错误端点+有效令牌会导致空指针
			if existSession.NextTerminal == nil {
				return WriteMessage(ws, dto.NewMessage(Closed, "会话类型不匹配"))
			}
			log.Info("SSH 会话重连成功", log.String("sessionId", sessionId))
			// 复用旧 handler 的 Write/WindowChange（其 readFormTunnel/writeToWebsocket/keepalive
			// 持续运行，经 Session 写路径自动向新 ws 恢复输出）
			reconnectHandler := NewTermHandler(s.Creator, s.AssetId, sessionId, false, ws, existSession.NextTerminal)
			_ = WriteMessage(ws, dto.NewMessage(Connected, ""))
			return api.serveSshInputLoop(c, ws, ctx, sessionId, existSession, reconnectHandler)
		}
		return WriteMessage(ws, dto.NewMessage(Closed, "会话已存在且重连令牌无效"))
	}

	var (
		username   = s.Username
		password   = s.Password
		privateKey = s.PrivateKey
		passphrase = s.Passphrase
		ip         = s.IP
		port       = s.Port
	)

	if s.AccessGatewayId != "" && s.AccessGatewayId != "-" {
		g, err := service.GatewayService.GetGatewayById(s.AccessGatewayId)
		if err != nil {
			return WriteMessage(ws, dto.NewMessage(Closed, "获取接入网关失败："+err.Error()))
		}

		defer g.CloseSshTunnel(s.ID)
		exposedIP, exposedPort, err := g.OpenSshTunnel(s.ID, ip, port)
		if err != nil {
			return WriteMessage(ws, dto.NewMessage(Closed, "创建隧道失败："+err.Error()))
		}
		ip = exposedIP
		port = exposedPort
	}

	recording := ""
	var isRecording = false
	property, err := repository.PropertyRepository.FindByName(ctx, guacamole.EnableRecording)
	if err == nil && property.Value == "true" {
		isRecording = true
	}

	if isRecording {
		recording = path.Join(config.GlobalCfg.Guacd.Recording, sessionId, "recording.cast")
	}

	attributes, err := repository.AssetRepository.FindAssetAttrMapByAssetId(ctx, s.AssetId)
	if err != nil {
		return WriteMessage(ws, dto.NewMessage(Closed, "获取资产属性失败："+err.Error()))
	}

	var xterm = "xterm-256color"
	var nextTerminal *term.NextTerminal
	if "true" == attributes[nt.SocksProxyEnable] {
		nextTerminal, err = term.NewNextTerminalUseSocks(ip, port, username, password, privateKey, passphrase, rows, cols, recording, xterm, true, attributes[nt.SocksProxyHost], attributes[nt.SocksProxyPort], attributes[nt.SocksProxyUsername], attributes[nt.SocksProxyPassword])
	} else {
		nextTerminal, err = term.NewNextTerminal(ip, port, username, password, privateKey, passphrase, rows, cols, recording, xterm, true)
	}

	if err != nil {
		return WriteMessage(ws, dto.NewMessage(Closed, "创建SSH客户端失败："+err.Error()))
	}

	if err := nextTerminal.RequestPty(xterm, rows, cols); err != nil {
		_ = WriteMessage(ws, dto.NewMessage(Closed, "请求PTY失败: "+err.Error()))
		// 早期失败路径释放 SSH 客户端/录屏文件，防止泄漏
		nextTerminal.Close()
		return nil
	}

	if err := nextTerminal.Shell(); err != nil {
		_ = WriteMessage(ws, dto.NewMessage(Closed, "启动Shell失败: "+err.Error()))
		nextTerminal.Close()
		return nil
	}

	sessionForUpdate := model.Session{
		ConnectionId: sessionId,
		Width:        cols,
		Height:       rows,
		Status:       nt.Connecting,
		Recording:    recording,
	}
	if sessionForUpdate.Recording == "" {
		// 未录屏时无需审计
		sessionForUpdate.Reviewed = true
	}
	// 创建新会话
	if err := repository.SessionRepository.UpdateById(ctx, &sessionForUpdate, sessionId); err != nil {
		return err
	}

	if err := WriteMessage(ws, dto.NewMessage(Connected, "")); err != nil {
		nextTerminal.Close()
		return err
	}

	nextSession := &session.Session{
		ID:           s.ID,
		Protocol:     s.Protocol,
		Mode:         s.Mode,
		WebSocket:    ws,
		GuacdTunnel:  nil,
		NextTerminal: nextTerminal,
		Observer:     session.NewObserver(s.ID),
	}
	session.GlobalSessionManager.Add(nextSession)

	termHandler := NewTermHandler(s.Creator, s.AssetId, sessionId, isRecording, ws, nextTerminal)
	termHandler.Start()
	defer termHandler.Stop()

	return api.serveSshInputLoop(c, ws, ctx, sessionId, nextSession, termHandler)
}

// serveSshInputLoop 浏览器 → 远端方向的输入循环（新建与重连路径共用）
func (api WebTerminalApi) serveSshInputLoop(c echo.Context, ws *websocket.Conn, ctx context.Context, sessionId string, nextSession *session.Session, termHandler *TermHandler) error {
	for {
		_, message, err := ws.ReadMessage()
		if err != nil {
			log.Warn("WebSocket读取失败，进入宽限期等待重连", log.String("sessionId", sessionId), log.NamedError("err", err))
			// 不关闭底层 SSH 连接：保留等待重连，宽限期到由回调执行完整关闭链
			nextSession.Detach(func() {
				service.SessionService.CloseSessionById(sessionId, TunnelClosed, "断线重连超时")
			})
			break
		}

		msg, err := dto.ParseMessage(string(message))
		if err != nil {
			continue
		}

		switch msg.Type {
		case Resize:
			decodeString, err := base64.StdEncoding.DecodeString(msg.Content)
			if err != nil {
				continue
			}
			var winSize dto.WindowSize
			err = json.Unmarshal(decodeString, &winSize)
			if err != nil {
				continue
			}
			if err := termHandler.WindowChange(winSize.Rows, winSize.Cols); err != nil {
			}
			_ = repository.SessionRepository.UpdateWindowSizeById(ctx, winSize.Rows, winSize.Cols, sessionId)
		case Data:
			input := []byte(msg.Content)
			err := termHandler.Write(input)
			if err != nil {
				log.Warn("SSH写入失败，关闭会话", log.String("sessionId", sessionId), log.NamedError("err", err))
				service.SessionService.CloseSessionById(sessionId, TunnelClosed, "远程连接已关闭")
			}
		case Ping:
			// 直接回复 Ping 测量 WebSocket 链路延迟，不做 SSH keepalive
			// SSH 连接健康由 TermHandler.keepalive() goroutine 监控（每 30s）
			_ = termHandler.SendMessageToWebSocket(dto.NewMessage(Ping, ""))

		}
	}
	return nil
}

func (api WebTerminalApi) SshMonitorEndpoint(c echo.Context) error {
	ws, err := UpGrader.Upgrade(c.Response().Writer, c.Request(), nil)
	if err != nil {
		return err
	}

	defer func() {
		_ = ws.Close()
	}()
	ctx := context.TODO()

	sessionId := c.Param("id")
	s, err := repository.SessionRepository.FindById(ctx, sessionId)
	if err != nil {
		return WriteMessage(ws, dto.NewMessage(Closed, "获取会话失败"))
	}

	// 会话归属校验：非管理员仅可监控本人会话（此前该端点缺失校验）
	user, _ := GetCurrentAccount(c)
	if user != nil && user.Type != nt.TypeAdmin && user.ID != s.Creator {
		return WriteMessage(ws, dto.NewMessage(Closed, "无权限访问此会话"))
	}

	nextSession := session.GlobalSessionManager.GetById(sessionId)
	if nextSession == nil {
		return WriteMessage(ws, dto.NewMessage(Closed, "会话已离线"))
	}

	obId := utils.UUID()
	obSession := &session.Session{
		ID:        obId,
		Protocol:  s.Protocol,
		Mode:      s.Mode,
		WebSocket: ws,
	}
	nextSession.Observer.Add(obSession)

	for {
		_, _, err := ws.ReadMessage()
		if err != nil {
			nextSession.Observer.Del(obId)
			break
		}
	}
	return nil
}

func (api WebTerminalApi) permissionCheck(c echo.Context, assetId string) error {
	user, _ := GetCurrentAccount(c)
	if nt.TypeUser == user.Type {
		// 检测是否有访问权限 TODO
		//assetIds, err := repository.ResourceSharerRepository.FindAssetIdsByUserId(context.TODO(), user.ID)
		//if err != nil {
		//	return err
		//}
		//
		//if !utils.Contains(assetIds, assetId) {
		//	return errors.New("您没有权限访问此资产")
		//}
	}
	return nil
}

func WriteMessage(ws *websocket.Conn, msg dto.Message) error {
	message := []byte(msg.ToString())
	return ws.WriteMessage(websocket.TextMessage, message)
}

func CreateNextTerminalBySession(session model.Session) (*term.NextTerminal, error) {
	var (
		username   = session.Username
		password   = session.Password
		privateKey = session.PrivateKey
		passphrase = session.Passphrase
		ip         = session.IP
		port       = session.Port
	)
	return term.NewNextTerminal(ip, port, username, password, privateKey, passphrase, 10, 10, "", "", false)
}
