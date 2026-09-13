import React, {Suspense, lazy, useEffect, useMemo, useRef, useState} from 'react';
import {useNavigate, useSearchParams} from "react-router-dom";
import {Terminal} from "xterm";
import {FitAddon} from "xterm-addon-fit";
import {getToken} from "../../utils/utils";
import {uploadToSession} from "../../utils/upload";
import request from "../../common/request";
import {Affix, Button, Drawer, Dropdown, Menu, message, Modal, Popover, Select, Space, Typography} from "antd";
import Message from "./Message";
import qs from "qs";
import {server, wsServer} from "../../common/env";
import Draggable from "react-draggable";
import {
    CloseOutlined,
    CodeOutlined,
    ControlOutlined,
    DisconnectOutlined,
    FontSizeOutlined,
    FolderOutlined,
    LineChartOutlined,
    MenuOutlined,
    ThunderboltOutlined,
    VerticalAlignBottomOutlined,
} from "@ant-design/icons";
import FileSystem from "../devops/FileSystem";
import "xterm/css/xterm.css"
import Stats from "./Stats";
import {debounce} from "../../utils/fun";
import commandApi from "../../api/command";
import strings from "../../utils/strings";
import workCommandApi from "../../api/worker/command";
import {xtermScrollPretty} from "../../utils/xterm-scroll-pretty";
import {getClientName} from "../../utils/window";
import {useIsMobile} from "../../hook/use-breakpoint";
import {lockTerminalPage, unlockTerminalPage} from "../../utils/term-page-lock";
// ⚠️ 版本必须与 xterm 主版本配套：本项目 xterm 为 4.19.0，对应 addon 的 0.11/0.12 线
// （0.14+ 的 peer 是 xterm ^5.0.0，装了会导致终端错位/露白底 —— 见 init() 内的说明）
import {WebglAddon} from 'xterm-addon-webgl';
// remark-gfm 是 ESM-only 包，CRA 5 的 webpack 无法正确解析，改用纯 react-markdown 渲染

const {Text} = Typography;

// 懒加载：MD 渲染（仅在预览时加载）
const ReactMarkdown = lazy(() => import('react-markdown'));

// 文件扩展名 → 预览类型映射
const TEXT_EXTENSIONS = new Set([
  'go','py','js','ts','jsx','tsx','java','rb','php','c','cpp','h','hpp',
  'rs','swift','kt','scala','pl','pm','lua','r','m','mm',
  'sh','bash','zsh','fish','ps1','bat','cmd',
  'json','xml','yaml','yml','toml','ini','cfg','conf','env','properties',
  'txt','log','csv','tsv','sql','css','scss','less','sass',
  'md','rst','asciidoc','adoc',
  'dockerfile','makefile','gradle',
  'diff','patch','proto',
]);
const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp']);

// 文本/代码预览体积上限：超过则不渲染预览，改为提示下载。
// 预览是「整个文件一个 <pre> + 行号列」的同步渲染，5MB 日志 ≈ 10 万行，
// 一次性渲染会长时间阻塞主线程（终端页同时在跑 xterm 渲染与 WebSocket 读循环）。
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

// —— OSC 52 剪贴板协议（TUI 复制支持）——
// Claude Code 等 TUI 的"复制"通过 OSC 52 序列（ESC]52;<selection>;<base64>）发给终端，要求写入系统剪贴板。
// xterm 4.x 会静默丢弃该序列，这里在数据进入 xterm 前解析并写入浏览器剪贴板。
//
// 解析按 OSC 通用语法：ESC ] 52 ; 之后到首个 BEL(\x07) 或 ST(ESC \) 为止都是载荷。
// 不要用窄字符类匹配载荷：selection 可为空（协议允许）、载荷可能是查询符 '?'
// （tmux/Zellij 会发）。匹配失败的序列一旦被当作"残片"缓存，其后所有输出就永不上屏（终端假死）。
const OSC52_HEAD = '\x1b]52;';
const OSC52_RE = /\x1b\]52;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// 残片缓存硬上限：超出即放弃缓存并原样上屏，保证"最多扣留 4KB、绝不永久扣留"
const OSC52_PENDING_MAX = 4096;
let osc52Pending = ''; // 跨 WebSocket 帧被截断的 OSC 52 残片

// 单次写入剪贴板的文本上限：远端可在无用户手势下覆写剪贴板，限额降低被植入长文本的风险
const CLIPBOARD_MAX = 64 * 1024;

// 兼容 http 部署（navigator.clipboard 不存在）的兜底：textarea + execCommand
const fallbackClipboard = (text) => {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    } catch (e) { /* 剪贴板被拒时仅本次复制失败，不干扰终端 */ }
};

const writeClipboard = (text) => {
    if (!text) return;
    if (text.length > CLIPBOARD_MAX) {
        text = text.slice(0, CLIPBOARD_MAX);
    }
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(() => fallbackClipboard(text));
    } else {
        fallbackClipboard(text);
    }
};

// 从输出流中剥出 OSC 52 序列并写剪贴板；其余字节原样透传（层内过滤，不产生新网络数据）
const handleOsc52 = (str) => {
    const textAll = osc52Pending + str;
    osc52Pending = '';
    let copied = null;
    let text = textAll.replace(OSC52_RE, (match, payload) => {
        const sep = payload.indexOf(';');
        const selector = sep >= 0 ? payload.slice(0, sep) : payload;
        const b64 = sep >= 0 ? payload.slice(sep + 1) : '';
        if (!b64) return '';                                  // 只读/清空请求：剥除不上屏
        if (b64 === '?') return '';                           // OSC 52 查询（tmux/Zellij 会发）：剥除但不写剪贴板
        if (selector !== '' && selector !== 'c') return '';    // p/s 等其它 selection：剥除，不写系统剪贴板
        let decoded = '';
        try {
            // OSC 52 载荷是 UTF-8 文本的 base64。atob 只按 Latin-1 逐字符还原，
            // 中文会变乱码，必须还原成字节数组后按 UTF-8 解码
            const binary = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ''));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            decoded = new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
            decoded = ''; // 载荷非法：序列本身仍是合法的 OSC 52 语法，照剥不误（不上屏）
        }
        if (decoded) copied = decoded;
        return '';
    });
    // 残尾缓存：只有「尾部从 OSC52 头开始、且还没出现终止符」才是被帧边界截断的残片。
    // 已经含终止符的序列说明是完整内容（含非法 base64 的透传），绝不能缓存——
    // 否则每次拼帧都会把同一段重新捞回缓存，永不上屏、无界增长。
    const tailIdx = text.lastIndexOf(OSC52_HEAD);
    if (tailIdx >= 0) {
        const tail = text.slice(tailIdx);
        const body = tail.slice(OSC52_HEAD.length);
        if (tail.length <= OSC52_PENDING_MAX && !/\x07|\x1b\\/.test(body)) {
            osc52Pending = tail;
            text = text.slice(0, tailIdx);
        }
    }
    return {text, copied};
};

// 剪贴板图片 → 上传主机 → @路径写入剪贴板（供 Claude Code 附件引用；普通 SSH 零污染）
const MIME_EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif'};
// 上传体积上限（后端无 BodyLimit，前端先挡，避免慢链路粘贴大图无反馈地卡住）
const PASTE_UPLOAD_MAX = 10 * 1024 * 1024;

// Monaco Editor 语言映射（扩展名 → language ID）
const EXT_TO_MONACO_LANG = {
  'go':'go','py':'python','js':'javascript','ts':'typescript','jsx':'javascript','tsx':'typescript',
  'java':'java','rb':'ruby','c':'c','cpp':'cpp','h':'c','hpp':'cpp',
  'rs':'rust','swift':'swift','kt':'kotlin','sh':'shell','bash':'shell','zsh':'shell',
  'json':'json','xml':'xml','yaml':'yaml','yml':'yaml','toml':'ini','ini':'ini','cfg':'ini','conf':'ini',
  'css':'css','scss':'scss','sql':'sql','md':'markdown',
  'dockerfile':'dockerfile','makefile':'makefile',
  'log':'plaintext','txt':'plaintext','csv':'plaintext','tsv':'plaintext',
  'yaml':'yaml','yml':'yaml','env':'plaintext','properties':'ini',
  'diff':'diff','patch':'diff',
};

// 终端字号的取值范围与持久化键。
//
// 为什么必须有字号调节：index.html 出于「避免与终端自适应尺寸计算打架」的考虑
// 禁用了页面双指缩放（user-scalable=no），因此字号是手机上唯一的放大手段。
// 默认 15px 在桌面合适，但在 390px 宽的手机上，Claude Code 这类 TUI 的密集输出
// 会挤成一片、难以阅读。
// 「断开连接」后的看门狗定时器。
//
// 存在的理由：用户实测「点断开后整个页面白屏，必须手动刷新」——而该路径在本地
// （Chromium 移动视口）反复测试都正常，无法复现，成因未知。与其赌某一种猜测的修法，
// 不如给一条**必然可恢复**的兜底：4 秒内目标页若没渲染出内容，就整页重载到列表页。
// 用户一直是靠手动刷新恢复的，这条兜底只是把他那一步自动化。
//
// 放在**模块级**而不是组件内 ref：页面白屏时 React 树可能已经整棵卸载，
// 挂在组件上的定时器会被 cleanup 一起清掉，兜底就永远不会触发。
let disconnectWatchdog = null;

const FONT_SIZE_KEY = 'nt_term_font_size';
const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20, 22];
const DEFAULT_FONT_SIZE = 15;

const loadFontSize = () => {
    try {
        const v = parseInt(window.localStorage.getItem(FONT_SIZE_KEY), 10);
        return FONT_SIZES.includes(v) ? v : DEFAULT_FONT_SIZE;
    } catch (e) {
        return DEFAULT_FONT_SIZE;
    }
};

