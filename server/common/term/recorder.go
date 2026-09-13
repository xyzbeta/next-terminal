package term

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"next-terminal/server/utils"
)

type Env struct {
	Shell string `json:"SHELL"`
	Term  string `json:"TERM"`
}

type Header struct {
	Title     string `json:"title"`
	Version   int    `json:"version"`
	Height    int    `json:"height"`
	Width     int    `json:"width"`
	Env       Env    `json:"env"`
	Timestamp int    `json:"Timestamp"`
}

type Recorder struct {
	File      *os.File
	Writer    *bufio.Writer // 缓冲写出：录屏为批量写路径，减少裸写 syscall，慢盘不再阻塞 flush
	Timestamp int
}

func (recorder *Recorder) Close() {
	if recorder.Writer != nil {
		_ = recorder.Writer.Flush()
	}
	if recorder.File != nil {
		_ = recorder.File.Close()
	}
}

func (recorder *Recorder) WriteHeader(header *Header) (err error) {
	var p []byte

	if p, err = json.Marshal(header); err != nil {
		return
	}

	if _, err := recorder.Writer.Write(p); err != nil {
		return err
	}
	if _, err := recorder.Writer.Write([]byte("\n")); err != nil {
		return err
	}

	recorder.Timestamp = header.Timestamp

	return
}

func (recorder *Recorder) WriteData(data string) (err error) {
	now := int(time.Now().UnixNano())

	delta := float64(now-recorder.Timestamp*1000*1000*1000) / 1000 / 1000 / 1000

	row := make([]interface{}, 0)
	row = append(row, delta)
	row = append(row, "o")
	row = append(row, data)

	var s []byte
	if s, err = json.Marshal(row); err != nil {
		return
	}
	if _, err := recorder.Writer.Write(s); err != nil {
		return err
	}
	if _, err := recorder.Writer.Write([]byte("\n")); err != nil {
		return err
	}
	return
}

func NewRecorder(recordingPath, term string, h int, w int) (recorder *Recorder, err error) {
	recorder = &Recorder{}
	parentDirectory := utils.GetParentDirectory(recordingPath)
	if utils.FileExists(parentDirectory) {
		if err := os.RemoveAll(parentDirectory); err != nil {
			return nil, err
		}
	}

	if err = os.MkdirAll(parentDirectory, 0777); err != nil {
		return
	}

	var file *os.File
	file, err = os.Create(recordingPath)
	if err != nil {
		return nil, err
	}

	recorder.File = file
	recorder.Writer = bufio.NewWriterSize(file, 32*1024)

	header := &Header{
		Title:     "",
		Version:   2,
		Height:    h,
		Width:     w,
		Env:       Env{Shell: "/bin/bash", Term: term},
		Timestamp: int(time.Now().Unix()),
	}

	if err := recorder.WriteHeader(header); err != nil {
		// 写头失败时必须关掉已打开的文件，否则这个 *os.File 会被丢弃且永不回收
		// （调用方拿到的是 nil recorder，无从释放）。recorder.Writer 是包在它上面的
		// bufio，关掉 file 即可。
		_ = file.Close()
		return nil, err
	}

	return recorder, nil
}

// NewRecorderAppend 以**追加**模式打开既有录屏（tmux 重连续录用）。
//
// 与 NewRecorder 的关键差异：
//   · 绝不 RemoveAll 父目录 —— 那是「新建」语义，会把旧录屏连目录一起删掉
//     （NewRecorder 对录屏路径的父目录执行 os.RemoveAll 是本项目已知陷阱，见 CLAUDE.md）；
//   · 不重写 cast 头：首行 header 已存在，追加的每条数据行按其 Timestamp 计算 delta，
//     这里读回首行恢复 recorder.Timestamp，保证续录的时间轴连续；
//   · 文件不存在或头损坏时回退为新建（返回 nil 由调用方走 NewRecorder）。
func NewRecorderAppend(recordingPath, term string, h, w int) (recorder *Recorder, err error) {
	if !utils.FileExists(recordingPath) {
		return nil, fmt.Errorf("recording not exists")
	}
	file, err := os.OpenFile(recordingPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}

	recorder = &Recorder{File: file, Writer: bufio.NewWriterSize(file, 32*1024)}

	// 读首行 header 恢复时间基准
	fr, err := os.Open(recordingPath)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	defer fr.Close()
	br := bufio.NewReader(fr)
	line, err := br.ReadString('\n')
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	var header Header
	if err := json.Unmarshal([]byte(line), &header); err != nil {
		_ = file.Close()
		return nil, err
	}
	recorder.Timestamp = header.Timestamp
	return recorder, nil
}
