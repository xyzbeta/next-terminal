package gateway

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"next-terminal/server/log"
)

type Tunnel struct {
	id                string // 唯一标识
	localHost         string // 本地监听地址
	localPort         int    // 本地端口
	remoteHost        string // 远程连接地址
	remotePort        int    // 远程端口
	listener          net.Listener
	localConnections  []net.Conn
	remoteConnections []net.Conn
	mu                sync.Mutex
}

func (r *Tunnel) Open(sshClient *ssh.Client) {
	for {
		// 每 10 秒解除 Accept 阻塞，清理已关闭的连接
		if tcpListener, ok := r.listener.(*net.TCPListener); ok {
			_ = tcpListener.SetDeadline(time.Now().Add(10 * time.Second))
		}

		localConn, err := r.listener.Accept()
		if err != nil {
			// listener 已被 Close：Accept 不再阻塞，会立即返回 net.ErrClosed。
			// 必须在此退出——若与超时一并 continue，本循环会退化为纯 CPU 空转
			// （实测约 443 万次/秒）且永不结束，每个被关闭的隧道永久占用一个核心。
			// 批量 Shell 作业会对每个经网关的资产建/拆一次隧道，瞬间即可积累上百个。
			if errors.Is(err, net.ErrClosed) {
				return
			}
			// 超时并非致命错误，清理后继续等待
			r.cleanupClosed()
			continue
		}

		remoteAddr := fmt.Sprintf("%s:%d", r.remoteHost, r.remotePort)
		remoteConn, err := sshClient.Dial("tcp", remoteAddr)
		if err != nil {
			_ = localConn.Close()
			return
		}

		r.mu.Lock()
		r.localConnections = append(r.localConnections, localConn)
		r.remoteConnections = append(r.remoteConnections, remoteConn)
		r.mu.Unlock()

		go func() {
			defer func() {
				if err := recover(); err != nil {
					log.Error("网关隧道 copyConn goroutine panic", log.String("panic", fmt.Sprintf("%v", err)))
				}
			}()
			copyConn(localConn, remoteConn)
		}()
		go func() {
			defer func() {
				if err := recover(); err != nil {
					log.Error("网关隧道 copyConn goroutine panic", log.String("panic", fmt.Sprintf("%v", err)))
				}
			}()
			copyConn(remoteConn, localConn)
		}()
	}
}

// cleanupClosed 移除已关闭的连接引用，防止内存泄漏
func (r *Tunnel) cleanupClosed() {
	r.mu.Lock()
	defer r.mu.Unlock()

	alive := func(conns []net.Conn) []net.Conn {
		var result []net.Conn
		for _, conn := range conns {
			_ = conn.SetReadDeadline(time.Now().Add(1 * time.Millisecond))
			_, err := conn.Read(make([]byte, 1))
			if err != nil {
				_ = conn.Close()
				continue
			}
			_ = conn.SetReadDeadline(time.Time{})
			result = append(result, conn)
		}
		return result
	}

	r.localConnections = alive(r.localConnections)
	r.remoteConnections = alive(r.remoteConnections)
}

func (r *Tunnel) Close() {
	// 先关 listener 让 Open 的 Accept 循环退出（见 Open 中对 net.ErrClosed 的处理），
	// 再在锁内摘取连接列表——Accept 循环会加锁追加，此处若不加锁直接置 nil，
	// 并发 append 会写回旧底层数组，导致连接引用丢失、FD 泄漏。
	_ = r.listener.Close()

	r.mu.Lock()
	localConns := r.localConnections
	remoteConns := r.remoteConnections
	r.localConnections = nil
	r.remoteConnections = nil
	r.mu.Unlock()

	for i := range localConns {
		_ = localConns[i].Close()
	}
	for i := range remoteConns {
		_ = remoteConns[i].Close()
	}
}

func copyConn(writer, reader net.Conn) {
	_, _ = io.Copy(writer, reader)
}