const Term = () => {

    const [searchParams] = useSearchParams();
    // SPA 导航：断开后回到在线会话列表。**不能用 window.location.href** ——
    // PWA standalone 下对绝对路径赋值可能触发整页重载，而重载会重新走一遍
    // 「冷启动 → chunk 加载」，正好踩中路由 chunk 挂起（表现为白屏，必须再刷一次）。
    const navigate = useNavigate();
    const assetId = searchParams.get('assetId');
    const assetName = searchParams.get('assetName');
    const isWorker = searchParams.get('isWorker');
    // 从会话列表「继续」进入时带上：复用既有会话，而不是新建一个。
    const resumeSessionId = searchParams.get('sessionId');
    const isMobile = useIsMobile();

    // 这两个 ref 必须在 viewportBox 之前声明：viewportBox 会读 rootRef.current，
    // 若声明顺序颠倒，首次渲染调用 useState(viewportBox) 时会命中 TDZ 直接崩页
    const rootRef = useRef(null); // 终端根容器：尺寸由 CSS 动态视口决定，ResizeObserver 读取实际值
    const connectWsRef = useRef(null); // init 内的连接函数，供网络恢复事件随时触发重连
    const scrollBottomRef = useRef(null); // init 内的「跳到底部」，供悬浮菜单调用

    // 终端可用尺寸：优先取根容器的实际渲染尺寸。
    // 容器高度由 CSS 100dvh 决定（浏览器随软键盘精确收缩），比读 visualViewport 可靠 ——
    // 后者在 Android 上常比真实可用空间偏小，会在键盘上方留下一条空白。
    const viewportBox = () => {
        const el = rootRef.current;
        if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                return {width: Math.round(rect.width), height: Math.round(rect.height)};
            }
        }
        return {width: window.innerWidth, height: window.innerHeight};
    };

    const [box, setBox] = useState(viewportBox);

    const [commands, setCommands] = useState([]);
    const [latency, setLatency] = useState(null); // 延迟 ms，null = 尚未测量
    const [aliveStatus, setAliveStatus] = useState('connecting'); // connecting | alive | slow | offline
    // 会话保持（tmux）状态：由服务端 Connected 消息的 content 解析而来。
    // {keep, attached, reattached} —— 前端据此显示徽标，让用户确认当前连接走的是 tmux。
    const [keepInfo, setKeepInfo] = useState(null);
    const [previewVisible, setPreviewVisible] = useState(false);
    const [previewUrl, setPreviewUrl] = useState('');
    const [previewTitle, setPreviewTitle] = useState('');
    const [previewType, setPreviewType] = useState('image'); // image | pdf | html | md | code
    const [markdownContent, setMarkdownContent] = useState('');
    const [textContent, setTextContent] = useState('');
    const [textLanguage, setTextLanguage] = useState('plaintext');

    // 预览文本的分行结果：此前在 JSX 里每次渲染都 split('\n')，大文件下是每帧一次全量拷贝。
    // 依赖只有 textContent，预览关闭时 textContent 为空串，开销可忽略。
    const textLines = useMemo(() => (textContent ? textContent.split('\n') : []), [textContent]);
    // 行号列文本：单个 <pre> + '\n' 分隔，替代原先「每行一个 <div>」的 N 个 DOM 节点。
    // （CSS counter-increment 仍需每行一个元素才能递增，无法把节点数降到 1，故用 <pre> 承载。）
    const lineNumbersText = useMemo(
        () => textLines.map((_, i) => i + 1).join('\n'),
        [textLines]
    );

    const [term, setTerm] = useState();
    const [fitAddon, setFitAddon] = useState();
    const [websocket, setWebsocket] = useState();
    const [session, setSession] = useState({});

    const [fileSystemVisible, setFileSystemVisible] = useState(false);
    const [statsVisible, setStatsVisible] = useState(false);
    const [enterBtnZIndex, setEnterBtnZIndex] = useState(999);
    const [queryInterval, setQueryInterval] = useState(5000);
    const [shortcutPopoverOpen, setShortcutPopoverOpen] = useState(false);

    // 文件选择器状态（必须在组件顶层，不能放在 init 内部——React Hooks 规则）
    const [pickerVisible, setPickerVisible] = useState(false);
    const [pickerInput, setPickerInput] = useState('');
    const [pickerResults, setPickerResults] = useState([]);
    const [pickerIndex, setPickerIndex] = useState(0);
    const pickerInputRef = useRef(null);
    const pickerTimerRef = useRef(null);
    const pickerListRef = useRef(null);
    const sessionIdRef = useRef(''); // init 中设置，供组件层函数使用
    const wsRef = useRef(null);      // 当前 WebSocket，供卸载/切换资产清理（state 闭包会过期）
    const termRef = useRef(null);    // 当前 xterm 实例，供卸载时 dispose
    const [fontSize, setFontSize] = useState(loadFontSize);
    const [fontPanelOpen, setFontPanelOpen] = useState(false);
    // 断线重连状态
    const reconnectTimerRef = useRef(null);  // 重连退避定时器
    const reconnectAttemptsRef = useRef(0);  // 连续重连次数（上限 5）
    const manualCloseRef = useRef(false);    // 用户主动关闭（卸载/切资产）不重连
    const closedByServerRef = useRef(false); // 收到服务端 Closed 消息后不重连
    const reconnectTokenRef = useRef('');    // 重连令牌（HMAC，会话存活期有效）

    const lsAbortRef = useRef(null);
    // Mobile IME guard: fit() during composition breaks IME input (mobile keyboards
    // deliver all input via composition events). Defer fit/resize until composition ends.
    const composingRef = useRef(false);
    const pendingFitRef = useRef(false);
    const composingTimerRef = useRef(null);
    const pendingFitTimerRef = useRef(null); // 组合输入期间延迟重排的兜底定时器
    const osc52NoticeRef = useRef(false); // OSC 52 写入剪贴板的提示只弹一次
    const compositionCleanupRef = useRef(null); // init 内注册的 IME 监听清理函数（切资产时移除）
    const [mobileActionsOpen, setMobileActionsOpen] = useState(false); // 移动端浮动按钮是否展开（默认收起，避免遮挡终端）
    const [mobileKeypadOpen, setMobileKeypadOpen] = useState(false); // 移动端 TUI 按键条
    const [keypadMoreOpen, setKeypadMoreOpen] = useState(false);      // 按键条第二层（低频键）
    // tmux 会话标记 ref：init 闭包内的触摸滚动逻辑需要读此值判断是否走 SGR 滚轮。
    // 不能直接读 keepInfo state——init 只在 assetId 变化时运行，state 闭包永远捕获初始 null。
    const keepAliveRef = useRef(false);

    const fetchPickerResults = (partial) => {
        // 取消上一次未完成的请求，防止旧结果覆盖新结果
        if (lsAbortRef.current) lsAbortRef.current.abort();
        lsAbortRef.current = new AbortController();
        const lsUrl = `${server}/sessions/${sessionIdRef.current}/ls`;
        fetch(lsUrl, {
            method: 'POST',
            // 令牌走请求头而非 URL query，避免进入反代/网关访问日志
            headers: {'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Token': getToken()},
            body: `partial=${encodeURIComponent(partial)}`,
            signal: lsAbortRef.current.signal
        })
        .then(r => r.json())
        .then(result => {
            if (result.code === 1) setPickerResults(result.data || []);
            else setPickerResults([]);
        })
        .catch(err => {
            if (err.name !== 'AbortError') setPickerResults([]);
        });
    };

    const doPreview = async (filePath) => {
        const token = getToken();
        const ext = filePath.split('.').pop().toLowerCase();
        // 预览地址同时要喂给 <img src> / <iframe src>（无法携带自定义请求头），
        // 因此这里保留 query 传令牌；纯 fetch 的请求一律走请求头
        const apiUrl = `${server}/sessions/${sessionIdRef.current}/preview?file=${encodeURIComponent(filePath)}&X-Auth-Token=${token}&t=${Date.now()}`;
        setPreviewTitle(filePath);

        if (IMAGE_EXTENSIONS.has(ext)) {
            setPreviewType('image');
            setPreviewUrl(apiUrl);
            setPreviewVisible(true);
            return;
        }
        if (ext === 'pdf') {
            setPreviewType('pdf');
            setPreviewUrl(apiUrl);
            setPreviewVisible(true);
            return;
        }
        if (ext === 'html') {
            // HTML 安全：后端已返回 text/plain，前端再加 iframe sandbox 双重防护
            setPreviewType('html');
            setPreviewUrl(apiUrl);
            setPreviewVisible(true);
            return;
        }
        if (ext === 'md') {
            try {
                const resp = await fetch(apiUrl);
                const text = await resp.text();
                setMarkdownContent(text);
                setPreviewType('md');
                setPreviewVisible(true);
            } catch (e) {
                message.error('加载 Markdown 文件失败');
            }
            return;
        }
        // 代码/文本文件
        try {
            const resp = await fetch(apiUrl);
            const text = await resp.text();
            // 体积阈值：超大文本不渲染预览（避免十万级 DOM 节点卡死终端页），改为提示下载
            if (text.length > MAX_TEXT_PREVIEW_BYTES) {
                Modal.confirm({
                    title: '文件过大，无法预览',
                    content: `该文件约 ${formatSize(text.length)}，超过 ${formatSize(MAX_TEXT_PREVIEW_BYTES)} 的预览上限，建议下载后查看。`,
                    okText: '下载',
                    cancelText: '取消',
                    onOk: () => {
                        const a = document.createElement('a');
                        a.href = apiUrl;
                        a.download = filePath.split('/').pop() || 'download';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                    },
                });
                return;
            }
            setTextContent(text);
            setTextLanguage(EXT_TO_MONACO_LANG[ext] || 'plaintext');
            setPreviewType('code');
            setPreviewVisible(true);
        } catch (e) {
            message.error('加载文件失败');
        }
    };

    const formatSize = (bytes) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    };

    // 打开文件选择器（键盘快捷键和快捷命令菜单共用）
    // 从 pickerInput + 文件对象拼出完整路径
    const resolvePickerPath = (input, file) => {
        const ls = input.lastIndexOf('/');
        const dp = ls >= 0 ? input.substring(0, ls + 1) : '';
        return dp + file.name;
    };

    const openFilePicker = () => {
        if (!sessionIdRef.current) return; // 会话未就绪
        setPickerVisible(true);
        setPickerInput('');
        setPickerResults([]);
        setPickerIndex(0);
        fetchPickerResults('');
    };

    // 键盘上下导航时自动滚动列表，保持选中项可见
    useEffect(() => {
        if (!pickerVisible || !pickerListRef.current) return;
        const items = pickerListRef.current.children;
        if (pickerIndex < items.length) {
            items[pickerIndex].scrollIntoView({ block: 'nearest' });
        }
    }, [pickerIndex, pickerVisible]);

    const createSession = async (assetsId) => {
        let result = await request.post(`/sessions?assetId=${assetsId}&mode=native`);
        if (result['code'] !== 1) {
            return [undefined, result['message']];
        }
        // 断线重连令牌：存 sessionStorage 供页面刷新后重连使用
        const data = result['data'];
        if (data && data['id'] && data['reconnectToken']) {
            sessionStorage.setItem(`rt-${data['id']}`, data['reconnectToken']);
            reconnectTokenRef.current = data['reconnectToken'];
        }
        return [data, ''];
    }

    const writeErrorMessage = (term, message) => {
        term.writeln(`\x1B[1;3;31m${message}\x1B[0m `);
    }

    const updateSessionStatus = async (sessionId) => {
        let result = await request.post(`/sessions/${sessionId}/connect`);
        if (result['code'] !== 1) {
            message.error(result['message']);
        }
    }

    const writeCommand = (command) => {
        if (websocket) {
            websocket.send(new Message(Message.Data, command));
        }
    }

    // TUI 交互键（分组）。
    //
    // 设计原则：**只放软键盘没有的键**，且常用键必须「不滑动就能点到」。
    //
    // 为什么是这两条：
    //   · 软键盘已有字母/数字/回车/退格/空格，把它们放进按键条是纯粹的浪费——
    //     原实现里的「回车」就是一例（用户按下它是为了补全软键盘吗？不是，
    //     软键盘本来就有）。按键条只应提供软键盘**没有**的能力。
    //   · 上一版把 23 个键排成一行横向滚动，实测每次按 Ctrl+C 之类的键都要先滑一段，
    //     效率反而低于原生的 7 个键。手机屏幕宽 390px，一行最多舒适容纳 6~7 个键，
    //     超过就必须分页或分层。
    //
    // 因此分两层：
    //   PRIMARY —— 6 个高频键，常驻且一行放得下，任何操作都不用滑动；
    //   MORE    —— 其余低频键，点「⋯」后在**上方**展开一层（横向可滚）。
    // 2026-09-12 按用户反馈调整：
    //   ① 方向键与 Enter/Tab 提到主层常驻 —— 在 Claude Code 这类 TUI 里，
    //      「上下选题 / 左右移光标 / Tab 补全 / Enter 确认」是每一步都在用的动作，
    //      原来放在第二层要先点「⋯」再滑，等于每次操作都多两步。
    //   ② Esc / Ctrl+C / ⇧Tab 让出主层位置，移到第二层最前（仍是滑动后第一屏可见）。
    const TUI_KEYS_PRIMARY = [
        {label: '↑', seq: '\x1b[A', title: '上一条 / 上移'},
        {label: '↓', seq: '\x1b[B', title: '下一条 / 下移'},
        {label: '←', seq: '\x1b[D', title: '左移光标'},
        {label: '→', seq: '\x1b[C', title: '右移光标'},
        {label: 'Tab', seq: '\t', title: '补全'},
        {label: 'Enter', seq: '\r', title: '回车 / 确认'},
    ];

    const TUI_KEYS_MORE = [
        {label: 'Esc', seq: '\x1b', title: '取消 / 关闭'},
        {label: 'Ctrl+C', seq: '\x03', title: '中断当前生成'},
        {label: '⇧Tab', seq: '\x1b[Z', title: '切换模式（普通/自动接受/计划）'},
        {label: '\\', seq: '\\', title: '反斜杠：与软键盘回车配合可输入多行'},
        {label: 'Ctrl+D', seq: '\x04', title: '退出 / EOF'},
        {label: 'Ctrl+L', seq: '\x0c', title: '清屏'},
        {label: 'Ctrl+R', seq: '\x12', title: '搜索历史'},
        {label: 'Ctrl+U', seq: '\x15', title: '清空当前行'},
        {label: 'Ctrl+K', seq: '\x0b', title: '删除到行尾'},
        {label: 'Ctrl+W', seq: '\x17', title: '删除前一个词'},
        {label: 'Ctrl+A', seq: '\x01', title: '移到行首'},
        {label: 'Ctrl+E', seq: '\x05', title: '移到行尾'},
        {label: 'Ctrl+Z', seq: '\x1a', title: '挂起'},
        {label: 'PgUp', seq: '\x1b[5~'},
        {label: 'PgDn', seq: '\x1b[6~'},
        {label: 'Home', seq: '\x1b[H'},
        {label: 'End', seq: '\x1b[F'},
    ];

    const sendTuiKey = (seq) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(new Message(Message.Data, seq).toString());
        }
    };

    // 断开连接并返回系统页面。
    // 终端页通常由系统页面「新开标签」进入：桌面浏览器可关标签页回到系统，
    // 但 PWA（添加到主屏）运行在无标签栏的独立窗口里 —— 既无法切回系统页面，
    // 也无法用关闭标签的方式断开 SSH。这里提供一个页面内的出口。
    const disconnectAndBack = () => {
        manualCloseRef.current = true; // 主动关闭，不触发自动重连
        if (wsRef.current) {
            try {
                wsRef.current.close();
            } catch (e) {
                /* 忽略关闭异常 */
            }
        }
        // 主动还原文档全局样式，不依赖 React 卸载 cleanup 的时机与完整性
        unlockTerminalPage();

        // 整页重载到列表页，而不是 SPA 导航。
        //
        // 为什么改回来：断开白屏修了两条 SPA 路径（location.href、navigate）都未根治，
        // 且本地无法复现 —— 说明风险在「终端页卸载时对文档全局状态的清理」这一类
        // 无法在本地完整模拟的路径上。整页重载让浏览器自己重置键盘/滚动/缩放/样式，
        // 把这一整类未知风险绕开；而启动路径已在前几轮加固（SW 缓存优先 + RouteFallback
        // 15s 自愈 + 数据驱动跳转），重载现在是可靠的。
        //
        // 看门狗保留：重载后若列表页仍未渲染（冷启动异常），6 秒后自动再重载一次。
        // 定时器挂在模块级 —— 页面重载会把它一并销毁，不会误触发新页面。
        if (disconnectWatchdog) {
            clearTimeout(disconnectWatchdog);
        }
        disconnectWatchdog = setTimeout(() => {
            disconnectWatchdog = null;
            const root = document.getElementById('root');
            if (root && root.innerText.replace(/\s/g, '').length < 20) {
                window.location.hash = '#/online-session';
                window.location.reload();
            }
        }, 6000);
        window.location.hash = '#/online-session';
        window.location.reload();
    };

    // 说明：回看历史改用终端的「手指上下滑动 → 滚轮」手势实现（见 init 内的触摸处理），
    // 不再提供翻页按钮——按钮需要展开悬浮菜单才能点到，反而妨碍随时查看。

    const getCommands = async () => {
        if (strings.hasText(isWorker)) {
            let items = await workCommandApi.getAll();
            setCommands(items);
        } else {
            let items = await commandApi.getAll();
            setCommands(items);
        }
    }

    const focus = () => {
        if (term) {
            term.focus();
        }
    }

    // 重排 + 强制整屏重绘。所有 fit 都必须走这里，不要直接调 fitAddon.fit()。
    //
    // 为什么必须补一次 refresh：WebGL 渲染器有独立的画布层与字形图集，
    // 容器尺寸变化时它会按新尺寸重建画布，但**已经绘制过的区域不会自动重画**——
    // 容器被拉高的那部分就留下未绘制区域，即用户看到的「露白底」。
    // 软键盘弹出/收起会让容器高度在 200~300ms 内剧变，正是最容易命中的场景
    // （上一轮把 WebGL 整个移除，就是把这个问题误判成了「WebGL 不适合移动端」）。
    //
    // refresh 请求的是整屏重绘，走 GPU 的成本极低；只在尺寸变化时调用，不影响常态性能。
    const fit = () => {
        if (!fitAddon) {
            return;
        }
        fitAddon.fit();
        const t = termRef.current;
        if (t && t.rows > 0) {
            t.refresh(0, t.rows - 1);
        }
    }

    // 调整终端字号。
    //
    // 三步缺一不可：
    //   ① xterm 改字号 → ② fitAddon 重算行列 → ③ 把新的行列数发给远端。
    // 漏掉 ③ 时远端 PTY 仍按旧宽度渲染，Claude Code 这类全屏 TUI 会出现
    // 换行错位、边框断裂（终端尺寸与远端不一致的典型症状）。
    // 组合期间不改：IME 会话会被 fit() 打断（与 onWindowResize 同一原因）。
    const applyFontSize = (size) => {
        if (!FONT_SIZES.includes(size)) {
            return;
        }
        setFontSize(size);
        try {
            window.localStorage.setItem(FONT_SIZE_KEY, String(size));
        } catch (e) {
            /* 隐私模式下不可写，忽略 */
        }
        const xterm = termRef.current;
        if (xterm) {
            xterm.setOption('fontSize', size);
        }
        if (composingRef.current) {
            pendingFitRef.current = true;
            return;
        }
        if (fitAddon) {
            fit();
            if (xterm) {
                sendSizeToRemote(xterm.cols, xterm.rows);
            }
        }
    };

    // 主动把当前行列数同步给远端 PTY。
    // 与 sendTuiKey 走同一个 wsRef；协议与其它 resize 点一致：
    // Message.Resize + base64(JSON{cols,rows})。
    const sendSizeToRemote = (cols, rows) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(new Message(Message.Resize, window.btoa(JSON.stringify({cols, rows}))).toString());
        }
    };

    const onWindowResize = () => {
        // 软键盘动画期间 visualViewport 会连续变化，等一帧让布局稳定后再取尺寸，
        // 避免把动画中间态的极小高度应用给终端容器
        requestAnimationFrame(() => setBox(viewportBox()));
    };

    const init = async (assetId) => {
        keepAliveRef.current = false; // 重置：切资产时旧 tmux 状态不带入新会话
        const xterm = new Terminal({
            fontFamily: 'monaco, Consolas, "Lucida Console", monospace',
            fontSize: loadFontSize(),
            theme: {
                background: '#1b1b1b'
            },
        });
        let elementTerm = document.getElementById('terminal');
        xterm.open(elementTerm);
        const fitAddon = new FitAddon();
        xterm.loadAddon(fitAddon);
        // WebGL 渲染器：把逐格绘制交给 GPU。必须在 open() 之后 loadAddon。
        //
        // 为什么必须重新引入（上一轮的移除是误判）：
        // 手机 DPR 普遍 2~3，canvas 渲染器的实际画布是 780×1700 ~ 1170×2500 像素，
        // 而备用屏幕下的滚动本质是「把滚轮发给远端 → 远端整屏重绘 → 传回来重画」，
        // 一屏约 2000 个字形。按帧合并只优化了「发送」，没优化「绘制」——
        // 光是重绘就是几十毫秒，手指滑动必然糊成一片（用户反馈「没有滑动的感觉」）。
        //
        // 「终端与容器错位、露出白底」的真因是**版本不匹配**，不是 WebGL 不适合移动端：
        // 上一轮装的是 xterm-addon-webgl@0.16.0，其 peer 依赖为 xterm ^5.0.0，
        // 而本项目用 xterm 4.19.0 —— addon 调用了 5.x 才有的内部渲染 API。
        // 现换成配套的 0.12.0（peer: xterm ^4.0.0）。
        try {
            const webglAddon = new WebglAddon();
            // 上下文丢失（GPU 进程崩溃、系统回收后台页）时主动 dispose，
            // xterm 会自动回落到 canvas 渲染器 —— 终端降级为「卡但可用」，而不是白屏
            webglAddon.onContextLoss(() => {
                webglAddon.dispose();
            });
            xterm.loadAddon(webglAddon);
        } catch (e) {
            // 设备/浏览器不支持 WebGL：保持 xterm 默认的 canvas 渲染器，不阻断连接
        }
        // 首次 fit 必须用**局部 fitAddon 直接执行**，不能走 fit()。
        //
        // 根因（v1.4.35 埋下、v1.4.46 由 tmux 测试暴露）：fit() 内部读的是
        // state fitAddon，而 init 中 setFitAddon 在 connectWs 之后才执行 ——
        // 此刻 state 仍是 undefined，fit() 直接 return。此后的 box effect 又因
        // 「box 值不再变化」而不触发（它的 ws.OPEN 条件也拦住了首次执行），
        // 于是 fit 从**从未真正执行**：xterm 停留在默认 80×24（画布 720×432），
        // 被 CSS 拉伸到整个容器 —— 终端内容变形、「渲染只剩一个字符」正是症状。
        termRef.current = xterm;
        fitAddon.fit();
        if (xterm.rows > 0) {
            xterm.refresh(0, xterm.rows - 1); // WebGL 全屏重绘，见 fit() 内的说明
        }
        xterm.focus();

        if (!assetId) {
            writeErrorMessage(xterm, `参数缺失，请关闭此页面后重新打开。`)
            return;
        }

        // —— 恢复既有会话 vs 新建 ——
        //
        // 从会话列表点「继续」进入时带 sessionId，此时**不能**再 createSession，
        // 否则会在服务端多出一条重复会话，而用户以为自己回到了原来的会话。
        //
        // 服务端 /sessions/:id/ssh 在会话仍在内存时会用 reconnectToken 走 TryReattach
        // 挂接既有 SSH 连接；令牌从 sessionStorage 取（建会话时写入）。
        //
        // 权限位（upload/download/...）在恢复路径下拿不到：会话列表接口不返回它们，
        // 而 GET /sessions/:id 仅管理员可用。这里一律按 '0' 处理 —— 即恢复后
        // 不显示文件管理入口。这是**有意的保守降级**：宁可少一个入口，
        // 也不要给出一个点了报错的按钮。需要恢复完整的文件权限，
        // 应给会话列表接口补上这几个字段。
        let session;
        if (resumeSessionId) {
            session = {
                id: resumeSessionId,
                assetId: assetId,
                assetName: assetName,
                upload: '0', download: '0', delete: '0', rename: '0',
                edit: '0', copy: '0', paste: '0', fileSystem: '0',
                storageId: '', resumed: true,
            };
        } else {
            const [created, errMsg] = await createSession(assetId);
            if (!created) {
                writeErrorMessage(xterm, `创建会话失败，${errMsg}`)
                return;
            }
            session = created;
        }

        let sessionId = session['id'];

        xterm.writeln('trying to connect to the server ...');

        // 粘贴图片的扩展名：优先文件名自带后缀，其次 MIME 映射，
        // 都没有时按 png 兜底（浏览器剪贴板编码图片的既成事实），避免后缀与内容不符误导下游
        const pickExt = (file) => {
            const m = /\.([A-Za-z0-9]+)$/.exec(file.name || '');
            if (m) return m[1].toLowerCase();
            if (MIME_EXT[file.type]) return MIME_EXT[file.type];
            return 'png';
        };

        // 剪贴板图片上传：上传到主机 nt-pastes/ 目录（后端自动 MkdirAll），
        // 成功后把 @路径 写入剪贴板并提示，不向远端注入任何字符（不污染 bash 输入）
        const uploadPastedImage = async (file) => {
            const sid = sessionIdRef.current;
            if (!sid) return;
            if (session['upload'] !== '1') {
                message.warn('当前会话未开放文件上传权限');
                return;
            }
            const name = `nt-paste-${Date.now()}.${pickExt(file)}`;
            const hideLoading = message.loading('图片上传中…', 0);
            try {
                const {name: uploaded} = await uploadToSession(sid, file, 'nt-pastes', {
                    fileName: name,
                    maxSize: PASTE_UPLOAD_MAX,
                });
                const ref = `nt-pastes/${uploaded}`; // 基于会话工作目录的相对路径
                writeClipboard(`@${ref}`);
                // 卸载/切资产后 xterm 已 dispose，禁止再写屏（否则抛错被误报为网络异常）
                if (termRef.current === xterm) {
                    xterm.writeln(`\x1b[32m图片已上传 → ${ref}（含 @ 的路径已复制，Ctrl+V 粘贴到输入框后发送）\x1b[0m `);
                }
            } catch (e) {
                message.error(`图片上传失败：${e.message || '未知错误'}`);
            } finally {
                hideLoading();
            }
        };

        // 纯图片粘贴：capture 阶段在 xterm 处理前拦截（剪贴板含文本时一律放行，走原文本粘贴）
        const onPasteCapture = (event) => {
            if (session['paste'] === '0') return; // 禁用粘贴时交给 body.onpaste 提示
            // 只拦截终端区域，避免吞掉页面其它输入框（文件选择器、预览框）的图片粘贴
            if (!event.target || !event.target.closest || !event.target.closest('#terminal')) return;
            const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
            if (!items.length) return;
            const hasText = items.some(i => i.kind === 'string' && i.type === 'text/plain');
            const imageItem = items.find(i => i.kind === 'file' && (i.type === '' || i.type.startsWith('image/')));
            if (!hasText && imageItem) {
                event.preventDefault();
                event.stopPropagation();
                const file = imageItem.getAsFile();
                if (file) uploadPastedImage(file);
            }
        };

        // —— 剪贴板处理器：注册点与注销点必须同生命周期 ——
        // 断线重连只重建 WebSocket（connectWs）而不重跑 init，因此提为具名函数，
        // init 与重连成功各注册一次；否则重连后图片粘贴失效、
        // session.copy/paste 的合规管控也会被绕过（审计系统策略形同虚设）。
        const registerClipboardHandlers = () => {
            document.body.oncopy = (event) => {
                event.preventDefault();
                if (session['copy'] === '0') {
                    message.warn('禁止复制')
                    return false;
                } else {
                    return true;
                }
            };

            document.body.onpaste = (event) => {
                event.preventDefault();
                if (session['paste'] === '0') {
                    message.warn('禁止粘贴')
                    return false;
                } else {
                    return true;
                }
            };

            // 同一函数引用重复 addEventListener 会被浏览器去重，重连时重复注册无副作用
            document.addEventListener('paste', onPasteCapture, true);
        };

        const unregisterClipboardHandlers = () => {
            document.body.oncopy = null;
            document.body.onpaste = null;
            document.removeEventListener('paste', onPasteCapture, true);
        };

        registerClipboardHandlers();
        osc52Pending = ''; // 新会话：清掉上一会话可能遗留的 OSC 52 残片，避免跨会话污染

        // 重连令牌：优先 sessionStorage（跨页面刷新），否则 createSession 响应
        if (!reconnectTokenRef.current) {
            reconnectTokenRef.current = sessionStorage.getItem(`rt-${sessionId}`) || '';
        }
        sessionIdRef.current = sessionId;

        let pingInterval;
        let pingSentAt = 0;
        let lastActivity = Date.now();
        let offlineTimer;
        let currentWs = null;

        // Mobile IME guard: composition events bubble up from the hidden xterm textarea.
        // While composing, resize-triggered fit() is deferred so the IME session survives.
        const finishComposing = () => {
            composingRef.current = false;
            if (composingTimerRef.current) {
                clearTimeout(composingTimerRef.current);
                composingTimerRef.current = null;
            }
            if (pendingFitRef.current && termRef.current) {
                // 只有 ws 可用时才消费这次延迟 fit；否则保留标记，等下次 resize 处理，
                // 避免"检查 ws 前就清空"导致延迟 fit 被静默丢弃、本地尺寸与远端长期不一致
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                    pendingFitRef.current = false;
                    fit();
                    xterm.focus();
                    let terminalSize = {
                        cols: xterm.cols,
                        rows: xterm.rows
                    }
                    currentWs.send(new Message(Message.Resize, window.btoa(JSON.stringify(terminalSize))).toString());
                }
            }
        };

        // 兜底定时器：部分输入法不发 compositionend（xterm 4.19 修复了搜狗），
        // 用超时保证 composing 标记不会永久挂住。拼音连续输入常超过 3s，
        // 因此取 10s 并在 compositionupdate 时续期，避免合成中途误判为结束而去 fit()。
        const armComposingTimer = () => {
            if (composingTimerRef.current) clearTimeout(composingTimerRef.current);
            composingTimerRef.current = setTimeout(finishComposing, 10000);
        };

        // 具名 handler：切资产重跑 init 时可确定性移除，避免旧闭包叠加
        // （旧闭包会对已 dispose 的 fitAddon 调 fit()，并抢先消费 pendingFitRef）
        const onCompositionStart = () => {
            composingRef.current = true;
            armComposingTimer();
        };
        const onCompositionUpdate = () => {
            if (composingRef.current) armComposingTimer();
        };
        elementTerm.addEventListener('compositionstart', onCompositionStart);
        elementTerm.addEventListener('compositionupdate', onCompositionUpdate);
        elementTerm.addEventListener('compositionend', finishComposing);

        // 手机虚拟键盘的按键带 keyCode 229（"IME 正在处理中"），xterm 取不到字符，
        // 却会把内部 _keyDownSeen 置真、且只在 keyup 时复位 —— 而手机键盘多数不发 keyup，
        // 于是随后的 insertText 输入事件被 xterm 全部丢弃：表现为"手机打字没反应、回车却正常"。
        // 在捕获阶段拦下这类无效按键，让 xterm 保持"未见过 keydown"，input 事件即可正常消费。
        // 组合输入期间放行，避免干扰 IME 自身流程。
        const onVirtualKeyDown = (ev) => {
            if (ev.keyCode === 229 && !composingRef.current) {
                ev.stopImmediatePropagation();
            }
        };
        elementTerm.addEventListener('keydown', onVirtualKeyDown, true);

        // —— 触摸滑动 = 滚轮 ——
        // TUI 工作在备用屏幕，内容不进入 xterm 本地 scrollback，手指滑动无从滚动；
        // 这里把纵向滑动折算成滚轮步进：
        //   · 应用启用了鼠标追踪 → 发送 SGR 滚轮事件，由应用滚动它自己的内容；
        //   · 普通 shell（未启用鼠标）→ 走 xterm 本地滚动，回看历史输出。
        //
        // 性能：按帧合并。原先每折算出一格滚轮就单独发一条 WebSocket 消息，
        // 快速滑动时每秒可达几十条，每条都要走「浏览器→Go→应用」往返，累积成明显卡顿。
        // 现在同一帧内累计的滚轮折进同一条消息（终端协议本身是流式的，可连续解析多个序列）。
        // 每滑动约 20px 折算一格滚轮。一行文字高约 fontSize×1.2 ≈ 18px（默认 15px 字号），
        // 取 20 让「滑动一屏」与「滚动一屏」在「每格滚一行」的应用里接近 1:1；
        // 原值 24 会慢 33%，手感是「手指划过去了内容没跟上」。
        const WHEEL_STEP_PX = 20;
        let touchLastY = null;
        let touchAccum = 0;
        let wheelUpCount = 0;
        let wheelDownCount = 0;
        let wheelRafId = null;

        const mouseTrackingOn = (t) => !!(t.modes && t.modes.mouseTrackingMode && t.modes.mouseTrackingMode !== 'none');
        // 备用屏幕判定：TUI / tmux attach 后都在备用屏幕
        // tmux/备用屏幕/TUI 鼠标追踪：三选一即走 SGR 滚轮发送。
        // keepAliveRef 补充 tmux 在正常屏幕运行、且 mouse tracking 尚未到位的场景
        //（tmux new-session 的 mouse on 序列可能晚于首次 touchmove 到达）。
        const needsRemoteScroll = (t) => mouseTrackingOn(t) || isAltScreenActive(t) || keepAliveRef.current;


        const flushWheel = () => {
            wheelRafId = null;
            const up = wheelUpCount;
            const down = wheelDownCount;
            wheelUpCount = 0;
            wheelDownCount = 0;
            if (!up && !down) {
                return;
            }
            const t = termRef.current;
            if (!t) {
                return;
            }
            // 远端滚动条件：mouse reporting / 备用屏幕 / tmux 会话——三者居一即发 SGR 滚轮。
            // tmux 在正常屏幕运行时 isAltScreenActive=false、mouse tracking 序列可能尚未到位，
            // keepAliveRef 兜底确保触摸滑动始终转化为 SGR 事件，tmux 进 copy-mode 滚动历史。
            if (needsRemoteScroll(t)) {
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                    const col = Math.max(1, Math.floor(t.cols / 2));
                    const row = Math.max(1, Math.floor(t.rows / 2));
                    let seq = '';
                    for (let i = 0; i < down; i++) {
                        seq += `\x1b[<65;${col};${row}M`; // 65 = 滚轮下
                    }
                    for (let i = 0; i < up; i++) {
                        seq += `\x1b[<64;${col};${row}M`; // 64 = 滚轮上
                    }
                    currentWs.send(new Message(Message.Data, seq).toString());
                }
            } else {
                t.scrollLines((down - up) * 3);
            }
        };

        // 远端 TUI 的滚动节流：**按时间而非按帧**。
        //
        // 为什么两者要分开：TUI（Claude Code 这类）工作在备用屏幕并启用鼠标追踪，
        // 滚动不是本地行为——必须把滚轮事件发给远端应用，由它重绘内容再传回来。
        // 而按帧 flush 等于每秒发 60 批，在 100ms RTT 的链路上远端只能成串处理，
        // 表现为「手指在滑、画面一顿一顿」（用户实测反馈的正是这个）。
        // 按时间节流后，远端有完整的一帧时间重绘，观感连续得多。
        //
        // 本地滚动（普通 shell 回看历史）不涉及远端，必须保持按帧 —— 那里
        // 按帧才是「跟手」，加节流反而会拖慢。
        const REMOTE_WHEEL_INTERVAL_MS = 60; // 约 16 次/秒（原 80ms/12 次，真机反馈偏「黏」）
        let wheelTimer = null;

        const queueWheel = (up) => {
            if (up) {
                wheelUpCount++;
            } else {
                wheelDownCount++;
            }
            const t = termRef.current;
            const remote = t ? needsRemoteScroll(t) : false;
            if (remote) {
                if (wheelTimer === null) {
                    // 窗口起点**立即发一批**（leading edge），不等满一个节流窗口。
                    // 原实现只在窗口末尾发（trailing），意味着手指刚动的那一下最多要等
                    // 80ms 才送到远端，叠加 RTT 后起步明显「黏手」——而人对「起步延迟」
                    // 的敏感度远高于对「后续帧率」的敏感度。
                    // 窗口内继续累积的滚轮仍由下面的定时器在末尾补发；若期间没有新的
                    // 累积，flushWheel 会因计数为 0 直接返回，不产生空写。
                    flushWheel();
                    wheelTimer = setTimeout(() => {
                        wheelTimer = null;
                        flushWheel();
                    }, REMOTE_WHEEL_INTERVAL_MS);
                }
                return;
            }
            if (wheelRafId === null) {
                wheelRafId = requestAnimationFrame(flushWheel);
            }
        };

        // 一键回到最新输出：向上翻看很久之后不必手动滑回去。
        // TUI 侧连续下滚（滚到底部后应用会自然停住），普通屏幕直接跳到底。
        const scrollToBottom = () => {
            const t = termRef.current;
            if (!t) {
                return;
            }
            // 远端滚动条件：mouse reporting / 备用屏幕 / tmux 会话（见 needsRemoteScroll）
            if (needsRemoteScroll(t)) {
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                    const col = Math.max(1, Math.floor(t.cols / 2));
                    const row = Math.max(1, Math.floor(t.rows / 2));
                    let seq = '';
                    for (let i = 0; i < 60; i++) {
                        seq += `\x1b[<65;${col};${row}M`;
                    }
                    currentWs.send(new Message(Message.Data, seq).toString());
                }
            } else {
                t.scrollToBottom();
            }
        };
        scrollBottomRef.current = scrollToBottom;

        // 惯性：手指抬起后按末速度继续滚动一小段，手感接近系统原生滚动。
        // 衰减系数与阈值取得较保守，避免"甩一下滚过头"。
        let velocityPerFrame = 0; // 手指位移速度（px/帧，上滑为正）
        let lastMoveTs = 0;
        let momentumRafId = null;

        const stopMomentum = () => {
            if (momentumRafId !== null) {
                cancelAnimationFrame(momentumRafId);
                momentumRafId = null;
            }
        };

        const runMomentum = () => {
            velocityPerFrame *= 0.93;
            if (Math.abs(velocityPerFrame) < 0.8) {
                momentumRafId = null;
                return;
            }
            touchAccum += velocityPerFrame;
            while (Math.abs(touchAccum) >= WHEEL_STEP_PX) {
                queueWheel(touchAccum < 0);
                touchAccum += touchAccum < 0 ? WHEEL_STEP_PX : -WHEEL_STEP_PX;
            }
            momentumRafId = requestAnimationFrame(runMomentum);
        };

        const onTouchStart = (ev) => {
            stopMomentum();
            velocityPerFrame = 0;
            if (ev.touches.length !== 1) {
                touchLastY = null;
                return;
            }
            touchLastY = ev.touches[0].clientY;
            touchAccum = 0;
            lastMoveTs = performance.now();
        };

        const onTouchMove = (ev) => {
            if (touchLastY === null || ev.touches.length !== 1) {
                return;
            }
            const t = termRef.current;
            if (!t) {
                return;
            }
            // tmux / mouse reporting / 备用屏幕：走 SGR 滚轮发送；否则交给 xterm 原生滚动
            if (!needsRemoteScroll(t)) {
                touchLastY = null;
                return;
            }
            const y = ev.touches[0].clientY;
            const now = performance.now();
            const deltaPx = touchLastY - y; // 手指上滑为正
            const dt = now - lastMoveTs;
            if (dt > 0) {
                // 估算每帧位移作为末速度；限幅避免甩动过猛
                velocityPerFrame = Math.max(-60, Math.min(60, (deltaPx / dt) * 16));
            }
            lastMoveTs = now;
            stopMomentum(); // 手指仍在移动，取消进行中的惯性
            touchAccum += deltaPx;
            touchLastY = y;
            while (Math.abs(touchAccum) >= WHEEL_STEP_PX) {
                // 手指上滑 = 想看后面的内容 = 滚轮向下
                queueWheel(touchAccum < 0);
                touchAccum += touchAccum < 0 ? WHEEL_STEP_PX : -WHEEL_STEP_PX;
            }
            ev.preventDefault();
        };

        const onTouchEnd = () => {
            touchLastY = null;
            // 收尾：把最后一帧尚未发出的滚轮立刻送出去，避免尾部丢步
            if (wheelTimer !== null) {
                clearTimeout(wheelTimer);
                wheelTimer = null;
            }
            if (wheelRafId !== null) {
                cancelAnimationFrame(wheelRafId);
                flushWheel();
            }
            // 手指抬起时若仍有明显速度，交给惯性继续滚一小段
            if (Math.abs(velocityPerFrame) > 2) {
                stopMomentum();
                momentumRafId = requestAnimationFrame(runMomentum);
            } else {
                touchAccum = 0;
            }
            velocityPerFrame = 0;
        };

        // ⚠️ 必须 capture 阶段注册：xterm 4.19 内部对 touchmove 会 stopPropagation，
        // bubble 阶段的监听（此前写法）在备用屏幕下**从未执行**——tmux 场景的滑动
        // 全部落空（用户实测「tmux 后无法滑动查看内容」，v1.4.51 由探针证实：
        // capture 探针 60 次、bubble 探针 0 次）。capture 先于 xterm 内部监听执行，
        // 滚动累积与 preventDefault 在拦截之前完成；touchstart/touchend 一并改为
        // capture 保持一致性（它们只做轻量记录，不干扰 xterm 的聚焦逻辑）。
        elementTerm.addEventListener('touchstart', onTouchStart, {passive: true, capture: true});
        elementTerm.addEventListener('touchmove', onTouchMove, {passive: false, capture: true});
        elementTerm.addEventListener('touchend', onTouchEnd, {passive: true, capture: true});

        // 交给 assetId effect 的 cleanup 移除：切资产会重跑 init，
        // 旧闭包若不摘除，会对已 dispose 的 fitAddon 调 fit() 并抢先消费 pendingFitRef
        compositionCleanupRef.current = () => {
            elementTerm.removeEventListener('compositionstart', onCompositionStart);
            elementTerm.removeEventListener('compositionupdate', onCompositionUpdate);
            elementTerm.removeEventListener('compositionend', finishComposing);
            elementTerm.removeEventListener('keydown', onVirtualKeyDown, true);
            elementTerm.removeEventListener('touchstart', onTouchStart, {capture: true});
            elementTerm.removeEventListener('touchmove', onTouchMove, {capture: true});
            elementTerm.removeEventListener('touchend', onTouchEnd, {capture: true});
            stopMomentum(); // 卸载时停掉惯性动画帧，避免回调继续写已断开的连接
        };

        // rAF 节流渲染：合并同一帧内的多次 term.write，减少 DOM 重绘
        let pendingData = '';
        let rafId = null;
        let tailTimer = null;

        const flushData = () => {
            if (pendingData.length > 0) {
                // OSC 52 过滤：TUI 复制的文本在此写剪贴板，序列本身不上屏
                const {text, copied} = handleOsc52(pendingData);
                if (copied) {
                    writeClipboard(copied);
                    // 远端可在无用户手势下覆写本地剪贴板，首次写入时明确告知一次
                    if (!osc52NoticeRef.current) {
                        osc52NoticeRef.current = true;
                        message.info('终端已写入系统剪贴板');
                    }
                }
                xterm.write(text);
                pendingData = '';
            }
            rafId = null;
        };

        const scheduleFlush = () => {
            if (rafId === null) {
                rafId = requestAnimationFrame(flushData);
            }
            // 尾帧强制刷新：数据停止到达 30ms 后确保最后内容显示
            if (tailTimer) clearTimeout(tailTimer);
            tailTimer = setTimeout(() => {
                if (pendingData.length > 0) {
                    if (rafId) cancelAnimationFrame(rafId);
                    flushData();
                }
            }, 30);
        };

        const sendPing = () => {
            if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                pingSentAt = Date.now();
                currentWs.send(new Message(Message.Ping, "").toString());
            }
        };

        // 键盘快捷键处理：Ctrl+Shift+F 打开文件选择器
        xterm.attachCustomKeyEventHandler((event) => {
            if (event.ctrlKey && event.shiftKey && (event.key === 'F' || event.key === 'f')) {
                event.preventDefault();
                openFilePicker();
                return false;
            }
            return true;
        });

        // 断线期间丢弃输入：send 失败静默，防止 DOMException 干扰页面
        xterm.onData(data => {
            try {
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                    currentWs.send(new Message(Message.Data, data).toString());
                }
            } catch (e) {
            }
        });

        // WebSocket 创建函数化：断线重连按指数退避重建（1s/2s/4s/8s/16s，最多 5 次）
        const connectWs = () => {
            const wasReconnect = reconnectAttemptsRef.current > 0;
            const params = {
                'cols': xterm.cols,
                'rows': xterm.rows,
                'X-Auth-Token': getToken(),
                'reconnectToken': reconnectTokenRef.current,
                // 会话保持（tmux 复用）：移动端默认开启 —— 手机切应用/换网络/进出电梯
                // 都会杀 TCP，tmux 让远端任务继续跑、重连后 attach 回同一会话；
                // 桌面端网络稳定且用户习惯直连 shell，默认关闭。
                'keep': isMobile ? '1' : '0',
                // 连接来源：落库到 sessions.client_type / client_name，
                // 在线会话列表据此区分是谁的设备、具体是哪台
                'client': isMobile ? 'mobile' : 'desktop',
                // qs.stringify 会自行编码，这里不能再 encodeURIComponent（双重编码会变成 %25xx）
                'clientName': getClientName(isMobile)
            };
            const paramStr = qs.stringify(params);
            const webSocket = new WebSocket(`${wsServer}/sessions/${sessionId}/ssh?${paramStr}`);
            webSocket.binaryType = 'arraybuffer';
            wsRef.current = webSocket;
            currentWs = webSocket;

            webSocket.onopen = (e => {
                if (wasReconnect) {
                    reconnectAttemptsRef.current = 0;
                    // 重连成功后发当前窗口尺寸，让远端 shell 重绘提示符
                    const size = {cols: xterm.cols, rows: xterm.rows};
                    webSocket.send(new Message(Message.Resize, window.btoa(JSON.stringify(size))).toString());
                }
                // 重连路径不重跑 init，这里补注册剪贴板处理器（onclose 已统一注销）
                registerClipboardHandlers();
                setAliveStatus('connecting');
                sendPing(); // 连接后立即测一次延迟
                pingInterval = setInterval(sendPing, 2000); // 每 2s 刷新
                xtermScrollPretty();
            });

            webSocket.onerror = () => {
                // WebSocket error 不携带有意义数据，关闭原因见 onclose 或后端 Closed 消息
            }

            webSocket.onclose = (e) => {
                clearInterval(pingInterval);
                clearInterval(offlineTimer);
                // 清理全局事件处理器（重连时由 onopen 重新注册）
                unregisterClipboardHandlers();
                // 不重连：用户主动关闭 / 服务端 Closed / 正常关闭码
                if (manualCloseRef.current || closedByServerRef.current || e.code === 1000 || e.code === 1001) {
                    xterm.writeln(`connection closed (code: ${e.code})`);
                    setAliveStatus('offline');
                    return;
                }
                if (reconnectAttemptsRef.current >= 5) {
                    xterm.writeln(`\x1B[1;3;31m重连失败，连接已断开（请重新打开会话）\x1B[0m `);
                    setAliveStatus('offline');
                    return;
                }
                // 指数退避重连（后端宽限期 60s，总退避 31s + 连接时间在窗口内）
                reconnectAttemptsRef.current += 1;
                const attempt = reconnectAttemptsRef.current;
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
                setAliveStatus('reconnecting');
                xterm.writeln(`\x1B[1;3;33m连接断开，${delay / 1000}s 后重连（第 ${attempt}/5 次）...\x1B[0m `);
                reconnectTimerRef.current = setTimeout(() => {
                    if (!manualCloseRef.current && !closedByServerRef.current) {
                        connectWs();
                    }
                }, delay);
            }

            webSocket.onmessage = (e) => {
                const data = (e.data instanceof ArrayBuffer) ? new TextDecoder("utf-8").decode(e.data) : e.data;
                let msg = Message.parse(data);
                switch (msg['type']) {
                    case Message.Connected:
                        // 解析会话保持信息（服务端在 Connected content 里带 keep/attached）
                        try {
                            const info = JSON.parse(msg['content'] || 'null');
                            if (info && info.keep) {
                                setKeepInfo(info);
                                keepAliveRef.current = true;
                            }
                        } catch (e) { /* 旧版本服务端 content 为空，忽略 */ }
                        // 重连成功后不清屏（保留屏幕上下文）
                        if (!wasReconnect) {
                            xterm.clear();
                        }
                        updateSessionStatus(sessionId);
                        getCommands();
                        break;
                    case Message.Ping:
                        if (pingSentAt > 0) {
                            const rtt = Date.now() - pingSentAt;
                            setLatency(rtt);
                            setAliveStatus(rtt < 200 ? 'alive' : 'slow');
                            lastActivity = Date.now();
                        }
                        break;
                    case Message.Data:
                        lastActivity = Date.now();
                        pendingData += msg['content'];
                        scheduleFlush();
                        break;
                    case Message.Closed:
                        // 服务端决定结束：标记不重连
                        closedByServerRef.current = true;
                        if (pendingData.length > 0) {
                            if (rafId) cancelAnimationFrame(rafId);
                            flushData();
                        }
                        xterm.writeln(`\x1B[1;3;31m${msg['content']}\x1B[0m `);
                        webSocket.close();
                        break;
                    default:
                        break;
                }
            }

            // 存活检查：15s 无任何消息则标记 offline（允许网络轻度延迟，减少误报）
            offlineTimer = setInterval(() => {
                if (Date.now() - lastActivity > 15000) {
                    setAliveStatus('offline');
                }
            }, 3000);

            return webSocket;
        };

        // 暴露给网络恢复监听（切网/息屏唤醒时立即重连，不必等完指数退避）
        connectWsRef.current = connectWs;

        // 必须接住 connectWs 的返回值：webSocket 是它的局部变量，
        // 直接引用会抛 ReferenceError，使 websocket state 永远为 undefined ——
        // 依赖它的尺寸同步 effect 条件恒不成立，视口变化时终端再也不会 fit
        // （手机上表现为软键盘弹出后终端尺寸不跟随、画面错乱）。
        const ws = connectWs();

        setSession(session);
        setTerm(xterm);
        setFitAddon(fitAddon);
        setWebsocket(ws);
    }

    const handleUnload = (e) => {
        const message = "要离开网站吗？";
        (e || window.event).returnValue = message; //Gecko + IE
        return message;
    }

    useEffect(() => {
        document.title = assetName;
        manualCloseRef.current = false;
        closedByServerRef.current = false;
        reconnectAttemptsRef.current = 0;
        init(assetId);
        // 卸载/切换资产时才关闭 WebSocket 并释放 xterm：
        // 原实现把 close 放在 resize effect 的 cleanup 中，窗口缩放即掐断 SSH 会话
        return () => {
            // 标记主动关闭：退避定时器不再触发重连
            manualCloseRef.current = true;
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            if (composingTimerRef.current) {
                clearTimeout(composingTimerRef.current);
                composingTimerRef.current = null;
            }
            if (pendingFitTimerRef.current) {
                clearTimeout(pendingFitTimerRef.current);
                pendingFitTimerRef.current = null;
            }
            if (compositionCleanupRef.current) {
                compositionCleanupRef.current();
                compositionCleanupRef.current = null;
            }
            if (wsRef.current) {
                try {
                    wsRef.current.close();
                } catch (e) {
                    /* 关闭异常不影响后续清理 */
                }
                wsRef.current = null;
            }
            if (termRef.current) {
                try {
                    termRef.current.dispose();
                } catch (e) {
                    // dispose 失败绝不能中断本函数：React 在卸载时按挂载顺序执行 cleanup，
                    // 这里一旦抛出，**后面的 cleanup 全部被跳过**——其中包含
                    // document.body/html 的 height、overflow、touch-action 还原。
                    // 残留的锁定样式会让下一个页面被压扁或不可见。
                    console.error('[Term] xterm dispose 失败', e);
                }
                termRef.current = null;
            }
        };
    }, [assetId]);

    // 网络恢复 / 页面回到前台时立即重连。
    // 手机切网（WiFi ↔ 蜂窝）、息屏唤醒是移动端最常见的断线原因，
    // 若仍按指数退避等待，会白白消耗后端 60s 宽限期；这里直接把退避清零并立即重试。
    useEffect(() => {
        const reconnectNow = () => {
            if (manualCloseRef.current || closedByServerRef.current) return;
            const ws = wsRef.current;
            // 连接正常或正在连接中则无需干预
            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
            // 不在重连流程中（例如从未连接过）则不主动发起
            if (reconnectAttemptsRef.current === 0) return;
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            reconnectAttemptsRef.current = 0; // 重置退避计数，立即重试
            if (termRef.current) {
                termRef.current.writeln('\x1b[1;3;33m网络已恢复，正在重连…\x1b[0m ');
            }
            if (connectWsRef.current) {
                connectWsRef.current();
            }
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') reconnectNow();
        };
        window.addEventListener('online', reconnectNow);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            window.removeEventListener('online', reconnectNow);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, []);

    // 终端尺寸的唯一来源：读容器的**实际渲染尺寸**（由 CSS 100dvh 决定，浏览器算得准），
    // 再与 visualViewport 取较小值 —— 后者仅在「键盘已弹出但 dvh 未随之收缩」时更矮，
    // 用于把终端行数收进可视区，避免画到键盘下方被遮住。
    //
    // 两条铁律（都是踩过坑换来的）：
    //   1) **绝不修改容器自身尺寸** —— 曾用 ResizeObserver 监听容器又据其高度反改高度，
    //      形成自反馈环：设高→触发→条件翻转→清除→再触发，屏幕疯狂闪烁。
    //   2) visualViewport 不可作为唯一依据 —— 它在键盘弹出时的取值并不可靠，
    //      曾据此设置容器高度，结果终端被压成几行（真机反馈）。
    // 故：容器视觉高度交给 CSS，这里只计算终端该用多少行。
    // setBox 按值比较，避免无谓的 React 重渲染。
    useEffect(() => {
        const el = rootRef.current;
        if (!el) {
            return;
        }
        // 只对齐容器（position:fixed）的样式 —— 事件到达时**同步**执行。
        //
        // 与 applySize 分离的原因（真机遥测数据定位，2026-09-12）：
        // 键盘弹出动画期间 iOS 以 ~17ms 间隔连续触发 scroll/resize 事件（约 700ms 长），
        // 原「120ms 防抖」在连续事件流下**永远被重置、全程不执行** —— 容器在整个
        // 动画期间停留在键盘弹出前的位置，这就是每次呼出键盘必见白底的真因。
        //
        // 为什么同步而不是 rAF：scroll 事件本身天然每帧最多一次（17ms ≈ 60fps），
        // rAF 反而引入 1 帧相位差 —— 容器位置每帧落后视口 2~8px，快速变化时就是
        // 用户反馈的「小范围快速抖动」。写 top/left 不触发布局（只 paint），同步执行无 jank。
        //
        // 高度有「渐变冻结」：键盘开合动画期间 innerHeight/vvHeight 连续渐变，若每帧
        // 写容器高度，xterm 画布每帧被拉伸-回弹（抖动的另一来源）。只允许 >40px 的
        // 跳变（键盘开合瞬间，需要立即响应以免输入行被遮/留白）即时生效；
        // 渐变值冻结在最近一次稳定高度，动画结束后由防抖的 applySize 一步到位。
        let stableHeight = null;
        const alignContainer = () => {
            let height = window.innerHeight;
            let top = 0;
            let left = 0;
            const vv = window.visualViewport;
            if (isMobile && vv && vv.height > 0) {
                height = Math.min(height, Math.round(vv.height));
                // ⚠️ 只能**用 vv.offsetTop，绝不能再加 window.scrollY ——
                // 在 iOS 上两者是同一个位移的两种表达（页面被滚动 ≡ 可视区在布局视口内偏移），
                // 相加等于把位移算两遍（真机截图：offsetTop=127 时曾算成 254，顶部露白 127px）。
                top = Math.round(vv.offsetTop);
                // 横向同理：可视区也可能水平偏移（缩放/横滚），左边缘对齐 offsetLeft 即可覆盖满
                left = Math.round(vv.offsetLeft);
            }
            if (stableHeight !== null && height !== stableHeight && Math.abs(height - stableHeight) < 40) {
                height = stableHeight; // 渐变冻结
            }
            el.style.height = height + 'px';
            el.style.top = top + 'px';
            el.style.left = left + 'px';
            return {height, top, left};
        };

        const applySize = () => {
            const width = Math.round(window.innerWidth);
            const {height, top, left} = alignContainer();
            stableHeight = height; // 防抖稳定后的高度作为「渐变冻结」的基准
            // 锁定页面高度（防「聚焦滚动」）与 setBox（触发 xterm fit + 远端 resize）
            // 仍走防抖：这两项是重操作，动画期间高频执行会把终端来回压扁。
            document.documentElement.style.height = height + 'px';
            document.body.style.height = height + 'px';
            setBox(prev => (prev.width === width && prev.height === height) ? prev : {width, height});
        };
        // 防抖：软键盘弹出/收起是 200~300ms 的动画，期间 visualViewport 连续变化，
        // 并会经过远小于最终值的中间态。若直接采用中间态，终端会被压成几行且不再恢复。
        // 等待数值稳定后再应用 —— 这依赖规范行为本身，不依赖任何机型特征。
        let sizeTimer = null;
        const syncSize = () => {
            if (sizeTimer) {
                clearTimeout(sizeTimer);
            }
            sizeTimer = setTimeout(applySize, 120);
            // 容器样式**同步**对齐（见 alignContainer 的说明）：事件到达立即写，
            // 无 rAF 相位差；写 top/left 不触发布局，同步执行无 jank。
            alignContainer();
        };
        applySize(); // 初始尺寸立即应用，无需等待
        window.addEventListener('resize', syncSize);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', syncSize);
            // ⚠️ 必须同时监听 scroll，只监听 resize 是不够的。
            //
            // 软键盘弹出时浏览器做的是两件不同的事：① 缩小可视区高度（触发 resize）；
            // ② 把可视区在**布局视口内向上平移**，让聚焦的输入框可见（offsetTop 由 0 变正）。
            // 第 ② 件事改变的是 visualViewport 的偏移，触发的是 **scroll** 事件，不是 resize。
            // 只监听 resize 会拿到「新高度 + 旧 offsetTop」的组合：resize 先到、offsetTop 还没更新，
            // 容器便按过时的 top 定位 —— 可视区上下两侧落在容器之外，露出页面背景（白底），
            // 而页面此时又有可滚动余地，于是能上下滑动。这正是用户反馈的现象。
            window.visualViewport.addEventListener('scroll', syncSize);
        }
        // 容器尺寸也可能因样式/键盘改变，用 ResizeObserver 兜底触发重算。
        // 注意这里只「读」尺寸、不写尺寸，因此不会形成自反馈环。
        let ro = null;
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(() => requestAnimationFrame(syncSize));
            ro.observe(el);
        }
        return () => {
            if (sizeTimer) {
                clearTimeout(sizeTimer);
                sizeTimer = null;
            }
            // 还原页面高度，避免影响其它页面
            document.documentElement.style.height = '';
            document.body.style.height = '';
            window.removeEventListener('resize', syncSize);
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', syncSize);
                window.visualViewport.removeEventListener('scroll', syncSize);
            }
            if (ro) {
                ro.disconnect();
            }
        };
    }, []);

    // 终端页挂载期间锁定页面滚动/回弹/缩放：容器已脱离文档流，这里再兜一层，
    // 避免某些浏览器在键盘弹出时把整页顶动。
    // 具体逻辑已收敛到 utils/term-page-lock.js（幂等的 lock/unlock 对）——
    // 此前散在此处的手动存取与还原，任何一步抛错都会中断后续还原（见该模块说明）。
    useEffect(() => {
        lockTerminalPage();
        return unlockTerminalPage;
    }, []);

    // 尺寸同步 effect：视口尺寸（box）变化后，把 xterm 与远端 PTY 调到新尺寸
    useEffect(() => {
        // fit 是**本地布局**，不依赖 ws 状态：断网期间键盘弹起也应保持本地布局正确
        if (!(term && fitAddon)) {
            return;
        }
        const applySize = () => {
            fit();
            focus();
            if (websocket && websocket.readyState === WebSocket.OPEN) {
                const terminalSize = {
                    cols: term.cols,
                    rows: term.rows
                };
                websocket.send(new Message(Message.Resize, window.btoa(JSON.stringify(terminalSize))).toString());
            }
        };
        if (composingRef.current) {
            // 组合输入期间推迟重排（避免打断输入法），但**不能无限等**：
            // 打开输入法本身会弹出软键盘、使容器变矮，若迟迟不重排，
            // 终端仍按旧尺寸绘制，下半屏会被键盘完全遮住（真机反馈）。
            // 因此改为短暂延迟后必定重排 —— xterm 4.19 的 resize 内部有
            // updateCompositionElements 处理，组合期间重排不会丢失输入。
            pendingFitRef.current = true;
            if (pendingFitTimerRef.current) {
                clearTimeout(pendingFitTimerRef.current);
            }
            pendingFitTimerRef.current = setTimeout(() => {
                pendingFitTimerRef.current = null;
                if (pendingFitRef.current && termRef.current && websocket.readyState === WebSocket.OPEN) {
                    pendingFitRef.current = false;
                    applySize();
                }
            }, 250);
        } else {
            applySize();
        }
        return () => {
            if (pendingFitTimerRef.current) {
                clearTimeout(pendingFitTimerRef.current);
                pendingFitTimerRef.current = null;
            }
        };
    }, [box.width, box.height]);

    // 视口监听 effect：只注册一次（依赖数组为空）。
    // 之前监听器与 box 尺寸挤在同一个 effect 里，依赖 [box.width, box.height] 使得
    // 软键盘弹出动画期间 box 每次变化都会「移除旧监听 → 注册新监听」，
    // resize 事件可能恰好落在两者之间的间隙而丢失 —— 终端高度因此停在某个中间值
    // （手机上表现为终端被压成几行、下方露出大片空白）。
    useEffect(() => {
        // 防抖取 150ms：键盘动画期间 resize 连续触发并不断重置计时器，
        // 沿用默认 500ms 会让输入区尺寸错位约 0.8s 才纠正
        const resize = debounce(() => {
            onWindowResize();
        }, 150);
        window.addEventListener('resize', resize);
        // visualViewport resize covers the iOS case where the keyboard overlay
        // does not change window.innerHeight
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', resize);
        }
        window.addEventListener('beforeunload', handleUnload);

        return () => {
            // 仅移除监听器：WebSocket 生命周期由 assetId effect 管理，
            // 严禁在此 close（窗口缩放触发本 effect 重跑会掐断 SSH 会话）
            window.removeEventListener('resize', resize);
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', resize);
            }
            window.removeEventListener('beforeunload', handleUnload);
        }
    }, []);

    const cmdMenuItems = useMemo(() => commands.map(item => ({
        key: item['id'],
        label: item['name'],
    })), [commands]);

    const handleCmdMenuClick = (e) => {
        const cmd = commands.find(c => c['id'] === e.key);
        if (cmd) writeCommand(cmd['content']);
    }

    // Shared between the desktop draggable popover and the mobile fixed button column
    const shortcutTable = (
        <table style={{fontSize: 13}}>
            <thead>
                <tr><th style={{padding: '4px 12px', textAlign: 'left'}}>快捷键</th><th style={{padding: '4px 12px', textAlign: 'left'}}>功能</th></tr>
            </thead>
            <tbody>
                <tr
                    style={{cursor: 'pointer'}}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-track)'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    onClick={() => {
                        setShortcutPopoverOpen(false);
                        openFilePicker();
                    }}
                >
                    <td style={{padding: '4px 12px', fontFamily: 'monospace'}}>Ctrl+Shift+F</td>
                    <td style={{padding: '4px 12px'}}>搜索并预览远程文件</td>
                </tr>
            </tbody>
        </table>
    );

    return (
        // 根容器：脱离文档流并锁定为「动态视口」高度。
        // 100dvh 由浏览器随软键盘自动收缩（比 JS 读 visualViewport 更准 ——
        // 后者在 Android 上常比实际可用空间偏小，导致键盘上方残留一条空白）；
        // fixed 定位使页面没有可滚动高度，浮动控件相对本容器定位、随键盘一起收缩。
        <div ref={rootRef} className="nt-term-root" style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            overflow: 'hidden',
            backgroundColor: '#1b1b1b'
        }}>
            <style>{`
                /* dvh 回退：不支持动态视口单位的浏览器用 100vh */
                .nt-term-root { height: 100vh; height: 100dvh; }
                .file-picker-list::-webkit-scrollbar { width: 6px; }
                .file-picker-list::-webkit-scrollbar-track { background: transparent; }
                .file-picker-list::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
                .file-picker-list::-webkit-scrollbar-thumb:hover { background: #777; }
            `}</style>
            <div style={{height: '100%', width: '100%', padding: '8px 12px', boxSizing: 'border-box', backgroundColor: '#1b1b1b'}}>
                <div id='terminal' style={{
                    overflow: 'hidden',
                    height: '100%',
                    width: '100%',
                    backgroundColor: '#1b1b1b'
                }} onClick={() => {
                    // Touch focus fallback: some mobile browsers do not synthesize the
                    // mousedown event xterm relies on, so focus on tap explicitly.
                    focus();
                }}/>
            </div>

            {/* 存活指示器 + 会话保持徽标（合并为一个角标）。
                合并原因（用户反馈）：两个角标在右下角上下堆叠占地方且信息割裂。
                布局：第一段为存活/时延，keep 会话追加绿色「保持」段；整体一个深色胶囊。 */}
            <div style={{
                position: 'absolute', bottom: 15, right: 15, zIndex: 999,
                display: 'flex', alignItems: 'center', gap: 8,
                backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 4, padding: '3px 10px',
                fontSize: 12, fontFamily: 'monospace',
                pointerEvents: 'none', userSelect: 'none'
            }}>
                <span style={{
                    color: aliveStatus === 'alive' ? '#52c41a' : aliveStatus === 'slow' ? '#faad14' : aliveStatus === 'offline' ? '#ff4d4f' : aliveStatus === 'reconnecting' ? '#faad14' : '#999'
                }}>
                    {aliveStatus === 'offline' ? '● 离线' : aliveStatus === 'reconnecting' ? `● 重连中(${reconnectAttemptsRef.current}/5)…` : aliveStatus === 'connecting' ? '● 连接中' : latency !== null ? `● ${latency}ms` : ''}
                </span>
                {keepInfo && (
                    <span style={{
                        color: '#fff', backgroundColor: 'rgba(22,163,74,0.9)',
                        borderRadius: 3, padding: '0 6px', fontSize: 11,
                    }}>
                        {keepInfo.attached ? '会话保持·已恢复' : (keepInfo.reattached ? '会话保持·已重连' : '会话保持已开启')}
                    </span>
                )}
            </div>

            {/* 桌面浮动按钮（可拖拽）；移动端改用右下固定列，
                否则移动端会同时渲染两组相同控件，且两处 Popover 共享同一次 open 状态而互相压盖 */}
            {!isMobile && (
                <>
                    <Draggable>
                        <Affix style={{position: 'absolute', top: 50, right: 50, zIndex: enterBtnZIndex}}>
                            <Button icon={<FolderOutlined/>} onClick={() => {
                                setFileSystemVisible(true);
                                setEnterBtnZIndex(999); // xterm.js 输入框的zIndex是1000，在弹出文件管理页面后要隐藏此按钮
                            }}/>
                        </Affix>
                    </Draggable>

                    <Draggable>
                        <Affix style={{position: 'absolute', top: 50, right: 100, zIndex: enterBtnZIndex}}>
                            <Dropdown overlay={<Menu onClick={handleCmdMenuClick} items={cmdMenuItems}/>} trigger={['click']}
                                      placement="bottomLeft">
                                <Button icon={<CodeOutlined/>}/>
                            </Dropdown>
                        </Affix>
                    </Draggable>

                    <Draggable>
                        <Affix style={{position: 'absolute', top: 100, right: 50, zIndex: enterBtnZIndex}}>
                            <Button icon={<LineChartOutlined/>} onClick={() => {
                                setStatsVisible(true);
                                setEnterBtnZIndex(999);
                            }}/>
                        </Affix>
                    </Draggable>

                    <Draggable>
                        <Affix style={{position: 'absolute', top: 100, right: 100, zIndex: enterBtnZIndex}}>
                            <Popover
                                open={shortcutPopoverOpen}
                                onOpenChange={setShortcutPopoverOpen}
                                content={shortcutTable}
                                title="快捷命令"
                                trigger="click"
                            >
                                <Button icon={<ThunderboltOutlined/>}/>
                            </Popover>
                        </Affix>
                    </Draggable>
                </>
            )}

            {/* Mobile: 悬浮球置于右上角，默认收起（展开的按钮组会遮挡终端输出）。
                回看历史改用「手指上下滑动」手势，不再占用这里的按钮位。
                相对根容器 absolute 定位，随可视区一起收缩；触摸目标 44px */}
            {isMobile && (
                <div style={{
                    position: 'absolute', top: 12, right: 12,
                    zIndex: enterBtnZIndex, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10
                }}>
                    <Button
                        shape="circle"
                        style={{minWidth: 44, minHeight: 44, opacity: 0.85}}
                        icon={mobileActionsOpen ? <CloseOutlined/> : <MenuOutlined/>}
                        onClick={() => setMobileActionsOpen(v => !v)}
                    />
                    {mobileActionsOpen && (
                        <>
                            {/* 危险操作置顶：离拇指最远，避免误触断开 */}
                            <Button shape="circle" danger style={{minWidth: 44, minHeight: 44}} icon={<DisconnectOutlined/>}
                                    title="断开连接并返回"
                                    onClick={() => {
                                        disconnectAndBack();
                                    }}/>
                            <Button shape="circle" style={{minWidth: 44, minHeight: 44}} icon={<FolderOutlined/>} onClick={() => {
                                setFileSystemVisible(true);
                                setEnterBtnZIndex(999);
                                setMobileActionsOpen(false);
                            }}/>
                            <Dropdown overlay={<Menu onClick={handleCmdMenuClick} items={cmdMenuItems}/>} trigger={['click']}
                                      placement="bottomRight">
                                <Button shape="circle" style={{minWidth: 44, minHeight: 44}} icon={<CodeOutlined/>}/>
                            </Dropdown>
                            <Button shape="circle" style={{minWidth: 44, minHeight: 44, opacity: mobileKeypadOpen ? 0.55 : 1}}
                                    icon={<ControlOutlined/>}
                                    title="TUI 按键（方向键 / Tab / Enter / Esc / Ctrl+C）"
                                    onClick={() => {
                                        setMobileKeypadOpen(v => !v);
                                        setMobileActionsOpen(false);
                                    }}/>
                            {/* 字号：页面禁用了双指缩放（避免与终端尺寸计算打架），
                                所以这里是手机上放大终端文字的唯一入口。 */}
                            <Button shape="circle" style={{minWidth: 44, minHeight: 44}}
                                    icon={<FontSizeOutlined/>}
                                    title="调整字号"
                                    onClick={() => {
                                        setFontPanelOpen(v => !v);
                                        setMobileActionsOpen(false);
                                    }}/>
                            {/* 常用操作置底：离拇指最近 */}
                            <Button shape="circle" style={{minWidth: 44, minHeight: 44}} icon={<VerticalAlignBottomOutlined/>}
                                    title="跳到底部"
                                    onClick={() => {
                                        if (scrollBottomRef.current) {
                                            scrollBottomRef.current();
                                        }
                                        setMobileActionsOpen(false);
                                    }}/>
                        </>
                    )}
                </div>
            )}

            {/* 移动端 TUI 按键条：软键盘没有方向键/Esc，TUI 的选择列表、确认框无从操作。
                条带默认隐藏，由悬浮菜单的按键图标切换；半透明不碍事，点键即发对应转义序列。 */}
            {isMobile && fontPanelOpen && (
                <>
                {/* 透明遮罩：点面板外任意位置（=终端区域）即收起面板。
                    zIndex 取 2：高于终端内容（默认层），低于所有悬浮控件（enterBtnZIndex ≥ 999），
                    因此点悬浮球/按键条照常操作，点终端 = 关闭面板。 */}
                <div style={{position: 'absolute', inset: 0, zIndex: 2}}
                     onClick={() => setFontPanelOpen(false)}/>
                <div className="nt-font-panel" style={{
                    position: 'absolute', right: 64, bottom: 'calc(150px + var(--safe-bottom, 0px))',
                    zIndex: enterBtnZIndex + 1,
                }}>
                    <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8}}>
                        <span className="nt-font-panel-title">
                            终端字号 <span className="nt-font-panel-current">（当前 {fontSize}px）</span>
                        </span>
                        <Button size="small" type="text" aria-label="关闭字号面板"
                                className="nt-font-panel-close"
                                icon={<CloseOutlined/>}
                                onClick={() => setFontPanelOpen(false)}/>
                    </div>
                    <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
                        {FONT_SIZES.map(sz => (
                            <Button key={sz} size="small" type="text"
                                    className={`nt-font-size-btn${sz === fontSize ? ' is-active' : ''}`}
                                    onClick={() => applyFontSize(sz)}>
                                {sz}
                            </Button>
                        ))}
                    </div>
                    <div className="nt-font-panel-hint">
                        调整后会自动重排并把新尺寸同步给远端
                    </div>
                </div>
                </>
            )}

            {isMobile && mobileKeypadOpen && (
                <div className="nt-keybar"
                     style={{bottom: 'calc(6px + var(--safe-bottom, 0px))', zIndex: enterBtnZIndex}}>
                    {/* 第二层：低频键。点「⋯」才展开，且横向可滚。
                        放在主层**上方**——拇指从下往上够，展开后不会把主层顶出屏幕。 */}
                    {keypadMoreOpen && (
                        <div className="nt-keybar-row nt-keybar-more">
                            {TUI_KEYS_MORE.map(k => (
                                <Button key={k.label} size="small" type="text" title={k.title || k.label}
                                        className="nt-key" onClick={() => sendTuiKey(k.seq)}>
                                    {k.label}
                                </Button>
                            ))}
                        </div>
                    )}

                    {/* 主层：6 个高频键 + 「⋯」。390px 屏上一行放得下，**任何操作都不用滑动**。
                        旧版把 23 个键排成横向滚动的一行，按 Ctrl+C 也要先滑一段，
                        效率反而低于原生 7 键——这是用户明确反馈的问题。 */}
                    <div className="nt-keybar-row nt-keybar-main">
                        {TUI_KEYS_PRIMARY.map(k => (
                            <Button key={k.label} size="small" type="text" title={k.title || k.label}
                                    className="nt-key" onClick={() => sendTuiKey(k.seq)}>
                                {k.label}
                            </Button>
                        ))}
                        <Button size="small" type="text"
                                className={`nt-key nt-key-toggle${keypadMoreOpen ? ' is-open' : ''}`}
                                title="更多按键（Esc / Ctrl 组合 / 翻页 / 定位）"
                                onClick={() => setKeypadMoreOpen(v => !v)}>
                            {keypadMoreOpen ? '✕' : '⋯'}
                        </Button>
                        {/* 直接收起整条按键条。此前只能「点右上角悬浮球 → 再点键盘图标」两步，
                            而按键条常驻在底部、收起是为了腾出终端可视区，属于高频动作。 */}
                        <Button size="small" type="text"
                                className="nt-key nt-key-collapse"
                                title="收起按键条"
                                aria-label="收起按键条"
                                onClick={() => {
                                    setKeypadMoreOpen(false);
                                    setMobileKeypadOpen(false);
                                }}>
                            ⌄
                        </Button>
                    </div>
                </div>
            )}

            {/* 浮动文件选择器 */}
            {pickerVisible && (
                <>
                {/* 半透明遮罩，点击关闭 */}
                <div style={{
                    // absolute 而非 fixed：根容器会被 JS 显式重定位
                    // （见下方软键盘补偿，实测 offsetTop 由 0 变为 177），
                    // fixed 相对「初始包含块」定位、不随该偏移移动 ——
                    // 手机键盘弹起后面板下半部分（结果列表）正好落到键盘后面。
                    position: 'absolute', inset: 0, zIndex: 1001,
                    backgroundColor: 'rgba(0,0,0,0.3)'
                }} onClick={() => {
                    if (pickerTimerRef.current) { clearTimeout(pickerTimerRef.current); pickerTimerRef.current = null; }
                    setPickerVisible(false); focus();
                }} />
                <div style={{
                    position: 'absolute', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 1002, width: isMobile ? 'calc(100vw - 32px)' : 520,
                    backgroundColor: '#252526', borderRadius: 8, padding: 12,
                    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                    border: '1px solid #444',
                }}>
                    <div style={{display: 'flex', alignItems: 'center', marginBottom: 6}}>
                        <span style={{color: '#ccc', fontSize: 13, fontWeight: 500}}>打开文件</span>
                        {!isMobile &&
                            <span style={{color: '#666', fontSize: 11, marginLeft: 'auto'}}>Tab 补全 · ↓↑ 导航 · Enter 打开 · Esc 关闭</span>
                        }
                    </div>
                    <input
                        ref={pickerInputRef}
                        value={pickerInput}
                        onChange={(e) => {
                            const val = e.target.value;
                            setPickerInput(val);
                            setPickerIndex(0);
                            if (pickerTimerRef.current) clearTimeout(pickerTimerRef.current);
                            pickerTimerRef.current = setTimeout(() => fetchPickerResults(val), 200);
                        }}
                        onKeyDown={(e) => {
                            const pi = pickerInput, pr = pickerResults, pix = pickerIndex;
                            if (e.key === 'Escape') {
                                if (pickerTimerRef.current) { clearTimeout(pickerTimerRef.current); pickerTimerRef.current = null; }
                                setPickerVisible(false); focus(); return;
                            }
                            if (e.key === 'ArrowDown') { e.preventDefault(); setPickerIndex(Math.min(pix + 1, pr.length - 1)); return; }
                            if (e.key === 'ArrowUp') { e.preventDefault(); setPickerIndex(Math.max(pix - 1, 0)); return; }
                            if (e.key === 'Tab') {
                                e.preventDefault();
                                if (pr.length > 0 && pix < pr.length) {
                                    const s = pr[pix];
                                    const comp = resolvePickerPath(pi, s) + (s.isDir ? '/' : '');
                                    setPickerInput(comp); setPickerIndex(0); fetchPickerResults(comp);
                                }
                                return;
                            }
                            if (e.key === 'Enter') {
                                if (pr.length > 0 && pix < pr.length) {
                                    const s = pr[pix];
                                    const fp = resolvePickerPath(pi, s);
                                    if (s.isDir) { setPickerInput(fp + '/'); setPickerIndex(0); fetchPickerResults(fp + '/'); }
                                    else { doPreview(fp); setPickerVisible(false); focus(); }
                                } else if (pi.trim()) { doPreview(pi.trim()); setPickerVisible(false); focus(); }
                            }
                        }}
                        placeholder="输入文件路径（相对路径基于 SSH 工作目录）..."
                        autoFocus
                        style={{
                            width: '100%', backgroundColor: '#1e1e1e', color: '#d4d4d4',
                            border: '1px solid #555', borderRadius: 4, padding: '6px 10px',
                            fontSize: 14, fontFamily: 'monospace', outline: 'none',
                            boxSizing: 'border-box'
                        }}
                    />
                    <div ref={pickerListRef} className="file-picker-list"
                        style={{height: isMobile ? '40dvh' : 320, overflowY: 'auto', marginTop: 4, scrollbarWidth: 'thin', scrollbarColor: '#555 transparent'}}>
                    {pickerResults.length === 0 ? (
                        <div style={{padding: '12px 10px', color: '#888', fontSize: 13, textAlign: 'center'}}>
                            {pickerInput ? '无匹配文件' : '输入路径开始搜索...'}
                        </div>
                    ) : (
                            pickerResults.map((f, i) => (
                                <div key={f.name}
                                    onClick={() => {
                                        const fullPath = resolvePickerPath(pickerInput, f);
                                        if (f.isDir) {
                                            setPickerInput(fullPath + '/');
                                            setPickerIndex(0);
                                            fetchPickerResults(fullPath + '/');
                                        } else {
                                            doPreview(fullPath);
                                            setPickerVisible(false);
                                            focus();
                                        }
                                    }}
                                    onMouseEnter={() => setPickerIndex(i)}
                                    style={{
                                        padding: '5px 10px', cursor: 'pointer',
                                        backgroundColor: i === pickerIndex ? '#3a3a3a' : 'transparent',
                                        color: '#d4d4d4', fontFamily: 'monospace', fontSize: 13,
                                        borderRadius: 3,
                                        display: 'flex', justifyContent: 'space-between'
                                    }}
                                >
                                    <span>{f.isDir ? '📁 ' : '📄 '}{f.name}{f.isDir ? '/' : ''}</span>
                                    <span style={{color: '#888', fontSize: 11}}>
                                        {f.isDir ? '' : formatSize(f.size)}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
                </>
            )}

            <Modal
                title={previewTitle}
                open={previewVisible}
                footer={null}
                onCancel={() => {
                    setPreviewVisible(false);
                    // 关闭时重置预览状态，避免下次打开类型错误
                    setPreviewType('image');
                    setPreviewUrl('');
                    setMarkdownContent('');
                    setTextContent('');
                }}
                width={(previewType === 'code' || previewType === 'html' || previewType === 'pdf') ? '90%' : 'auto'}
                destroyOnClose
                centered
                styles={{body: previewType === 'image' ? {padding: 0, display: 'flex', justifyContent: 'center'} : {padding: 0}}}
            >
                {previewType === 'image' && previewUrl && (
                    <img src={previewUrl} alt={previewTitle}
                        style={{display: 'block', maxWidth: '90vw', maxHeight: '80vh'}}
                        onError={() => message.error('图片加载失败，请检查路径是否正确')}
                    />
                )}
                {previewType === 'pdf' && previewUrl && (
                    <iframe src={previewUrl} title={previewTitle}
                        style={{width: '100%', height: '80vh', border: 'none'}}
                    />
                )}
                {previewType === 'html' && previewUrl && (
                    <iframe src={previewUrl} title={previewTitle}
                        style={{width: '100%', height: '80vh', border: 'none'}}
                        sandbox
                    />
                )}
                {previewType === 'md' && (
                    <div style={{padding: 16, maxHeight: '80vh', overflow: 'auto', fontSize: 14, lineHeight: 1.6}}>
                        <Suspense fallback={<div style={{padding: 20, textAlign: 'center', color: '#888'}}>加载中...</div>}>
                            <ReactMarkdown>{markdownContent}</ReactMarkdown>
                        </Suspense>
                    </div>
                )}
                {previewType === 'code' && (
                    <div className="nt-code-preview" style={{
                        display: 'flex', height: '70vh', width: '100%',
                        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", monaco, monospace',
                        fontSize: 13, lineHeight: 1.6, tabSize: 4,
                    }}>
                        {/* 行号列：单个 <pre> 承载全部行号（此前每行一个 <div>，10 万行即 10 万节点） */}
                        <div className="nt-code-preview-gutter" style={{
                            padding: '16px 8px', textAlign: 'right', userSelect: 'none',
                            minWidth: 48, overflow: 'hidden', flexShrink: 0,
                        }}>
                            <pre style={{
                                margin: 0, font: 'inherit', lineHeight: 1.6, whiteSpace: 'pre',
                            }}>{lineNumbersText}</pre>
                        </div>
                        {/* 代码内容 */}
                        <div style={{
                            flex: 1, overflow: 'auto', padding: '16px 20px',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                        }}>
                            <code>{textContent}</code>
                        </div>
                    </div>
                )}
            </Modal>

            <Drawer
                title={'会话详情'}
                placement="right"
                width={window.innerWidth * 0.8}
                closable={true}
                onClose={() => {
                    setFileSystemVisible(false);
                    setEnterBtnZIndex(1001); // xterm.js 输入框的zIndex是1000，在弹出文件管理页面后要隐藏此按钮
                    focus();
                }}
                visible={fileSystemVisible}
            >
                <FileSystem
                    storageId={session['id']}
                    storageType={'sessions'}
                    upload={session['upload'] === '1'}
                    download={session['download'] === '1'}
                    delete={session['delete'] === '1'}
                    rename={session['rename'] === '1'}
                    edit={session['edit'] === '1'}
                    minHeight={window.innerHeight - 103}/>
            </Drawer>

            <Drawer
                title={'状态信息'}
                placement="right"
                width={window.innerWidth * 0.8}
                closable={true}
                onClose={() => {
                    setStatsVisible(false);
                    setEnterBtnZIndex(1001);

                    focus();
                }}
                visible={statsVisible}
                extra={
                    <Space>
                        <div style={{width: 100}}>
                            <Text>查询时间间隔</Text>
                        </div>

                        <Select defaultValue="5000" style={{width: 80}} onChange={(value) => {
                            setQueryInterval(parseInt(value));
                        }}>
                            <Select.Option value="1000">1秒</Select.Option>
                            <Select.Option value="5000">5秒</Select.Option>
                            <Select.Option value="15000">15秒</Select.Option>
                            <Select.Option value="30000">30秒</Select.Option>
                        </Select>
                    </Space>
                }
            >
                <Stats sessionId={session['id']} visible={statsVisible} queryInterval={queryInterval}/>
            </Drawer>
        </div>
    );
};

export default Term;