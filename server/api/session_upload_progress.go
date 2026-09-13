package api

import (
	"fmt"
	"github.com/labstack/echo/v4"
)

type WriteCounter struct {
	Resp  *echo.Response `json:"-"`
	Total uint64         `json:"total"`
}

// Write 累计已写字节数并向前端推送进度。
//
// 注意必须返回 len(p)：io.Writer 的约定是「返回实际消费的字节数」，
// 原实现用命名返回值 n 但从未赋值，恒返回 (0, nil)。当前调用链是
// io.TeeReader（忽略写入结果）因而未暴露，但任何改用 io.Copy 的调用方
// 都会因此得到 ErrShortWrite 或静默截断。
func (wc *WriteCounter) Write(p []byte) (n int, err error) {
	wc.Total += uint64(len(p))
	// 向前端写入进度
	data := fmt.Sprintf("%d㊥", wc.Total)
	_, _ = wc.Resp.Write([]byte(data))
	wc.Resp.Flush()
	return len(p), nil
}
