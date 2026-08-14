package session

import (
	"next-terminal/server/common/guacamole"
	"next-terminal/server/common/term"
	"next-terminal/server/log"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"next-terminal/server/dto"
)

type Session struct {
	ID           string
	Protocol     string
	Mode         string
	WebSocket    *websocket.Conn
	GuacdTunnel  *guacamole.Tunnel
	NextTerminal *term.NextTerminal
	Observer     *Manager
	mutex        sync.Mutex

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
	if s.GuacdTunnel != nil {
		_ = s.GuacdTunnel.Close()
	}
	if s.NextTerminal != nil {
		s.NextTerminal.Close()
	}
	if s.WebSocket != nil {
		_ = s.WebSocket.Close()
	}
}

// ValidateReconnectToken 验证重连令牌
func (s *Session) ValidateReconnectToken(token string) bool {
	// TODO: 实现完整的重连令牌验证逻辑
	return false
}

// AttachWebSocket 更新会话对应的 WebSocket 连接（用于断线重连）
func (s *Session) AttachWebSocket(ws *websocket.Conn) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
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
