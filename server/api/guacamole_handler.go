package api

import (
	"context"
	"next-terminal/server/common/guacamole"
	"next-terminal/server/log"

	"github.com/gorilla/websocket"
)

type GuacamoleHandler struct {
	ws     *websocket.Conn
	tunnel *guacamole.Tunnel
	ctx    context.Context
	cancel context.CancelFunc
}

func NewGuacamoleHandler(ws *websocket.Conn, tunnel *guacamole.Tunnel) *GuacamoleHandler {
	ctx, cancel := context.WithCancel(context.Background())
	return &GuacamoleHandler{
		ws:     ws,
		tunnel: tunnel,
		ctx:    ctx,
		cancel: cancel,
	}
}

func (r GuacamoleHandler) Start() {
	go func() {
		for {
			select {
			case <-r.ctx.Done():
				return
			default:
				instruction, err := r.tunnel.Read()
				if err != nil {
					log.Warn("guacd 隧道读取失败，RDP 连接断开", log.NamedError("err", err))
					guacamole.Disconnect(r.ws, TunnelClosed, "远程连接已关闭")
					return
				}
				if len(instruction) == 0 {
					continue
				}
				err = r.ws.WriteMessage(websocket.TextMessage, instruction)
				if err != nil {
					return
				}
			}
		}
	}()
}

func (r GuacamoleHandler) Stop() {
	r.cancel()
}
