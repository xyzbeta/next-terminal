package gateway

import (
	"errors"
	"fmt"
	"net"
	"next-terminal/server/common/term"
	"os"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Gateway 接入网关
type Gateway struct {
	ID         string // 接入网关ID
	IP         string
	Port       int
	Username   string
	Password   string
	PrivateKey string
	Passphrase string
	Connected  bool   // 是否已连接
	Message    string // 失败原因
	SshClient  *ssh.Client

	mutex   sync.Mutex
	tunnels map[string]*Tunnel
}

func (g *Gateway) OpenSshTunnel(id, ip string, port int) (exposedIP string, exposedPort int, err error) {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	if !g.Connected {
		sshClient, err := term.NewSshClient(g.IP, g.Port, g.Username, g.Password, g.PrivateKey, g.Passphrase)
		if err != nil {
			g.Connected = false
			g.Message = "接入网关不可用：" + err.Error()
			return "", 0, errors.New(g.Message)
		} else {
			g.Connected = true
			g.SshClient = sshClient
			g.Message = "使用中"
		}
	}

	hostname, err := os.Hostname()
	if err != nil {
		return "", 0, err
	}

	// debug
	//hostname = "0.0.0.0"

	// 直接在目标地址上以 :0 监听并回读实际端口。
	// 原实现先用 GetAvailablePort() 在 localhost 上探测一个空闲端口，再拿去绑
	// hostname:port —— 探测与绑定是两个不同的地址、且中间存在时间窗（TOCTOU），
	// 高并发建隧道时可能绑到已被占用的端口而失败。
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:0", hostname))
	if err != nil {
		return "", 0, err
	}
	localPort := listener.Addr().(*net.TCPAddr).Port

	tunnel := &Tunnel{
		id:        id,
		localHost: hostname,
		//localHost:  "docker.for.mac.host.internal",
		localPort:  localPort,
		remoteHost: ip,
		remotePort: port,
		listener:   listener,
	}
	go tunnel.Open(g.SshClient)
	g.tunnels[tunnel.id] = tunnel

	return tunnel.localHost, tunnel.localPort, nil
}

func (g *Gateway) CloseSshTunnel(id string) {
	g.mutex.Lock()
	defer g.mutex.Unlock()
	t := g.tunnels[id]
	if t != nil {
		t.Close()
		delete(g.tunnels, id)
	}

	if len(g.tunnels) == 0 {
		if g.SshClient != nil {
			_ = g.SshClient.Close()
		}
		g.Connected = false
		g.Message = "暂未使用"
	}
}

func (g *Gateway) Close() {
	for id := range g.tunnels {
		g.CloseSshTunnel(id)
	}
}
