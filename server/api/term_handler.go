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
	// 初始停止：空闲会话不需要刷新，由 writeToWebsocket 在数据到达时按需启动，
	// 避免每个空闲会话每 60ms 被唤醒一次（原实现 100 个在线会话 = 1670 次/秒无效唤醒）
	tick := time.NewTicker(tickInterval)
	tick.Stop()

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
	// 最终关闭回调：Session.Close 时收尾，防止 writeToWebsocket 等 goroutine 泄漏（R1）。
	//
	// 注册的是完整的 Stop() 而不是裸 cancel()：Stop 是本 handler 唯一的终止入口
	// （见 SshEndpoint 中「不能 defer Stop」的说明），这里要一并完成
	// tick.Stop() 与 ReleaseStats()，否则统计基线不释放。
	r.sess.SetOnClose(r.Stop)
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
	// 释放该会话的 CPU 差分基准，避免 preCPUs 随历史会话数无限增长
	ReleaseStats(r.sessionId)
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

// writeToWebsocket 混合刷新策略：ticker 合并小包，超阈值立即刷新大块数据。
// ticker 按需启停：有数据待刷新时才启动 60ms 合并窗口，缓冲清空后立即停表，
// 空闲会话因此完全不产生定时唤醒（保持"有就发、小包合并"的交互语义不变）。
func (r *TermHandler) writeToWebsocket() {
	ticking := false
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-r.tick.C:
			if !r.flush() {
				log.Warn("WebSocket 写入失败，writeToWebsocket 退出(tick)", log.String("sessionId", r.sessionId))
				return
			}
			// 缓冲已清空：停表，空闲期间不再唤醒
			if r.buf.Len() == 0 {
				r.tick.Stop()
				ticking = false
			}
		case data := <-r.dataChan:
			r.buf.Write(data)
			if r.buf.Len() >= flushThreshold {
				if !r.flush() {
					log.Warn("WebSocket 写入失败，writeToWebsocket 退出(data)", log.String("sessionId", r.sessionId))
					return
				}
				if ticking {
					r.tick.Stop()
					ticking = false
				}
			} else if !ticking {
				// 首次进入待刷状态：启动合并窗口
				r.tick.Reset(tickInterval)
				ticking = true
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
		// 输出泵不退出：关闭 ws 促使主循环 Detach 进入宽限期，宽限期内继续读 SSH
		// stdout 丢弃，重连挂接后自动恢复输出（若在此返回，writeToWebsocket 退出，
		// 重连成功后终端无任何输出——bug：写失败一次即杀死输出泵）
		if r.sess.WebSocket != nil {
			_ = r.sess.WebSocket.Close()
		}
		return true
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

// SendObData 把主会话的输出帧扇出给所有观察者（监控端）。
//
// 必须是**非阻塞**的：本函数在 SSH 输出泵的 flush() 里同步调用，
// 一旦在这里等待观测端的网络写，慢观察者就会顺着
// flush → dataChan 填满 → 停止读 SSH stdout → 远端 PTY 窗口填满
// 这条链把主会话的终端卡住（详见 Session.StartObserverWriter 的说明）。
// 投递到各观察者自己的队列后立即返回，实际写出由观察者的 goroutine 完成。
func SendObData(sessionId string, data []byte) {
	nextSession := session.GlobalSessionManager.GetById(sessionId)
	if nextSession == nil || nextSession.Observer == nil {
		return
	}

	// 先探测是否有观察者，避免无人监控时也白拷一份
	hasObserver := false
	nextSession.Observer.Range(func(_ string, _ *session.Session) {
		hasObserver = true
	})
	if !hasObserver {
		return
	}

	// data 是 flush 的 buf 视图，函数返回后 buf.Reset() 会复用同一片内存，
	// 异步写循环必须持有自己的副本。所有观察者共享这一份副本（都只读不写），
	// 因此每个 flush 只多一次拷贝，而不是每个观察者一次。
	frame := make([]byte, len(data))
	copy(frame, data)

	nextSession.Observer.Range(func(key string, ob *session.Session) {
		if ob.WriteObserverFrame(frame) {
			// 观察者已确认失效（写失败或 panic）：摘除，避免后续 flush 继续为它拷贝
			log.Warn("观察者已失效，摘除", log.String("observerId", key))
			nextSession.Observer.Del(key)
		}
	})
}
