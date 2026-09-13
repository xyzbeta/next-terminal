package guacamole

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	EnableRecording     = "enable-recording"
	RecordingPath       = "recording-path"
	CreateRecordingPath = "create-recording-path"

	FontName     = "font-name"
	FontSize     = "font-size"
	ColorScheme  = "color-scheme"
	Backspace    = "backspace"
	TerminalType = "terminal-type"

	PreConnectionId   = "preconnection-id"
	PreConnectionBlob = "preconnection-blob"

	EnableDrive              = "enable-drive"
	DriveName                = "drive-name"
	DrivePath                = "drive-path"
	EnableWallpaper          = "enable-wallpaper"
	EnableTheming            = "enable-theming"
	EnableFontSmoothing      = "enable-font-smoothing"
	EnableFullWindowDrag     = "enable-full-window-drag"
	EnableDesktopComposition = "enable-desktop-composition"
	EnableMenuAnimations     = "enable-menu-animations"
	DisableBitmapCaching     = "disable-bitmap-caching"
	DisableOffscreenCaching  = "disable-offscreen-caching"
	// DisableGlyphCaching Deprecated
	DisableGlyphCaching = "disable-glyph-caching"
	ForceLossless       = "force-lossless"

	Domain        = "domain"
	RemoteApp     = "remote-app"
	RemoteAppDir  = "remote-app-dir"
	RemoteAppArgs = "remote-app-args"

	ColorDepth  = "color-depth"
	Cursor      = "cursor"
	SwapRedBlue = "swap-red-blue"
	DestHost    = "dest-host"
	DestPort    = "dest-port"
	ReadOnly    = "read-only"

	UsernameRegex     = "username-regex"
	PasswordRegex     = "password-regex"
	LoginSuccessRegex = "login-success-regex"
	LoginFailureRegex = "login-failure-regex"

	Namespace  = "namespace"
	Pod        = "pod"
	Container  = "container"
	UesSSL     = "use-ssl"
	ClientCert = "client-cert"
	ClientKey  = "client-key"
	CaCert     = "ca-cert"
	IgnoreCert = "ignore-cert"
)

const Delimiter = ';'
const Version = "VERSION_1_4_0"

type Configuration struct {
	ConnectionID string
	Protocol     string
	Parameters   map[string]string
}

func NewConfiguration() (config *Configuration) {
	config = &Configuration{}
	config.Parameters = make(map[string]string)
	return config
}

func (opt *Configuration) SetReadOnlyMode() {
	opt.Parameters[ReadOnly] = "true"
}

func (opt *Configuration) SetParameter(name, value string) {
	opt.Parameters[name] = value
}

func (opt *Configuration) UnSetParameter(name string) {
	delete(opt.Parameters, name)
}

func (opt *Configuration) GetParameter(name string) string {
	return opt.Parameters[name]
}

type Instruction struct {
	Opcode       string
	Args         []string
	ProtocolForm string
}

func NewInstruction(opcode string, args ...string) (ret Instruction) {
	ret.Opcode = opcode
	ret.Args = args
	// 预构建协议形式：原 String() 惰性缓存在值传递下失效（缓存写入拷贝），
	// 改为构造时一次性构建，任何拷贝都直接复用
	ret.ProtocolForm = buildProtocolForm(opcode, args)
	return ret
}

func buildProtocolForm(opcode string, args []string) string {
	form := fmt.Sprintf("%d.%s", len(opcode), opcode)
	for _, value := range args {
		form += fmt.Sprintf(",%d.%s", len(value), value)
	}
	return form + string(Delimiter)
}

func (opt *Instruction) String() string {
	if len(opt.ProtocolForm) > 0 {
		return opt.ProtocolForm
	}
	return buildProtocolForm(opt.Opcode, opt.Args)
}

