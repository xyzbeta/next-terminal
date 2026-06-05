package security

import (
	"sort"
	"sync"
)

type Security struct {
	ID       string
	Rule     string
	IP       string
	Priority int64 // 越小优先级越高
}

type Manager struct {
	securities sync.Map
	values     []*Security
	mu         sync.RWMutex
}

func NewManager() *Manager {
	return &Manager{}
}

func (m *Manager) Clear() {
	m.securities.Range(func(k, _ interface{}) bool {
		m.securities.Delete(k)
		return true
	})
}

func (m *Manager) LoadData() {
	var values []*Security
	m.securities.Range(func(key, value interface{}) bool {
		if security, ok := value.(*Security); ok {
			values = append(values, security)
		}
		return true
	})

	sort.Slice(values, func(i, j int) bool {
		return values[i].Priority < values[j].Priority
	})

	m.mu.Lock()
	m.values = values
	m.mu.Unlock()
}

func (m *Manager) Values() []*Security {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.values
}

func (m *Manager) Add(s *Security) {
	m.securities.Store(s.ID, s)
	m.LoadData()
}

func (m *Manager) Del(id string) {
	m.securities.Delete(id)
	m.LoadData()
}

var GlobalSecurityManager *Manager

func init() {
	GlobalSecurityManager = NewManager()
}
