package api

import (
	"context"
	"fmt"

	"next-terminal/server/common/guacamole"
	"next-terminal/server/global/session"
	"next-terminal/server/log"
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
		for {
			select {
			case <-r.ctx.Done():
				return
			default:
				instruction, err := r.tunnel.Read()
				if err != nil {
					log.Warn("guacd 隧道读取失败，RDP 连接断开", log.NamedError("err", err))
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
					// 写失败后主动关闭隧道与 ws：主循环的 ReadMessage 立即报错走正常清理链，
					// 原实现仅 return，guacd 连接悬挂且 nop 保活使其永不释放
					_ = r.tunnel.Close()
					_ = r.sess.WebSocket.Close()
					return
				}
			}
		}
	}()
}

func (r GuacamoleHandler) Stop() {
	r.cancel()
}