func (opt *Instruction) Parse(content string) (Instruction, error) {
	if strings.LastIndex(content, ";") > 0 {
		content = strings.TrimRight(content, ";")
	}
	messages := strings.Split(content, ",")

	var args = make([]string, len(messages))
	for i := range messages {
		lm := strings.Split(messages[i], ".")
		if len(lm) != 2 {
			// guacd 畸形帧防护：此前直接取 lm[1] 会 index out of range panic 击穿进程
			return Instruction{}, fmt.Errorf("非法 guacamole 指令段: %q", messages[i])
		}
		args[i] = lm[1]
	}
	return NewInstruction(args[0], args[1:]...), nil
}

type Tunnel struct {
	conn       net.Conn
	reader     *bufio.Reader
	writer     *bufio.Writer
	UUID       string
	Config     *Configuration
	IsOpen     bool
	writeMutex sync.Mutex
}

func NewTunnel(address string, config *Configuration) (ret *Tunnel, err error) {

	conn, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		return
	}

	// 禁用 Nagle 算法，避免小包（按键事件）被延迟合并
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
	}

	// 握手阶段的读超时。
	//
	// guacd 可能接受了 TCP 连接却一个字节都不回（进程假死、上游黑洞路由、
	// 容器网络策略丢弃），此时下面的 expect() 会永久阻塞；而这一阶段的隧道
	// 尚未注册到任何 Session，没有任何路径能解除阻塞——
	// goroutine、TCP 连接、WebSocket 一并永久泄漏。
	//
	// 取值需容纳「guacd 正在连目标机」这段真实耗时：expect("ready") 要等到
	// guacd 与目标建立 RDP/VNC 连接后才返回，慢目标可达数十秒。60s 相对常见
	// 的 RDP 连接超时（约 20s）留有充足余量。
	//
	// ⚠️ deadline 只覆盖握手阶段，成功返回前必须清除（见下方 SetReadDeadline(time.Time{})）。
	// 运行中的主循环**绝对不能**有读超时：GuacamoleHandler 依赖长期静默空闲
	// （画面静止时 guacd 可以长时间不发数据），一超时就会被误判为断线。
	const handshakeTimeout = 60 * time.Second
	_ = conn.SetReadDeadline(time.Now().Add(handshakeTimeout))

	ret = &Tunnel{}
	ret.conn = conn
	// 32KB 缓冲：RDP 图像帧达 MB 级，大缓冲减少 syscall 次数（默认 4096）
	ret.reader = bufio.NewReaderSize(conn, 32*1024)
	ret.writer = bufio.NewWriterSize(conn, 32*1024)
	ret.Config = config

	selectArg := config.ConnectionID
	if selectArg == "" {
		selectArg = config.Protocol
	}

	if err := ret.WriteInstructionAndFlush(NewInstruction("select", selectArg)); err != nil {
		_ = conn.Close()
		return nil, err
	}

	args, err := ret.expect("args")
	if err != nil {
		_ = conn.Close()
		return
	}

	width := config.GetParameter("width")
	height := config.GetParameter("height")
	dpi := config.GetParameter("dpi")

	// send size
	if err := ret.WriteInstructionAndFlush(NewInstruction("size", width, height, dpi)); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := ret.WriteInstructionAndFlush(NewInstruction("audio", "audio/L8", "audio/L16")); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := ret.WriteInstructionAndFlush(NewInstruction("video")); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := ret.WriteInstructionAndFlush(NewInstruction("image", "image/webp", "image/png", "image/jpeg")); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := ret.WriteInstructionAndFlush(NewInstruction("timezone", "Asia/Shanghai")); err != nil {
		_ = conn.Close()
		return nil, err
	}

	parameters := make([]string, len(args.Args))
	for i := range args.Args {
		argName := args.Args[i]
		if strings.Contains(argName, "VERSION") {
			parameters[i] = Version
			continue
		}
		parameters[i] = config.GetParameter(argName)
	}
	// send connect
	if err := ret.WriteInstructionAndFlush(NewInstruction("connect", parameters...)); err != nil {
		_ = conn.Close()
		return nil, err
	}

	ready, err := ret.expect("ready")
	if err != nil {
		// 与其他 8 处早退分支一致：必须关闭连接。
		// 原实现此处是裸 return，是全部早退分支中唯一漏掉 Close 的，
		// guacd 返回异常时该 TCP 连接与它上面的 bufio 缓冲一并泄漏。
		_ = conn.Close()
		return
	}

	// 握手完成，清除读 deadline 再交给主循环（见上方 SetReadDeadline 处的说明）
	_ = conn.SetReadDeadline(time.Time{})

	if len(ready.Args) == 0 {
		_ = conn.Close()
		return nil, errors.New("no connection id received")
	}

	ret.UUID = ready.Args[0]
	ret.IsOpen = true
	return ret, nil
}

