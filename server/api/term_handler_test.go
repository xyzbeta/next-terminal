package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"next-terminal/server/global/session"

	"github.com/gorilla/websocket"
)

// TestSendObDataDoesNotBlockOnSlowObserver 验证「慢观察者不再拖住主会话输出」。
//
// 回归背景：SendObData 在 SSH 输出泵的 flush() 里同步调用，此前直接对每个观察者
// 做 WriteMessageBytes（带 10s WriteDeadline）。一个「慢而未死」的监控端会让 flush
// 阻塞最长 10 秒，进而经 dataChan 填满 → 停止读 SSH stdout → 远端 PTY 窗口填满，
// 把主会话的终端卡住。现改为投递到观察者自己的队列后立即返回。
//
// 本用例构造一个「连上但完全不读」的观察者，把它的 TCP 发送缓冲与队列灌满，
// 断言 SendObData 仍然立即返回。
func TestSendObDataDoesNotBlockOnSlowObserver(t *testing.T) {
	// 服务端：升级后不读任何数据（模拟挂起的监控端）
	serverConnCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnCh <- c
		// 刻意不调用 c.ReadMessage()：不消费对端数据，让服务端写缓冲最终填满
		<-make(chan struct{})
	}))
	defer srv.Close()

	clientConn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("建立测试 WebSocket 失败: %v", err)
	}
	defer clientConn.Close()
	// 同样不在客户端读取，使 TCP 接收窗口也不被消费

	var serverConn *websocket.Conn
	select {
	case serverConn = <-serverConnCh:
	case <-time.After(3 * time.Second):
		t.Fatal("未能取得服务端 WebSocket 连接")
	}

	// 组装一个被监控的主会话 + 一个慢观察者
	const sessionId = "test-main-session"
	mainSession := &session.Session{ID: sessionId, Observer: session.NewObserver(sessionId)}
	session.GlobalSessionManager.Add(mainSession)
	defer session.GlobalSessionManager.Del(sessionId)

	observer := &session.Session{ID: "slow-observer", WebSocket: serverConn}
	observer.StartObserverWriter(Data)
	defer observer.StopObserverWriter()
	mainSession.Observer.Add(observer)

	// 持续推送大帧：先填满观察者队列（256 帧），再填满内核发送缓冲
	frame := make([]byte, 64*1024)
	const rounds = 2000

	start := time.Now()
	for i := 0; i < rounds; i++ {
		SendObData(sessionId, frame)
	}
	elapsed := time.Since(start)

	// 只要 SendObData 是非阻塞投递，2000 次调用就是纯内存操作，远快于秒级。
	// 若退化为同步写，其中一次会一直卡到 10s WriteDeadline 到期。
	if elapsed > 3*time.Second {
		t.Fatalf("%d 次 SendObData 耗时 %v —— 慢观察者仍在阻塞主输出泵", rounds, elapsed)
	}
	t.Logf("%d 次 SendObData（观察者完全不消费）耗时 %v", rounds, elapsed)

	// 观察者被摘除后，后续发送不应再为它付出代价
	if mainSession.Observer.GetById("slow-observer") == nil {
		t.Log("慢观察者已被判定失效并摘除（属预期路径之一）")
	}
}

// TestWriteObserverFrameNeverBlocks 直接验证队列满时丢弃而不阻塞。
func TestWriteObserverFrameNeverBlocks(t *testing.T) {
	const sessionId = "test-frame-session"
	mainSession := &session.Session{ID: sessionId, Observer: session.NewObserver(sessionId)}
	session.GlobalSessionManager.Add(mainSession)
	defer session.GlobalSessionManager.Del(sessionId)

	// 不启动写出循环：队列只进不出，必然填满
	observer := &session.Session{ID: "stuck-observer"}
	observer.StartObserverWriter(Data)
	defer observer.StopObserverWriter()

	// 持续投递远超队列容量（256）的帧数：填满之后必须走 default 分支丢弃，绝不阻塞
	frame := make([]byte, 1024)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 100000; i++ {
			if observer.WriteObserverFrame(frame) {
				return
			}
		}
	}()

	select {
	case <-done:
		t.Log("队列满后仍能持续投递（丢弃语义），未阻塞")
	case <-time.After(5 * time.Second):
		t.Fatal("WriteObserverFrame 发生阻塞")
	}
}
