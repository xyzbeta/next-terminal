package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"next-terminal/server/common/guacamole"
	"next-terminal/server/common/term"
	"next-terminal/server/config"
	"next-terminal/server/log"
	"strconv"
	"sync"
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

func (s *Session) Close() {
	log.Warn("Session.Close 被调用", log.String("sessionId", s.ID))
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