func (opt *Tunnel) WriteInstructionAndFlush(instruction Instruction) error {
	if _, err := opt.WriteAndFlush([]byte(instruction.String())); err != nil {
		return err
	}
	return nil
}

func (opt *Tunnel) WriteAndFlush(p []byte) (int, error) {
	opt.writeMutex.Lock()
	defer opt.writeMutex.Unlock()
	// 写 deadline 防悬挂：guacd 僵死（写缓冲塞满/录屏盘满）时写操作不再永久阻塞
	_ = opt.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	nn, err := opt.writer.Write(p)
	if err != nil {
		return nn, err
	}
	err = opt.writer.Flush()
	if err != nil {
		return nn, err
	}
	return nn, nil
}

func (opt *Tunnel) ReadInstruction() (instruction Instruction, err error) {
	msg, err := opt.Read()
	if err != nil {
		return instruction, err
	}
	return instruction.Parse(string(msg))
}

func (opt *Tunnel) Read() (p []byte, err error) {
	data, err := opt.reader.ReadBytes(Delimiter)
	if err != nil {
		return
	}
	// 先比长度，再决定是否转 string。
	//
	// 这两个「静音音频帧」常量的长度都是 22 字节，而绝大多数帧（尤其是 RDP 图像帧，
	// 单帧可达 MB 级）长度都不匹配。原实现对每一帧都做一次 string(data) 全量拷贝，
	// 仅仅为了和两个常量做比较——1080p 30fps 下等于每秒几十 MB 的纯 memcpy 与瞬态垃圾。
	// len(常量) 是编译期求值，不产生分配。
	if len(data) == len("rate=44100,channels=2;") {
		switch string(data) {
		case "rate=44100,channels=2;", "rate=22050,channels=2;":
			return make([]byte, 0), nil
		}
	}
	// 该分支需要修改内容，长度不匹配时才做一次判断
	if len(data) == len("5.audio,1.1,31.audio/L16;") && string(data) == "5.audio,1.1,31.audio/L16;" {
		data = append(data, []byte("rate=44100,channels=2;")...)
	}
	// 直接返回原始字节（原实现 string(data)→[]byte(s) 每帧双拷贝，RDP 图像帧达 MB 级）
	return data, err
}

func (opt *Tunnel) expect(opcode string) (instruction Instruction, err error) {
	instruction, err = opt.ReadInstruction()
	if err != nil {
		return instruction, err
	}

	if opcode != instruction.Opcode {
		msg := fmt.Sprintf(`expected "%s" instruction but instead received "%s"`, opcode, instruction.Opcode)
		return instruction, errors.New(msg)
	}
	return instruction, nil
}

func (opt *Tunnel) Close() error {
	opt.IsOpen = false
	return opt.conn.Close()
}

func Disconnect(ws *websocket.Conn, code int, reason string) {
	// nil 防护：宽限期内 ws 已置空，不再向 nil 连接写
	if ws == nil {
		return
	}
	// guacd 无法处理中文字符，所以进行了base64编码。
	encodeReason := base64.StdEncoding.EncodeToString([]byte(reason))
	err := NewInstruction("error", encodeReason, strconv.Itoa(code))
	_ = ws.WriteMessage(websocket.TextMessage, []byte(err.String()))
	disconnect := NewInstruction("disconnect")
	_ = ws.WriteMessage(websocket.TextMessage, []byte(disconnect.String()))
}
