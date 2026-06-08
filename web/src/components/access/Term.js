import React, {useEffect, useRef, useState} from 'react';
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

    let [commands, setCommands] = useState([]);
    let [latency, setLatency] = useState(null); // 延迟 ms，null = 尚未测量
    let [aliveStatus, setAliveStatus] = useState('connecting'); // connecting | alive | slow | offline
    let cwdRef = useRef(''); // 跟踪 cd 命令，保存终端当前工作目录
    let [previewVisible, setPreviewVisible] = useState(false);
    let [previewUrl, setPreviewUrl] = useState('');
    let [previewTitle, setPreviewTitle] = useState('');

    let [term, setTerm] = useState();
    let [fitAddon, setFitAddon] = useState();
    let [websocket, setWebsocket] = useState();
    let [session, setSession] = useState({});

    let [fileSystemVisible, setFileSystemVisible] = useState(false);
    let [statsVisible, setStatsVisible] = useState(false);
    let [enterBtnZIndex, setEnterBtnZIndex] = useState(999);
    let [queryInterval, setQueryInterval] = useState(5000);

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
        let term = new Terminal({
            fontFamily: 'monaco, Consolas, "Lucida Console", monospace',
            fontSize: 15,
            theme: {
                background: '#1b1b1b'
            },
        });
        let elementTerm = document.getElementById('terminal');
        term.open(elementTerm);
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitAddon.fit();
        term.focus();

        if (!assetId) {
            writeErrorMessage(term, `参数缺失，请关闭此页面后重新打开。`)
            return;
        }

        let [session, errMsg] = await createSession(assetId);
        if (!session) {
            writeErrorMessage(term, `创建会话失败，${errMsg}`)
            return;
        }

        let sessionId = session['id'];

        term.writeln('trying to connect to the server ...');

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
            'cols': term.cols,
            'rows': term.rows,
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
                term.write(pendingData);
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

        webSocket.onerror = (e) => {
            writeErrorMessage(term, `websocket error ${e.data}`)
        }

        webSocket.onclose = (e) => {
            console.log(`e`, e);
            term.writeln("connection is closed.");
            setAliveStatus('offline');
            clearInterval(pingInterval);
            clearInterval(offlineTimer);
        }

        let isAtLineStart = true;
        let commandBuffer = '';
        let inCommandMode = false;
        let normalBuffer = ''; // 跟踪 cd 命令

        const exitCommandMode = () => {
            inCommandMode = false;
            commandBuffer = '';
            term.write('\r\n');
        };

        const doPreview = (filePath) => {
            let resolved = filePath;
            if (filePath.startsWith('./')) {
                resolved = cwdRef.current + '/' + filePath.slice(2);
            } else if (filePath.startsWith('.')) {
                resolved = cwdRef.current + '/' + filePath;
            } else if (!filePath.startsWith('/') && cwdRef.current) {
                resolved = cwdRef.current + '/' + filePath;
            }
            const token = getToken();
            const url = `${server}/sessions/${sessionId}/preview?file=${encodeURI(resolved)}&X-Auth-Token=${token}&t=${Date.now()}`;
            setPreviewUrl(url);
            setPreviewTitle(resolved);
            setPreviewVisible(true);
        };

        term.onData(data => {
            if (inCommandMode) {
                if (data === '\r') {
                    const path = commandBuffer.slice(1).trim();
                    if (path) doPreview(path);
                    exitCommandMode();
                    return;
                }
                if (data === '\x1b') {
                    exitCommandMode();
                    return;
                }
                if (data === '\t') {
                    // Tab 补全
                    const partial = commandBuffer.slice(1);
                    const lastSlash = partial.lastIndexOf('/');
                    let dir = lastSlash >= 0 ? partial.substring(0, lastSlash + 1) : '.';
                    if (dir.startsWith('.') && cwdRef.current) {
                        dir = dir === '.' ? cwdRef.current + '/' : cwdRef.current + '/' + dir;
                    }
                    const prefix = lastSlash >= 0 ? partial.substring(lastSlash + 1) : partial;
                    const token = getToken();
                    const lsUrl = `${server}/sessions/${sessionId}/ls?X-Auth-Token=${token}`;
                    fetch(lsUrl, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                        body: `dir=${encodeURI(dir)}`
                    })
                    .then(r => r.json())
                    .then(result => {
                        const files = (result.data || []).map(f => f.name);
                        const matches = files.filter(f => f.startsWith(prefix));
                        if (matches.length === 1) {
                            const completed = matches[0];
                            const suffix = completed.substring(prefix.length);
                            commandBuffer += suffix;
                            term.write(suffix);
                        } else if (matches.length > 1) {
                            // 多个匹配，显示提示
                            term.write('\r\n' + matches.join('  ') + '\r\n');
                            // 重新回显当前输入
                            term.write(commandBuffer);
                        }
                    })
                    .catch(() => {});
                    return;
                }
                if (data === '\x7f') {
                    if (commandBuffer.length > 1) {
                        commandBuffer = commandBuffer.slice(0, -1);
                        term.write('\b \b');
                    } else {
                        inCommandMode = false;
                        commandBuffer = '';
                        term.write('\b \b');
                        isAtLineStart = true;
                    }
                    return;
                }
                commandBuffer += data;
                term.write(data);
                return;
            }

            if (data === '\r') {
                // 检测 cd 命令，跟踪 shell 工作目录
                const m = normalBuffer.match(/^\s*cd\s+(.+)/);
                if (m) {
                    const dir = m[1].trim();
                    if (dir.startsWith('/')) {
                        cwdRef.current = dir;
                    } else if (dir.startsWith('..')) {
                        // 简化处理：只往上跳一级
                        const parts = cwdRef.current.split('/');
                        parts.pop();
                        cwdRef.current = parts.join('/') || '/';
                    } else {
                        cwdRef.current = cwdRef.current ? cwdRef.current + '/' + dir : '/' + dir;
                    }
                }
                normalBuffer = '';
                isAtLineStart = true;
            } else if (isAtLineStart && data === '@') {
                inCommandMode = true;
                commandBuffer = '@';
                isAtLineStart = false;
                term.write('@');
                return;
            } else {
                if (data === '\x7f') {
                    normalBuffer = normalBuffer.slice(0, -1);
                } else {
                    normalBuffer += data;
                }
                isAtLineStart = false;
            }

            if (webSocket !== undefined) {
                webSocket.send(new Message(Message.Data, data).toString());
            }
        });

        webSocket.onmessage = (e) => {
            let msg = Message.parse(e.data);
            switch (msg['type']) {
                case Message.Connected:
                    term.clear();
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
                    console.log(`服务端通知需要关闭连接`)
                    term.writeln(`\x1B[1;3;31m${msg['content']}\x1B[0m `);
                    webSocket.close();
                    break;
                default:
                    break;
            }
        }

        setSession(session);
        setTerm(term);
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

    const cmdMenuItems = commands.map(item => {
        return {
            key: item['id'],
            label: item['name'],
        };
    });

    const handleCmdMenuClick = (e) => {
        for (const command of commands) {
            if (command['id'] === e.key) {
                writeCommand(command['content']);
            }
        }
    }

    return (
        <div>
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
                {aliveStatus === 'alive' && latency !== null && `● ${latency}ms`}
                {aliveStatus === 'slow' && latency !== null && `● ${latency}ms`}
                {aliveStatus === 'offline' && '● 离线'}
                {aliveStatus === 'connecting' && '● 连接中'}
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
                        content={
                            <table style={{fontSize: 13}}>
                                <thead>
                                    <tr><th style={{padding: '4px 12px', textAlign: 'left'}}>命令</th><th style={{padding: '4px 12px', textAlign: 'left'}}>功能</th></tr>
                                </thead>
                                <tbody>
                                    <tr><td style={{padding: '4px 12px', fontFamily: 'monospace'}}>@文件路径</td><td style={{padding: '4px 12px'}}>预览远程主机图片</td></tr>
                                </tbody>
                            </table>
                        }
                        title="快捷命令"
                        trigger="click"
                    >
                        <Button icon={<ThunderboltOutlined/>} onClick={() => setEnterBtnZIndex(999)}/>
                    </Popover>
                </Affix>
            </Draggable>

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
                // maskClosable={false}
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