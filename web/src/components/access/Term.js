import React, {useEffect, useMemo, useRef, useState} from 'react';
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

const {Text} = Typography;

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

    const doPreview = (filePath) => {
        const token = getToken();
        const url = `${server}/sessions/${sessionIdRef.current}/preview?file=${encodeURIComponent(filePath)}&X-Auth-Token=${token}&t=${Date.now()}`;
        setPreviewUrl(url);
        setPreviewTitle(filePath);
        setPreviewVisible(true);
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
        return [result['data'], ''];
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

        let token = getToken();
        let params = {
            'cols': xterm.cols,
            'rows': xterm.rows,
            'X-Auth-Token': token
        };

        let paramStr = qs.stringify(params);

        let webSocket = new WebSocket(`${wsServer}/sessions/${sessionId}/ssh?${paramStr}`);

        let pingInterval;
        let pingSentAt = 0;
        let lastActivity = Date.now();

        // 存活检查：8s 无任何消息则标记 offline（4 次 ping 无响应）
        const offlineTimer = setInterval(() => {
            if (Date.now() - lastActivity > 8000) {
                setAliveStatus('offline');
            }
        }, 3000);

        const sendPing = () => {
            pingSentAt = Date.now();
            webSocket.send(new Message(Message.Ping, "").toString());
        };

        webSocket.onopen = (e => {
            setAliveStatus('connecting');
            sendPing(); // 连接后立即测一次延迟
            pingInterval = setInterval(sendPing, 2000); // 每 2s 刷新
            xtermScrollPretty();
        });

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

        webSocket.onerror = () => {
            // WebSocket error 不携带有意义数据，关闭原因见 onclose 或后端 Closed 消息
        }

        webSocket.onclose = (e) => {
            xterm.writeln(`connection closed (code: ${e.code})`);
            setAliveStatus('offline');
            clearInterval(pingInterval);
            clearInterval(offlineTimer);
            // 清理全局事件处理器
            document.body.oncopy = null;
            document.body.onpaste = null;
        }

        // 将 sessionId 存入 ref，供组件层 picker 函数使用
        sessionIdRef.current = sessionId;

        // 键盘快捷键处理：Ctrl+Shift+F 打开文件选择器
        xterm.attachCustomKeyEventHandler((event) => {
            if (event.ctrlKey && event.shiftKey && (event.key === 'F' || event.key === 'f')) {
                event.preventDefault();
                openFilePicker();
                return false;
            }
            return true;
        });

        xterm.onData(data => {
            if (webSocket !== undefined) {
                webSocket.send(new Message(Message.Data, data).toString());
            }
        });

        webSocket.onmessage = (e) => {
            let msg = Message.parse(e.data);
            switch (msg['type']) {
                case Message.Connected:
                    xterm.clear();
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
                    // 先 flush 残留数据再关闭
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
        init(assetId);
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
            if (websocket) {
                websocket.close();
            }
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
                color: aliveStatus === 'alive' ? '#52c41a' : aliveStatus === 'slow' ? '#faad14' : aliveStatus === 'offline' ? '#ff4d4f' : '#999',
                fontSize: 12, fontFamily: 'monospace',
                pointerEvents: 'none', userSelect: 'none'
            }}>
                {aliveStatus === 'offline' ? '● 离线' : aliveStatus === 'connecting' ? '● 连接中' : latency !== null ? `● ${latency}ms` : ''}
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
                onCancel={() => setPreviewVisible(false)}
                width="auto"
                destroyOnClose
                centered
                styles={{body: {padding: 0, display: 'flex', justifyContent: 'center', backgroundColor: '#fff'}}}
            >
                {previewUrl && <img src={previewUrl} alt={previewTitle}
                    style={{display: 'block'}}
                    onError={() => message.error('图片加载失败，请检查路径是否正确')}
                />}
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