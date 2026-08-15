package api

import (
	"context"
	"fmt"

	"next-terminal/server/common/guacamole"
	"next-terminal/server/global/session"
	"next-terminal/server/log"
	"next-terminal/server/service"
)

type GuacamoleHandler struct {
	sess   *session.Session
	tunnel *guacamole.Tunnel
	ctx    context.Context
	cancel context.CancelFunc
}

func NewGuacamoleHandler(sess *session.Session, tunnel *guacamole.Tunnel) *GuacamoleHandler {
	ctx, cancel := context.WithCancel(context.Background())
	return &GuacamoleHandler{
		sess:   sess,
		tunnel: tunnel,
		ctx:    ctx,
		cancel: cancel,
	}
}

func (r GuacamoleHandler) Start() {
	go func() {
		defer func() {
			if err := recover(); err != nil {
				log.Error("guacamole handler goroutine panic", log.String("panic", fmt.Sprintf("%v", err)))
			}
		}()
		// 最终关闭回调：Session.Close 时 cancel，防止 handler goroutine 泄漏（R1）
		r.sess.SetOnClose(r.cancel)
		for {
			select {
			case <-r.ctx.Done():
				return
			default:
				instruction, err := r.tunnel.Read()
				if err != nil {
					log.Warn("guacd 隧道读取失败，RDP 连接断开", log.NamedError("err", err))
					if r.sess.IsDetached() {
						// 宽限期内底层连接已死，重连无意义：立即最终关闭（R3）
						service.SessionService.CloseSessionById(r.sess.ID, TunnelClosed, "远程连接已关闭")
						return
					}
					guacamole.Disconnect(r.sess.WebSocket, TunnelClosed, "远程连接已关闭")
					return
				}
				if len(instruction) == 0 {
					continue
				}
				// 统一经 Session 写路径（内部锁 + WriteDeadline）：
				// 与 CloseSessionById 的 WriteCloseMessage 共享同一把锁，杜绝并发写同一 ws.Conn
				if err := r.sess.WriteString(string(instruction)); err != nil {
					log.Warn("guacd 写入 WebSocket 失败", log.NamedError("err", err))
					// 写失败**不退出输出泵**（重连设计的关键）：关闭 ws 促使主循环
					// ReadMessage 失败进入 Detach 宽限期，后续写经 nil ws 静默丢弃；
					// 重连挂接后自动恢复转发。若在此 return，隧道将永久失去读方，
					// 重连成功后画面静止（bug：写失败一次即杀死输出泵）
					if r.sess.WebSocket != nil {
						_ = r.sess.WebSocket.Close()
					}
					continue
				}
			}
		}
	}()
}

func (r GuacamoleHandler) Stop() {
	r.cancel()
}
