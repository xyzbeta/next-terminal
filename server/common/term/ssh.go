package term

import (
	"fmt"
	"net"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/net/proxy"
)

// 优先 chacha20（无 AES-NI 的 CPU 更快）和 aes128-gcm（有 AES-NI 时最快）
var preferredCiphers = []string{
	"chacha20-poly1305@openssh.com",
	"aes128-gcm@openssh.com",
	"aes256-gcm@openssh.com",
	"aes128-ctr",
	"aes256-ctr",
}

// sshHandshakeTimeout SSH 握手（version 交换 + KEX + 认证）的读/写超时。
//
// 只覆盖握手阶段，建立成功后立即清除（见 NewSshClient / NewSshClientUseSocks）。
// 运行中的会话不能有 deadline：交互式终端可能长时间静默空闲。
//
// 取值需容纳慢链路下的 KEX 与多次认证尝试，30s 对正常目标足够宽松，
// 同时把「对端接受 TCP 却不回数据」这类僵死连接限制在可控时间内。
const sshHandshakeTimeout = 30 * time.Second

func NewSshClient(ip string, port int, username, password, privateKey, passphrase string) (*ssh.Client, error) {
	var authMethod ssh.AuthMethod
	if username == "-" || username == "" {
		username = "root"
	}
	if password == "-" {
		password = ""
	}
	if privateKey == "-" {
		privateKey = ""
	}
	if passphrase == "-" {
		passphrase = ""
	}

	var err error
	if privateKey != "" {
		var key ssh.Signer
		if len(passphrase) > 0 {
			key, err = ssh.ParsePrivateKeyWithPassphrase([]byte(privateKey), []byte(passphrase))
			if err != nil {
				return nil, err
			}
		} else {
			key, err = ssh.ParsePrivateKey([]byte(privateKey))
			if err != nil {
				return nil, err
			}
		}
		authMethod = ssh.PublicKeys(key)
	} else {
		authMethod = ssh.Password(password)
	}

	config := &ssh.ClientConfig{
		User:            username,
		Auth:            []ssh.AuthMethod{authMethod},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Config: ssh.Config{
			Ciphers: preferredCiphers,
		},
	}

	addr := fmt.Sprintf("%s:%d", ip, port)

	// 使用自定义 dialer 启用 TCP keepalive，中间 NAT/firewall 不会因无声期断开连接
	netDialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 15 * time.Second,
	}
	conn, err := netDialer.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}

	// 握手阶段设 deadline：对端可能接受了 TCP 却永不发送 SSH version banner
	// （黑洞路由、假死 sshd、被防火墙静默丢弃），此时 NewClientConn 会永久阻塞。
	// 注意 net.Dialer.Timeout 只覆盖 TCP 建连，覆盖不到握手。
	//
	// 风险链：资产状态巡检用 sem(10) 限流，10 条僵死连接即可占满信号量 →
	// 主循环阻塞 → wg.Wait() 永不返回 → 配合 cron 的 SkipIfStillRunning，
	// 此后所有巡检被永久跳过且没有任何告警。
	//
	// ⚠️ 握手成功后必须清除：ssh.Client 复用这条连接跑整个会话，
	// 残留 deadline 会让空闲会话在到期后被误杀。
	_ = conn.SetDeadline(time.Now().Add(sshHandshakeTimeout))
	clientConn, channels, requests, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(clientConn, channels, requests), nil
}

func NewSshClientUseSocks(ip string, port int, username, password, privateKey, passphrase string, socksProxyHost, socksProxyPort, socksProxyUsername, socksProxyPassword string) (*ssh.Client, error) {
	var authMethod ssh.AuthMethod
	if username == "-" || username == "" {
		username = "root"
	}
	if password == "-" {
		password = ""
	}
	if privateKey == "-" {
		privateKey = ""
	}
	if passphrase == "-" {
		passphrase = ""
	}

	var err error
	if privateKey != "" {
		var key ssh.Signer
		if len(passphrase) > 0 {
			key, err = ssh.ParsePrivateKeyWithPassphrase([]byte(privateKey), []byte(passphrase))
			if err != nil {
				return nil, err
			}
		} else {
			key, err = ssh.ParsePrivateKey([]byte(privateKey))
			if err != nil {
				return nil, err
			}
		}
		authMethod = ssh.PublicKeys(key)
	} else {
		authMethod = ssh.Password(password)
	}

	config := &ssh.ClientConfig{
		Timeout:         3 * time.Second,
		User:            username,
		Auth:            []ssh.AuthMethod{authMethod},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Config: ssh.Config{
			Ciphers: preferredCiphers,
		},
	}

	socksProxyAddr := fmt.Sprintf("%s:%s", socksProxyHost, socksProxyPort)

	socks5, err := proxy.SOCKS5("tcp", socksProxyAddr,
		&proxy.Auth{User: socksProxyUsername, Password: socksProxyPassword},
		&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		},
	)
	if err != nil {
		return nil, err
	}

	addr := fmt.Sprintf("%s:%d", ip, port)
	conn, err := socks5.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}

	// 同上：SSH 握手阶段必须有 deadline，成功后再清除。
	// 注：SOCKS5 代理自身的协商发生在上面的 socks5.Dial 内，该库没有 IO deadline
	// （其源码留有 TODO），这一段仍不受本 deadline 保护，只能靠上层 sem(10) 限流。
	_ = conn.SetDeadline(time.Now().Add(sshHandshakeTimeout))
	clientConn, channels, requests, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})

	return ssh.NewClient(clientConn, channels, requests), nil
}
