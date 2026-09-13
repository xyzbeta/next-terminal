package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"next-terminal/server/common/nt"
	"path"
	"strconv"
	"time"

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
	// 会话保持（tmux 复用）：请求参数按端传递（移动端默认 1，桌面 0）；
	// 资产属性（keep-alive）为显式配置，存在时**覆盖**请求参数 —— 管理员可强制开/关。
	// keep 会落库到 sessions.keep_alive：TTL 清理任务据此定位需要远程 kill 的会话。
	keep := c.QueryParam("keep") == "1"

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

			// 强制远端重绘 —— 不做这一步，用户点「继续」后屏幕会**一直空白**。
			//
			// 原因：重连只做「换绑 ws」，不回放任何历史输出（服务端从不为会话保留输出缓冲），
			// 而客户端是全新的 xterm 实例、本地缓冲为空；远端应用并不知道对面换了人，
			// 不会主动重绘。于是屏幕上什么都没有，直到远端自己产生新输出为止。
			//
			// 解法是终端复用器的标准做法（tmux/screen attach 时同款）：
			// 对 PTY 做一次「抖动式 resize」——先改小一行再改回来，触发两次 SIGWINCH。
			// 全屏 TUI（Claude Code、vim、top）与 bash/readline 收到 SIGWINCH 都会整屏重绘。
			//
			// 放在 goroutine 里：睡眠 60ms 不该阻塞输入循环的建立，否则重连后
			// 头几十毫秒的按键会被丢掉。
			//
			// 尺寸守卫是必须的：cols/rows 为 0 会把 PTY 缩成非法尺寸（前端未上报时会出现）。
			if cols > 0 && rows > 0 {
				go forceRemoteRedraw(existSession.NextTerminal, rows, cols)
			}

			// 复用旧 handler 的 Write/WindowChange（其 readFormTunnel/writeToWebsocket/keepalive
			// 持续运行，经 Session 写路径自动向新 ws 恢复输出）
			reconnectHandler := NewTermHandler(s.Creator, s.AssetId, sessionId, false, ws, existSession.NextTerminal)
			reattachInfo, _ := json.Marshal(map[string]bool{"keep": existSession.NextTerminal.Keep, "attached": false, "reattached": true})
			_ = WriteMessage(ws, dto.NewMessage(Connected, string(reattachInfo)))
			return api.serveSshInputLoop(c, ws, ctx, sessionId, existSession, reconnectHandler)
		}
		// 重连令牌无效，但请求方是「会话本人（归属已在前方校验）且开启会话保持」：
		// 不拒绝，而是**接管** —— 关掉内存中的旧连接（宽限期会话），落到下方
		// 复用重连路径（新建 SSH → attach 同一 tmux）。用户实测痛点：断线后点
		// 「继续」在 60s 宽限期内必然被拒（「会话已存在且重连令牌无效」），
		// 而 tmux 方案下接管是完全安全的（远端任务本来就在 tmux 里继续跑）。
		if keep && s.KeepAlive == "1" {
			log.Info("用户重连接管会话（keep 开启，关闭旧连接后 attach tmux）", log.String("sessionId", sessionId))
			// 关闭链不杀 tmux：kill 只在管理员强断/ TTL 清理时发生
			service.SessionService.CloseSessionById(sessionId, TunnelClosed, "用户重连接管")
		} else {
			return WriteMessage(ws, dto.NewMessage(Closed, "会话已存在且重连令牌无效"))
		}
	}

	var (
		username   = s.Username
		password   = s.Password
		privateKey = s.PrivateKey
		passphrase = s.Passphrase
		ip         = s.IP
		port       = s.Port
	)

	// 凭证获取策略：
	// DisDBSess 会把 password/private_key 清成 "-"。新建会话凭证完整（从资产复制），
	// 不需要再查；重连/恢复会话凭证已清，必须从资产取。
	// 用 s.Password == "-" 判断是否被清理过，避免新建会话多一次 DB 查询+解密。
	if s.Password == "-" && s.AssetId != "" && s.AssetId != "-" {
		if asset, err := service.AssetService.FindByIdAndDecrypt(ctx, s.AssetId); err == nil && asset.ID != "" {
			username = asset.Username
			password = asset.Password
			privateKey = asset.PrivateKey
			passphrase = asset.Passphrase
		}
	}

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
	// 资产级「会话保持」开关覆盖按端默认
	if v, ok := attributes[nt.KeepAlive]; ok {
		keep = v == "true"
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

	nextTerminal.Keep = keep
	// attach 还是新建：在 tmux 启动前用独立 channel 探测（新建路径下会话刚经历断开，
	// 若 tmux 会话仍存活则本次是「恢复 attach」）
	attached := keep && term.TmuxHasSession(nextTerminal.SshClient, sessionId)
	if keep {
		// attach 路径的 -A 不执行 command（状态栏/mouse 设置被跳过），
		// 必须补设——旧版本创建的会话状态栏可能一直开着、mouse 未开（滑动失效），
		// 用户实测反馈过这两点
		term.TmuxEnsureSessionOpts(nextTerminal.SshClient, sessionId)
	}
	if err := term.StartShell(nextTerminal.SshSession, keep, sessionId, rows, cols); err != nil {
		_ = WriteMessage(ws, dto.NewMessage(Closed, "启动Shell失败: "+err.Error()))
		nextTerminal.Close()
		return nil
	}

	clientType := "desktop"
	if c.QueryParam("client") == "mobile" {
		clientType = "mobile"
	}
	sessionForUpdate := model.Session{
		ConnectionId: sessionId,
		Width:        cols,
		Height:       rows,
		Status:       nt.Connecting,
		Recording:    recording,
		ClientType:   clientType,
		ClientName:   c.QueryParam("clientName"),
	}
	if keep {
		sessionForUpdate.KeepAlive = "1"
	} else {
		sessionForUpdate.KeepAlive = "0"
	}
	if sessionForUpdate.Recording == "" {
		// 未录屏时无需审计
		sessionForUpdate.Reviewed = true
	}
	// 创建新会话
	if err := repository.SessionRepository.UpdateById(ctx, &sessionForUpdate, sessionId); err != nil {
		return err
	}

	// Connected 的 content 带上会话保持信息：前端据此显示「会话保持中」徽标，
	// 让用户确认当前连接走的是 tmux（用户实测反馈：无法确认 tmux 是否生效）。
	// keep=false 或降级直连时 attached 恒为 false。
	connInfo, _ := json.Marshal(map[string]bool{"keep": keep, "attached": attached})
	if err := WriteMessage(ws, dto.NewMessage(Connected, string(connInfo))); err != nil {
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
	// ⚠️ 这里**不能** defer termHandler.Stop()。
	//
	// ws 断开时 serveSshInputLoop 会 return，本函数随之返回 —— 若在此 Stop()，
	// 输出泵（writeToWebsocket）会被 cancel 掉。而断线走的是「宽限期 + 重连挂接」：
	// 重连路径只复用既有 handler 的泵、自己不 Start()，泵一死，重连后
	// **终端再也收不到任何输出**（连敲命令的回显都没有），用户看到的就是永久空白。
	//
	// 生命周期改由 Session.Close 驱动：Start() 里注册的 onClose 会调用 Stop()，
	// 而 Close 只在「宽限期到 / 主动断开 / keepalive 判定僵死」时触发，正是该终止的时刻。
	return api.serveSshInputLoop(c, ws, ctx, sessionId, nextSession, termHandler)
}

// forceRemoteRedraw 通过「抖动式 resize」逼远端应用整屏重绘。
//
// 用于重连（「继续」按钮）之后：重连只换绑 ws，不回放历史输出，客户端又是全新的
// xterm 实例，而远端应用并不知道需要重绘 —— 不逼它一次，屏幕就一直空白。
//
// 顺序有讲究：先对齐到客户端真实尺寸（尺寸若确有变化，这一步本身就会触发重绘），
// 再减一行、停顿、改回来 —— 尺寸没变时内核不会发 SIGWINCH，抖动是保证必然触发的那一步。
// 停顿 60ms 是为了让两次 SIGWINCH 落在不同的读取周期里，避免被应用合并成一次处理
// 而只重绘半屏。
//
// 失败一律忽略：重绘是体验优化，拿不到不影响会话本身可用。
func forceRemoteRedraw(nt *term.NextTerminal, rows, cols int) {
	defer func() {
		// 该 goroutine 在 ws 生命周期之外独立运行，panic 无人接管会击穿进程
		if r := recover(); r != nil {
			log.Warn("重连强制重绘异常", log.Any("recover", r))
		}
	}()
	if nt == nil {
		return
	}
	log.Info("强制远端重绘", log.Int("rows", rows), log.Int("cols", cols))
	if err := nt.WindowChange(rows, cols); err != nil {
		log.Warn("重绘对齐尺寸失败", log.NamedError("err", err))
		return
	}
	if rows <= 1 {
		// 单行终端无法再压缩，退化为只对齐尺寸
		return
	}
	_ = nt.WindowChange(rows-1, cols)
	time.Sleep(60 * time.Millisecond)
	if err := nt.WindowChange(rows, cols); err != nil {
		log.Warn("重绘恢复尺寸失败", log.NamedError("err", err))
	}
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
	// 异步送出：主会话的输出泵只做非阻塞投递，慢观察者不再拖住 SSH 主输出
	obSession.StartObserverWriter(Data)
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
