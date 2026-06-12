package api

import (
	"bytes"
	"context"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"next-terminal/server/common/term"
	"next-terminal/server/dto"
	"next-terminal/server/global/session"
)

const (
	tickInterval      = 60 * time.Millisecond
	flushThreshold    = 32 * 1024 // 超过此阈值立即刷新，不等待 ticker
	chanBufSize       = 64        // dataChan 缓冲大小
	readChunkSize     = 4096      // SSH stdout 每次读取块大小
	keepaliveInterval = 30 * time.Second
)

type TermHandler struct {
	sessionId    string
	isRecording  bool
	webSocket    *websocket.Conn
	nextTerminal *term.NextTerminal
	ctx          context.Context
	cancel       context.CancelFunc
	dataChan     chan []byte
	tick         *time.Ticker
	mutex        sync.Mutex
	buf          bytes.Buffer
}

func NewTermHandler(userId, assetId, sessionId string, isRecording bool, ws *websocket.Conn, nextTerminal *term.NextTerminal) *TermHandler {
	ctx, cancel := context.WithCancel(context.Background())
	tick := time.NewTicker(tickInterval)

	return &TermHandler{
		sessionId:    sessionId,
		isRecording:  isRecording,
		webSocket:    ws,
		nextTerminal: nextTerminal,
		ctx:          ctx,
		cancel:       cancel,
		dataChan:     make(chan []byte, chanBufSize),
		tick:         tick,
	}
}

func (r *TermHandler) Start() {
	go r.readFormTunnel()
	go r.writeToWebsocket()
	go r.keepalive()
}

// keepalive 定期向远端 SSH 服务器发送心跳，检测僵死连接
func (r *TermHandler) keepalive() {
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			_, _, err := r.nextTerminal.SshClient.Conn.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				// 连接断开，触发清理
				_ = r.nextTerminal.SshSession.Close()
				return
			}
		}
	}
}

func (r *TermHandler) Stop() {
	r.tick.Stop()
	r.cancel()
}

// readFormTunnel 以 chunk 方式从 SSH stdout 读取数据，不再逐字符 ReadRune
func (r *TermHandler) readFormTunnel() {
	buf := make([]byte, readChunkSize)
	for {
		select {
		case <-r.ctx.Done():
			return
		default:
			n, err := r.nextTerminal.StdoutReader.Read(buf)
			if err != nil {
				return
			}
			if n > 0 {
				// 复制数据避免下一轮 Read 覆盖
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				select {
				case r.dataChan <- chunk:
				case <-r.ctx.Done():
					return
				}
			}
		}
	}
}

// writeToWebsocket 混合刷新策略：ticker 合并小包，超阈值立即刷新大块数据
func (r *TermHandler) writeToWebsocket() {
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-r.tick.C:
			if !r.flush() {
				return
			}
		case data := <-r.dataChan:
			r.buf.Write(data)
			if r.buf.Len() >= flushThreshold {
				if !r.flush() {
					return
				}
			}
		}
	}
}

// flush 将缓冲区数据写入 WebSocket、录屏和监控广播
func (r *TermHandler) flush() bool {
	s := r.buf.String()
	if s == "" {
		return true
	}
	if err := r.SendMessageToWebSocket(dto.NewMessage(Data, s)); err != nil {
		return false
	}
	if r.isRecording {
		_ = r.nextTerminal.Recorder.WriteData(s)
	}
	SendObData(r.sessionId, s)
	r.buf.Reset()
	return true
}

func (r *TermHandler) Write(input []byte) error {
	_, err := r.nextTerminal.Write(input)
	return err
}

func (r *TermHandler) WindowChange(h int, w int) error {
	return r.nextTerminal.WindowChange(h, w)
}

func (r *TermHandler) SendMessageToWebSocket(msg dto.Message) error {
	if r.webSocket == nil {
		return nil
	}
	defer r.mutex.Unlock()
	r.mutex.Lock()
	message := []byte(msg.ToString())
	return r.webSocket.WriteMessage(websocket.TextMessage, message)
}

func SendObData(sessionId, s string) {
	nextSession := session.GlobalSessionManager.GetById(sessionId)
	if nextSession != nil && nextSession.Observer != nil {
		nextSession.Observer.Range(func(key string, ob *session.Session) {
			_ = ob.WriteMessage(dto.NewMessage(Data, s))
		})
	}
}
