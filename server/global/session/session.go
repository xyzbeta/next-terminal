package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"next-terminal/server/common/guacamole"
	"next-terminal/server/common/term"
	"next-terminal/server/config"
	"next-terminal/server/log"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"next-terminal/server/dto"
)

// GracePeriod ws 断开后底层连接保留等待重连的时长（导出便于集成测试缩短）
var GracePeriod = 60 * time.Second

type Session struct {
	ID           string
	Protocol     string
	Mode         string
	WebSocket    *websocket.Conn
	GuacdTunnel  *guacamole.Tunnel
	NextTerminal *term.NextTerminal
	Observer     *Manager
	mutex        sync.Mutex

	Detached    bool          // ws 已断开、底层连接保留（宽限期内）
	GraceTimer  *time.Timer   // 宽限定时器
	NopDone     chan struct{} // guacd nop 保活停止通道（会话级生命周期）
	nopDoneOnce sync.Once
	onClose     func() // 最终关闭回调（handler cancel，防 goroutine 泄漏）

	Uptime   int64
	Hostname string

	// 观察者异步送出（仅观察者会话使用；主会话与 RDP 监控为 nil/false）
	obQueue     chan []byte
	obDone      chan struct{}
	obCloseOnce sync.Once
	obFailed    atomic.Bool
}

func (s *Session) WriteMessage(msg dto.Message) error {
	if s.WebSocket == nil {
		return nil
	}
	defer s.mutex.Unlock()
	s.mutex.Lock()
	// WriteDeadline 防止写阻塞卡死（观察者静默死亡等场景），仅影响异常路径
	_ = s.WebSocket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	message := []byte(msg.ToString())
	return s.WebSocket.WriteMessage(websocket.BinaryMessage, message)
}

// WriteMessageBytes 零拷贝写：type 数字 + content 直接经 NextWriter 两段写入，
// 避免 string 拼接与 []byte 转换的多次全量拷贝（SSH 输出热路径）
func (s *Session) WriteMessageBytes(msgType int, content []byte) error {
	if s.WebSocket == nil {
		return nil
	}
	defer s.mutex.Unlock()
	s.mutex.Lock()
	_ = s.WebSocket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	w, err := s.WebSocket.NextWriter(websocket.BinaryMessage)
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte(strconv.Itoa(msgType))); err != nil {
		return err
	}
	if _, err := w.Write(content); err != nil {
		return err
	}
	return w.Close()
}

func (s *Session) WriteString(str string) error {
	if s.WebSocket == nil {
		return nil
	}
	defer s.mutex.Unlock()
	s.mutex.Lock()
	_ = s.WebSocket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	message := []byte(str)
	return s.WebSocket.WriteMessage(websocket.TextMessage, message)
}

// WriteBytes 与 WriteString 等价（文本帧），但直接消费 []byte，省掉调用方
// []byte → string → []byte 的两次全量拷贝。
//
// 用于 Guacamole 指令帧：RDP 图像帧单帧可达 MB 级、30fps，原路径
// （guacd.Read 的 string(data) + 此处 WriteString 的 []byte(str)）每帧多两次
// 全量 memcpy 与一份瞬态垃圾。gorilla 的 WriteMessage 会直接写这片内存。
func (s *Session) WriteBytes(p []byte) error {
	if s.WebSocket == nil {
		return nil
	}
	defer s.mutex.Unlock()
	s.mutex.Lock()
	_ = s.WebSocket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return s.WebSocket.WriteMessage(websocket.TextMessage, p)
}

func (s *Session) Close() {
	log.Warn("Session.Close 被调用", log.String("sessionId", s.ID))
	// 先停观察者写出循环，避免它在 ws 关闭后继续取队列里的帧
	s.StopObserverWriter()
	if s.GraceTimer != nil {
		s.GraceTimer.Stop()
	}
	if s.GuacdTunnel != nil {
		_ = s.GuacdTunnel.Close()
	}
	if s.NextTerminal != nil {
		s.NextTerminal.Close()
	}
	if s.WebSocket != nil {
		_ = s.WebSocket.Close()
	}
	if s.NopDone != nil {
		s.nopDoneOnce.Do(func() { close(s.NopDone) })
	}
	if s.onClose != nil {
		s.onClose()
	}
}

// SetOnClose 注册最终关闭回调（handler cancel，防止 writeToWebsocket 等 goroutine 泄漏）
func (s *Session) SetOnClose(f func()) {
	s.mutex.Lock()
	s.onClose = f
	s.mutex.Unlock()
}

// EnsureNopDone 惰性创建会话级 nop 保活停止通道
func (s *Session) EnsureNopDone() chan struct{} {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.NopDone == nil {
		s.NopDone = make(chan struct{})
	}
	return s.NopDone
}

// IsDetached 是否处于宽限期（ws 已断开、底层连接保留）
func (s *Session) IsDetached() bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.Detached
}

// Detach ws 意外断开：置空 ws 并进入宽限期，底层连接保持存活等待重连；
// onTimeout 由调用方注入最终关闭逻辑（CloseSessionById）
func (s *Session) Detach(onTimeout func()) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.GraceTimer != nil {
		s.GraceTimer.Stop()
	}
	s.WebSocket = nil
	s.Detached = true
	s.GraceTimer = time.AfterFunc(GracePeriod, func() {
		if onTimeout != nil {
			onTimeout()
		}
	})
}

// TryReattach 校验重连令牌并挂接新 ws（锁内原子完成换绑/清标志/取消定时器）；成功返回 true
func (s *Session) TryReattach(token string, ws *websocket.Conn) bool {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if !ValidateReconnectToken(s.ID, token) {
		return false
	}
	if s.GraceTimer != nil {
		s.GraceTimer.Stop()
		s.GraceTimer = nil
	}
	s.attachWebSocket(ws)
	s.Detached = false
	return true
}

