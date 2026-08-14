import React, {Suspense, lazy, useEffect, useMemo, useRef, useState} from 'react';
import {useSearchParams} from "react-router-dom";
import {Terminal} from "xterm";
import {FitAddon} from "xterm-addon-fit";
import {getToken} from "../../utils/utils";
import request from "../../common/request";
import {Affix, Button, Drawer, Dropdown, Menu, message, Modal, Popover, Select, Space, Typography} from "antd";
import Message from "./Message";
import qs from "qs";
import {server, wsServer} from "../../common/env";
import Draggable from "react-draggable";
import {CodeOutlined, FolderOutlined, LineChartOutlined, ThunderboltOutlined} from "@ant-design/icons";
import FileSystem from "../devops/FileSystem";
import "xterm/css/xterm.css"
import Stats from "./Stats";
import {debounce} from "../../utils/fun";
import commandApi from "../../api/command";
import strings from "../../utils/strings";
import workCommandApi from "../../api/worker/command";
import {xtermScrollPretty} from "../../utils/xterm-scroll-pretty";
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

const Term = () => {

    const [searchParams] = useSearchParams();
    const assetId = searchParams.get('assetId');
    const assetName = searchParams.get('assetName');
    const isWorker = searchParams.get('isWorker');
    const [box, setBox] = useState({width: window.innerWidth, height: window.innerHeight});

    const [commands, setCommands] = useState([]);
    const [latency, setLatency] = useState(null); // 延迟 ms，null = 尚未测量
    const [aliveStatus, setAliveStatus] = useState('connecting'); // connecting | alive | slow | offline
    const [previewVisible, setPreviewVisible] = useState(false);
    const [previewUrl, setPreviewUrl] = useState('');
    const [previewTitle, setPreviewTitle] = useState('');
    const [previewType, setPreviewType] = useState('image'); // image | pdf | html | md | code
    const [markdownContent, setMarkdownContent] = useState('');
    const [textContent, setTextContent] = useState('');
    const [textLanguage, setTextLanguage] = useState('plaintext');

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
    // 断线重连状态
    const reconnectTimerRef = useRef(null);  // 重连退避定时器
    const reconnectAttemptsRef = useRef(0);  // 连续重连次数（上限 5）
    const manualCloseRef = useRef(false);    // 用户主动关闭（卸载/切资产）不重连
    const closedByServerRef = useRef(false); // 收到服务端 Closed 消息后不重连
    const reconnectTokenRef = useRef('');    // 重连令牌（HMAC，会话存活期有效）

    const lsAbortRef = useRef(null);

    const fetchPickerResults = (partial) => {
        // 取消上一次未完成的请求，防止旧结果覆盖新结果
        if (lsAbortRef.current) lsAbortRef.current.abort();
        lsAbortRef.current = new AbortController();
        const token = getToken();
        const lsUrl = `${server}/sessions/${sessionIdRef.current}/ls?X-Auth-Token=${token}`;
        fetch(lsUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
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

    const fit = () => {
        if (fitAddon) {
            fitAddon.fit();
        }
    }

    const onWindowResize = () => {
        setBox({width: window.innerWidth, height: window.innerHeight});
    };

    const init = async (assetId) => {
        const xterm = new Terminal({
            fontFamily: 'monaco, Consolas, "Lucida Console", monospace',
            fontSize: 15,
            theme: {
                background: '#1b1b1b'
            },
        });
        let elementTerm = document.getElementById('terminal');
        xterm.open(elementTerm);
        const fitAddon = new FitAddon();
        xterm.loadAddon(fitAddon);
        fitAddon.fit();
        xterm.focus();
        termRef.current = xterm;

        if (!assetId) {
            writeErrorMessage(xterm, `参数缺失，请关闭此页面后重新打开。`)
            return;
        }

        const [session, errMsg] = await createSession(assetId);
        if (!session) {
            writeErrorMessage(xterm, `创建会话失败，${errMsg}`)
            return;
        }

        let sessionId = session['id'];

        xterm.writeln('trying to connect to the server ...');

        document.body.oncopy = (event) => {
            event.preventDefault();
            if (session['copy'] === '0') {
                message.warn('禁止复制')
                return false;
            } else {
                return true;
            }
        }

        document.body.onpaste = (event) => {
            event.preventDefault();
            if (session['paste'] === '0') {
                message.warn('禁止粘贴')
                return false;
            } else {
                return true;
            }
        }

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

        // rAF 节流渲染：合并同一帧内的多次 term.write，减少 DOM 重绘
        let pendingData = '';
        let rafId = null;
        let tailTimer = null;

        const flushData = () => {
            if (pendingData.length > 0) {
                xterm.write(pendingData);
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
                'reconnectToken': reconnectTokenRef.current
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
                // 清理全局事件处理器
                document.body.oncopy = null;
                document.body.onpaste = null;
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

        connectWs();

        setSession(session);
        setTerm(xterm);
        setFitAddon(fitAddon);
        setWebsocket(webSocket);
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
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            if (termRef.current) {
                termRef.current.dispose();
                termRef.current = null;
            }
        };
    }, [assetId]);

    useEffect(() => {
        if (term && websocket && fitAddon && websocket.readyState === WebSocket.OPEN) {
            fit();
            focus();
            let terminalSize = {
                cols: term.cols,
                rows: term.rows
            }
            websocket.send(new Message(Message.Resize, window.btoa(JSON.stringify(terminalSize))).toString());
        }
        window.addEventListener('beforeunload', handleUnload);

        let resize = debounce(() => {
            onWindowResize();
        });

        window.addEventListener('resize', resize);

        return () => {
            // 仅移除监听器：WebSocket 生命周期由 assetId effect 管理，
            // 严禁在此 close（窗口缩放触发本 effect 重跑会掐断 SSH 会话）
            window.removeEventListener('resize', resize);
            window.removeEventListener('beforeunload', handleUnload);
        }
    }, [box.width, box.height]);

    const cmdMenuItems = useMemo(() => commands.map(item => ({
        key: item['id'],
        label: item['name'],
    })), [commands]);

    const handleCmdMenuClick = (e) => {
        const cmd = commands.find(c => c['id'] === e.key);
        if (cmd) writeCommand(cmd['content']);
    }

    return (
        <div>
            <style>{`
                .file-picker-list::-webkit-scrollbar { width: 6px; }
                .file-picker-list::-webkit-scrollbar-track { background: transparent; }
                .file-picker-list::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
                .file-picker-list::-webkit-scrollbar-thumb:hover { background: #777; }
            `}</style>
            <div id='terminal' style={{
                overflow: 'hidden',
                height: box.height,
                width: box.width,
                backgroundColor: '#1b1b1b'
            }}/>

            {/* 存活指示器 */}
            <div style={{
                position: 'absolute', bottom: 15, right: 15, zIndex: 999,
                backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 4, padding: '3px 8px',
                color: aliveStatus === 'alive' ? '#52c41a' : aliveStatus === 'slow' ? '#faad14' : aliveStatus === 'offline' ? '#ff4d4f' : aliveStatus === 'reconnecting' ? '#faad14' : '#999',
                fontSize: 12, fontFamily: 'monospace',
                pointerEvents: 'none', userSelect: 'none'
            }}>
                {aliveStatus === 'offline' ? '● 离线' : aliveStatus === 'reconnecting' ? `● 重连中(${reconnectAttemptsRef.current}/5)…` : aliveStatus === 'connecting' ? '● 连接中' : latency !== null ? `● ${latency}ms` : ''}
            </div>

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
                        content={
                            <table style={{fontSize: 13}}>
                                <thead>
                                    <tr><th style={{padding: '4px 12px', textAlign: 'left'}}>快捷键</th><th style={{padding: '4px 12px', textAlign: 'left'}}>功能</th></tr>
                                </thead>
                                <tbody>
                                    <tr
                                        style={{cursor: 'pointer'}}
                                        onMouseEnter={e => e.currentTarget.style.backgroundColor = '#f0f0f0'}
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
                        }
                        title="快捷命令"
                        trigger="click"
                    >
                        <Button icon={<ThunderboltOutlined/>}/>
                    </Popover>
                </Affix>
            </Draggable>

            {/* 浮动文件选择器 */}
            {pickerVisible && (
                <>
                {/* 半透明遮罩，点击关闭 */}
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 1001,
                    backgroundColor: 'rgba(0,0,0,0.3)'
                }} onClick={() => {
                    if (pickerTimerRef.current) { clearTimeout(pickerTimerRef.current); pickerTimerRef.current = null; }
                    setPickerVisible(false); focus();
                }} />
                <div style={{
                    position: 'fixed', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 1002, width: 520,
                    backgroundColor: '#252526', borderRadius: 8, padding: 12,
                    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                    border: '1px solid #444',
                }}>
                    <div style={{display: 'flex', alignItems: 'center', marginBottom: 6}}>
                        <span style={{color: '#ccc', fontSize: 13, fontWeight: 500}}>打开文件</span>
                        <span style={{color: '#666', fontSize: 11, marginLeft: 'auto'}}>Tab 补全 · ↓↑ 导航 · Enter 打开 · Esc 关闭</span>
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
                        style={{height: 320, overflowY: 'auto', marginTop: 4, scrollbarWidth: 'thin', scrollbarColor: '#555 transparent'}}>
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
                styles={{body: previewType === 'image' ? {padding: 0, display: 'flex', justifyContent: 'center', backgroundColor: '#fff'} : {padding: 0}}}
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
                    <div style={{
                        display: 'flex', height: '70vh', width: '100%',
                        background: '#ffffff', color: '#333333',
                        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", monaco, monospace',
                        fontSize: 13, lineHeight: 1.6, tabSize: 4,
                    }}>
                        {/* 行号列 */}
                        <div style={{
                            padding: '16px 8px', textAlign: 'right', userSelect: 'none',
                            color: '#999999', background: '#f5f5f5',
                            minWidth: 48, overflow: 'hidden', flexShrink: 0,
                            borderRight: '1px solid #e0e0e0',
                        }}>
                            {textContent.split('\n').map((_, i) => (
                                <div key={i} style={{height: '1.6em', whiteSpace: 'pre'}}>{i + 1}</div>
                            ))}
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