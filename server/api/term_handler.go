package api

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/gorilla/websocket"
	"next-terminal/server/common/term"
	"next-terminal/server/dto"
	"next-terminal/server/global/session"
	"next-terminal/server/log"
	"next-terminal/server/service"
)

const (
	tickInterval           = 60 * time.Millisecond
	flushThreshold         = 32 * 1024 // 超过此阈值立即刷新，不等待 ticker
	chanBufSize            = 64        // dataChan 缓冲大小
	readChunkSize          = 4096      // SSH stdout 每次读取块大小
	keepaliveInterval      = 30 * time.Second
	keepaliveRetryInterval = 5 * time.Second // 失败后快速重试间隔
	keepaliveMaxFailures   = 3               // 连续失败超过此阈值才关闭连接
)

type TermHandler struct {
	sessionId    string
	isRecording  bool
	sess         *session.Session // 会话引用：所有 ws 写统一经 Session 的锁 + WriteDeadline
	nextTerminal *term.NextTerminal
	ctx          context.Context
	cancel       context.CancelFunc
	dataChan     chan []byte
	tick         *time.Ticker
	buf          bytes.Buffer
}

func NewTermHandler(userId, assetId, sessionId string, isRecording bool, ws *websocket.Conn, nextTerminal *term.NextTerminal) *TermHandler {
	ctx, cancel := context.WithCancel(context.Background())
	tick := time.NewTicker(tickInterval)

	sess := session.GlobalSessionManager.GetById(sessionId)
	if sess == nil {
		sess = &session.Session{ID: sessionId, WebSocket: ws}
	}

	return &TermHandler{
		sessionId:    sessionId,
		isRecording:  isRecording,
		sess:         sess,
		nextTerminal: nextTerminal,
		ctx:          ctx,
		cancel:       cancel,
		dataChan:     make(chan []byte, chanBufSize),
		tick:         tick,
	}
}

func (r *TermHandler) Start() {
	go func() {
		defer r.recoverPanic("readFormTunnel")
		r.readFormTunnel()
	}()
	go func() {
		defer r.recoverPanic("writeToWebsocket")
		r.writeToWebsocket()
	}()
	go func() {
		defer r.recoverPanic("keepalive")
		r.keepalive()
	}()
}

// recoverPanic goroutine panic 兜底，防止单点 panic 击穿进程
func (r *TermHandler) recoverPanic(name string) {
	if err := recover(); err != nil {
		log.Error("TermHandler goroutine panic", log.String("name", name), log.String("sessionId", r.sessionId), log.String("panic", fmt.Sprintf("%v", err)))
	}
}

// keepalive 定期向远端 SSH 服务器发送心跳，检测僵死连接
// 允许连续 keepaliveMaxFailures 次失败，防止网络瞬断导致会话被误杀
func (r *TermHandler) keepalive() {
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			_, _, err := r.nextTerminal.SshClient.Conn.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				failures++
				if failures >= keepaliveMaxFailures {
					// 连续失败超阈值，判定连接已断开，走完整关闭链：
					// 关 SSH、关 ws、移除会话条目、更新 DB 状态（原实现只关 SSH 通道，会话状态长期不一致）
					log.Warn("SSH keepalive 连续失败，关闭连接", log.Int("failures", failures), log.String("sessionId", r.sessionId))
					_ = r.nextTerminal.SshSession.Close()
					service.SessionService.CloseSessionById(r.sessionId, TunnelClosed, "SSH 连接已断开")
					return
				}
				// 快速重试：缩短间隔检测是否恢复
				ticker.Reset(keepaliveRetryInterval)
			} else {
				if failures > 0 {
					failures = 0
					ticker.Reset(keepaliveInterval)
				}
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
				log.Warn("SSH stdout 读取失败，readFormTunnel 退出", log.String("sessionId", r.sessionId), log.NamedError("err", err))
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
				log.Warn("WebSocket 写入失败，writeToWebsocket 退出(tick)", log.String("sessionId", r.sessionId))
				return
			}
		case data := <-r.dataChan:
			r.buf.Write(data)
			if r.buf.Len() >= flushThreshold {
				if !r.flush() {
					log.Warn("WebSocket 写入失败，writeToWebsocket 退出(data)", log.String("sessionId", r.sessionId))
					return
				}
			}
		}
	}
}

// flush 将缓冲区数据写入 WebSocket、录屏和监控广播
// 零拷贝路径：buf.Bytes() 视图直接写 ws（type 数字 + content 两段），不再 String/ToString 多次全量拷贝
func (r *TermHandler) flush() bool {
	if r.buf.Len() == 0 {
		return true
	}
	data := r.buf.Bytes()
	if err := r.sess.WriteMessageBytes(Data, data); err != nil {
		log.Warn("flush 发送 WebSocket 失败", log.String("sessionId", r.sessionId), log.NamedError("err", err))
		return false
	}
	if r.isRecording {
		_ = r.nextTerminal.Recorder.WriteData(string(data))
	}
	SendObData(r.sessionId, data)
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

// SendMessageToWebSocket 控制消息（Ping/Closed 等）统一经 Session 写路径：
// 与 flush 的 WriteMessageBytes、CloseSessionById 的 WriteString 共享同一把锁，
// 消除 gorilla 并发写同一 ws.Conn 导致帧交错的风险
func (r *TermHandler) SendMessageToWebSocket(msg dto.Message) error {
	return r.sess.WriteMessage(msg)
}

func SendObData(sessionId string, data []byte) {
	nextSession := session.GlobalSessionManager.GetById(sessionId)
	if nextSession != nil && nextSession.Observer != nil {
		nextSession.Observer.Range(func(key string, ob *session.Session) {
			if err := ob.WriteMessageBytes(Data, data); err != nil {
				log.Warn("observer write failed", log.String("observerId", key), log.NamedError("err", err))
				// 写失败（含 10s 超时）判定观察者已死亡：立即移除并关闭，
				// 原实现保留死亡观察者导致每个 flush 都被 TCP 超时卡住，主会话输出停摆
				nextSession.Observer.Del(key)
			}
		})
	}
}