// ReconnectToken 无状态重连令牌：HMAC-SHA256(EncryptionKey, sessionId) 前 32 位 hex
func ReconnectToken(sessionId string) string {
	mac := hmac.New(sha256.New, []byte(config.GlobalCfg.EncryptionKey))
	mac.Write([]byte(sessionId))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

// ValidateReconnectToken 重连令牌校验（常数时间比较）
func ValidateReconnectToken(sessionId, token string) bool {
	if token == "" || sessionId == "" {
		return false
	}
	expected := ReconnectToken(sessionId)
	return subtle.ConstantTimeCompare([]byte(expected), []byte(token)) == 1
}

// AttachWebSocket 更新会话对应的 WebSocket 连接（用于断线重连）
func (s *Session) AttachWebSocket(ws *websocket.Conn) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.attachWebSocket(ws)
}

func (s *Session) attachWebSocket(ws *websocket.Conn) {
	if s.WebSocket != nil {
		_ = s.WebSocket.Close()
	}
	s.WebSocket = ws
}

// UpdateLastActive 更新最后活跃时间
func (s *Session) UpdateLastActive() {
	s.mutex.Lock()
	s.Uptime = time.Now().Unix()
	s.mutex.Unlock()
}

// observerQueueSize 观察者异步送出队列长度。按「帧」计，不是按字节——
// 终端一帧通常几十字节到几十 KB，256 帧足够吸收一次突发输出（如 cat 大文件）。
const observerQueueSize = 256

// StartObserverWriter 为观察者会话启动异步送出循环。
//
// 为什么必须异步：主会话的 SSH 输出泵（TermHandler.flush）此前是**同步**扇出到
// 所有观察者，每个观察者的 WriteMessageBytes 持自己的锁并带 10s WriteDeadline。
// 一个「慢而未死」的监控端（浏览器后台挂起、网络拥塞、TCP 发送队列满）会让
// flush 阻塞最长 10 秒；阻塞期间 writeToWebsocket 无法消费 dataChan，
// dataChan（cap 64）填满后 readFormTunnel 停止读取 SSH stdout，
// 远端 PTY 的 TCP 窗口随之填满 —— 用户侧表现为「终端卡住」。
//
// 已有修复只摘除「写失败」的死亡观察者，解决不了慢观察者。
// 改为队列 + 独立 goroutine 后，主输出泵只做非阻塞投递。
func (s *Session) StartObserverWriter(messageType int) {
	s.obQueue = make(chan []byte, observerQueueSize)
	s.obDone = make(chan struct{})
	go func() {
		defer func() {
			if err := recover(); err != nil {
				log.Error("观察者写出 goroutine panic", log.String("sessionId", s.ID),
					log.String("panic", fmt.Sprintf("%v", err)))
				s.obFailed.Store(true)
			}
		}()
		for {
			select {
			case <-s.obDone:
				return
			case p := <-s.obQueue:
				if err := s.WriteMessageBytes(messageType, p); err != nil {
					log.Warn("观察者异步写失败，标记失效", log.String("observerId", s.ID), log.NamedError("err", err))
					s.obFailed.Store(true)
					return
				}
			}
		}
	}()
}

// WriteObserverFrame 非阻塞投递一帧给观察者，返回该观察者是否已失效。
//
// 队列满表示观测端消费不过来——只读监控页丢帧可接受，
// 但绝不能为此把主会话的输出泵拖住，故直接丢弃该帧而不阻塞。
func (s *Session) WriteObserverFrame(p []byte) (dead bool) {
	if s.obQueue == nil {
		// 未启动异步循环（如 RDP 监控，其数据源是独立隧道，不走本路径）
		return false
	}
	if s.obFailed.Load() {
		return true
	}
	select {
	case s.obQueue <- p:
		return false
	default:
		return false
	}
}

// StopObserverWriter 停止异步送出循环（幂等）。
func (s *Session) StopObserverWriter() {
	s.obCloseOnce.Do(func() {
		if s.obDone != nil {
			close(s.obDone)
		}
	})
}

type Manager struct {
	id       string
	sessions sync.Map
}

func NewManager() *Manager {
	return &Manager{}
}

func NewObserver(id string) *Manager {
	return &Manager{
		id: id,
	}
}

func (m *Manager) GetById(id string) *Session {
	value, ok := m.sessions.Load(id)
	if ok {
		return value.(*Session)
	}
	return nil
}

func (m *Manager) Add(s *Session) {
	// 防泄漏：同名会话已存在时先关闭旧条目（原实现 Store 覆盖导致旧隧道/SSH 客户端泄漏）
	if old, ok := m.sessions.Load(s.ID); ok {
		if oldSession, ok2 := old.(*Session); ok2 {
			oldSession.Close()
		}
	}
	m.sessions.Store(s.ID, s)
}

func (m *Manager) Del(id string) {
	log.Warn("GlobalSessionManager.Del 被调用", log.String("sessionId", id))
	session := m.GetById(id)
	if session != nil {
		session.Close()
		if session.Observer != nil {
			session.Observer.Clear()
		}
	}
	m.sessions.Delete(id)
}

func (m *Manager) Clear() {
	m.sessions.Range(func(key, value interface{}) bool {
		if session, ok := value.(*Session); ok {
			session.Close()
		}
		m.sessions.Delete(key)
		return true
	})
}

func (m *Manager) Range(f func(key string, value *Session)) {
	m.sessions.Range(func(key, value interface{}) bool {
		if session, ok := value.(*Session); ok {
			f(key.(string), session)
		}
		return true
	})
}

var GlobalSessionManager *Manager

func init() {
	GlobalSessionManager = NewManager()
}
