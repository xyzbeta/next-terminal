package sshd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"next-terminal/server/common/nt"
	"strings"

	"next-terminal/server/branding"
	"next-terminal/server/config"
	"next-terminal/server/global/cache"
	"next-terminal/server/global/security"
	"next-terminal/server/log"
	"next-terminal/server/repository"
	"next-terminal/server/service"
	"next-terminal/server/utils"

	"github.com/gliderlabs/ssh"
	"gorm.io/gorm"
)

var Sshd *sshd

type sshd struct {
	gui *Gui
}

func init() {
	gui := &Gui{}
	Sshd = &sshd{
		gui: gui,
	}
}

func (sshd sshd) passwordAuth(ctx ssh.Context, pass string) bool {
	username := ctx.User()
	remoteAddr := strings.Split(ctx.RemoteAddr().String(), ":")[0]

	// 失败计数：与 Web 登录一致，避免 SSH 端口被无限爆破。
	// 键用 socket 对端地址（非 XFF，不可伪造）+ 用户名。
	loginFailCountKey := remoteAddr + username
	if v, ok := cache.LoginFailedKeyManager.Get(loginFailCountKey); ok {
		if count, _ := v.(int); count >= 5 {
			_ = service.UserService.SaveLoginLog(remoteAddr, "terminal", username, false, false, "", "登录失败次数过多，账号已被临时锁定")
			return false
		}
	}

	// 统一的失败处理：累加计数 + 记日志。注意不能向调用方区分
	// 「账号不存在」「密码错误」「账号停用」，否则可枚举用户名。
	reject := func(reason string) bool {
		v, _ := cache.LoginFailedKeyManager.Get(loginFailCountKey)
		count, _ := v.(int)
		cache.LoginFailedKeyManager.Set(loginFailCountKey, count+1, cache.LoginLockExpiration)
		_ = service.UserService.SaveLoginLog(remoteAddr, "terminal", username, false, false, "", reason)
		return false
	}

	user, err := repository.UserRepository.FindByUsername(context.TODO(), username)
	if err != nil {
		return reject("账号或密码不正确")
	}

	// 停用检查：原实现缺失，导致被停用的账号（离职、风险账号）仍可通过
	// 内嵌 SSH 端口登录并访问其被授权的资产，使停用操作形同虚设。
	if user.Status == nt.StatusDisabled {
		return reject("账号已停用")
	}

	if err := utils.Encoder.Match([]byte(user.Password), []byte(pass)); err != nil {
		return reject("账号或密码不正确")
	}
	return true
}

func (sshd sshd) connCallback(ctx ssh.Context, conn net.Conn) net.Conn {
	securities := security.GlobalSecurityManager.Values()
	if len(securities) == 0 {
		return conn
	}

	ip := strings.Split(conn.RemoteAddr().String(), ":")[0]

	for _, s := range securities {
		if strings.Contains(s.IP, "/") {
			// CIDR
			_, ipNet, err := net.ParseCIDR(s.IP)
			if err != nil {
				continue
			}
			if !ipNet.Contains(net.ParseIP(ip)) {
				continue
			}
		} else if strings.Contains(s.IP, "-") {
			// 范围段
			split := strings.Split(s.IP, "-")
			if len(split) < 2 {
				continue
			}
			start := split[0]
			end := split[1]
			intReqIP := utils.IpToInt(ip)
			if intReqIP < utils.IpToInt(start) || intReqIP > utils.IpToInt(end) {
				continue
			}
		} else {
			// IP
			if s.IP != ip {
				continue
			}
		}

		if s.Rule == nt.AccessRuleAllow {
			return conn
		}
		if s.Rule == nt.AccessRuleReject {
			_, _ = conn.Write([]byte("your access request was denied :(\n"))
			return nil
		}
	}

	return conn
}

func (sshd sshd) sessionHandler(sess ssh.Session) {
	defer func() {
		_ = sess.Close()
	}()

	username := sess.User()
	remoteAddr := strings.Split(sess.RemoteAddr().String(), ":")[0]

	user, err := repository.UserRepository.FindByUsername(context.TODO(), username)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			_, _ = io.WriteString(sess, "您输入的账户或密码不正确.\n")
		} else {
			_, _ = io.WriteString(sess, err.Error())
		}
		return
	}

	// 判断是否需要进行双因素认证
	if user.TOTPSecret != "" && user.TOTPSecret != "-" {
		sshd.gui.totpUI(sess, user, remoteAddr, username)
	} else {
		// 保存登录日志
		_ = service.UserService.SaveLoginLog(remoteAddr, "terminal", username, true, false, utils.LongUUID(), "")
		sshd.gui.MainUI(sess, user)
	}
}

func (sshd sshd) Serve() {
	ssh.Handle(func(s ssh.Session) {
		_, _ = io.WriteString(s, branding.Hi)
		sshd.sessionHandler(s)
	})

	fmt.Printf("⇨ sshd server started on %v\n", config.GlobalCfg.Sshd.Addr)
	err := ssh.ListenAndServe(
		config.GlobalCfg.Sshd.Addr,
		nil,
		ssh.PasswordAuth(sshd.passwordAuth),
		ssh.HostKeyFile(config.GlobalCfg.Sshd.Key),
		ssh.WrapConn(sshd.connCallback),
	)
	log.Fatal(fmt.Sprintf("启动sshd服务失败: %v", err.Error()))
}
