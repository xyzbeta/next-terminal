package term

import (
	"fmt"

	"golang.org/x/crypto/ssh"
)

// tmux 会话复用：移动端「随时断网、任务不中断」的核心能力。
//
// 设计（2026-09-12 与用户对齐的方案 A+C）：
//   · keep 开启时，SSH 连接建立后不直接起 shell，而是执行
//     `tmux new-session -A -s nt-<sessionId>`（attach-or-create：会话不存在则创建，
//     存在则直接挂接）。网络切换后重连 → attach 回同一个 tmux → 任务/输出/TUI 完整保留。
//   · 会话名带 sessionId 前缀 nt-，全局唯一，多用户多资产互不冲突。
//   · status off 按会话设置（set-option -t），不污染服务器上其他用户的 tmux。
//   · 远端未安装 tmux 时自动降级为 `exec $SHELL -l`（保持既有行为）。
//   · detach 误触：status off 已隐藏状态栏；detach 后画面停在 [detached] 提示，
//     属 tmux 固有语义（重进页面 attach 即可恢复）。
//
// 生命周期：
//   · 用户断开/断网：只关 TCP，tmux 会话保留（等待重连 attach 或 TTL 清理）；
//   · 管理员强制断开：CloseSessionById 先发 kill-session，真正终止任务；
//   · TTL 清理（下一版）：disconnected 超时可配时长后清理任务远程 kill。

const tmuxSessionPrefix = "nt-"

// tmuxSessionName 会话对应的 tmux 会话名
func tmuxSessionName(sessionId string) string {
	return tmuxSessionPrefix + sessionId
}

// tmuxShellCommand 生成启动 shell 的远端命令（keep 时走 tmux attach-or-create）。
// cols/rows 用于新建会话时的初始窗口尺寸（attach 已有会话时忽略）。
func tmuxShellCommand(sessionId string, cols, rows int) string {
	name := tmuxSessionName(sessionId)
	// 探测 tmux → attach-or-create → 隐藏状态栏；无 tmux 则回退默认 shell。
	//
	// ⚠️ `\;` 是关键：把 set-option 变成 **tmux 自己的命令**（在 new-session 创建时
	// 立即执行）。曾用 shell 的 `;` 分隔——那条 set-option 要等 attach 退出后才执行，
	// 于是首次连接的状态栏（绿色信息条）全程可见，用户实测反馈。
	// 状态栏是会话级 option，随 tmux server 持久——首次创建时关掉，之后 attach 保持关闭。
	return fmt.Sprintf(
		`if command -v tmux >/dev/null 2>&1; then `+
			`exec tmux new-session -A -s %s -x %d -y %d \; set-option status off \; set-option mouse on \; set-option message-bg default \; set-option message-fg default 2>/dev/null; `+
			`else exec $SHELL -l; fi`,
		name, cols, rows)
}

// TmuxEnsureSessionOpts 确保会话级选项（状态栏隐藏 + mouse on）。
//
// 为什么不能只靠 new-session 的 \; set-option：tmux 的 -A（attach-or-create）语义是
// **command 只在创建时执行**——attach 既有会话时设置被跳过。既有会话可能是旧版本创建时
// 从未设置过的，因此必须由独立 channel 补设置。创建路径已覆盖，这里再设幂等无害（双保险）。
//
// mouse on 的意义：tmux 默认关闭鼠标，普通 shell 在备用屏幕下无 mouse reporting，
// 前端的触摸滑动走本地 scrollLines 而备用屏幕没有 scrollback —— **滑动完全无效**
// （用户实测：tmux 后无法滑动查看内容，TUI 因自带 mouse reporting 不受影响）。
// mouse on 后 tmux 向客户端开启 mouse reporting，前端滑动走 SGR 滚轮发送，
// tmux 将其转为 copy-mode 滚动（查看历史），滚到底自动退出。
func TmuxEnsureSessionOpts(client *ssh.Client, sessionId string) {
	if client == nil {
		return
	}
	sess, err := client.NewSession()
	if err != nil {
		return
	}
	defer sess.Close()
	name := tmuxSessionName(sessionId)
	_ = sess.Run(fmt.Sprintf("tmux set-option -t %s status off 2>/dev/null; tmux set-option -t %s mouse on 2>/dev/null; tmux set-option -t %s message-bg default 2>/dev/null; tmux set-option -t %s message-fg default 2>/dev/null", name, name, name, name))
}

// TmuxHasSession 探测目标会话是否已存在（attach 还是新建）。
// 用独立的 SSH channel 执行，不影响主会话的 stdin/stdout 管道。
func TmuxHasSession(client *ssh.Client, sessionId string) bool {
	if client == nil {
		return false
	}
	sess, err := client.NewSession()
	if err != nil {
		return false
	}
	defer sess.Close()
	return sess.Run(fmt.Sprintf(
		"command -v tmux >/dev/null 2>&1 && tmux has-session -t %s 2>/dev/null",
		tmuxSessionName(sessionId))) == nil
}

// killTmuxCommand 生成终止 tmux 会话的远端命令（管理员强断/清理用）。
// 会话不存在时 kill-session 返回非零，由调用方决定是否关心。
func killTmuxCommand(sessionId string) string {
	return fmt.Sprintf(`tmux kill-session -t %s 2>/dev/null`, tmuxSessionName(sessionId))
}

// StartShell 启动远端 shell。keep=true 时走 tmux attach-or-create，否则默认 shell。
// 使用 Start(command) 而非 Shell()：Shell() 只能起默认登录 shell，无法注入 tmux 包装。
func StartShell(sess *ssh.Session, keep bool, sessionId string, cols, rows int) error {
	if keep {
		return sess.Start(tmuxShellCommand(sessionId, cols, rows))
	}
	return sess.Shell()
}

// KillTmux 通过独立 SSH channel 终止对应的 tmux 会话（管理员强制断开用）。
//
// ⚠️ 必须用 client.NewSession() 建独立 channel，绝不能复用主数据会话
// （NextTerminal.SshSession）：那上面已经 Start 了交互 shell，再 Run 会报
// "ssh: session already started"，kill 静默失败 —— 用户实测「强断后远端任务
// 还在跑」正是这个原因。连接已死时无法执行，由 TTL 清理任务兜底。
func KillTmux(client *ssh.Client, sessionId string) error {
	if client == nil {
		return fmt.Errorf("ssh client is nil")
	}
	sess, err := client.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()
	return sess.Run(killTmuxCommand(sessionId))
}
