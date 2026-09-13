import React, {useEffect, useRef, useState} from 'react';
import {useSearchParams} from "react-router-dom";
import sessionApi from "../../api/session";
import strings from "../../utils/strings";
import Guacamole from "guacamole-common-js";
import {wsServer} from "../../common/env";
import {exitFull, getToken, requestFullScreen} from "../../utils/utils";
import qs from "qs";
import {Affix, Button, Drawer, Dropdown, Menu, message, Modal} from "antd";
import {
    CopyOutlined,
    ExclamationCircleOutlined,
    ExpandOutlined,
    FolderOutlined,
    WindowsOutlined
} from "@ant-design/icons";
import {Base64} from "js-base64";
import Draggable from "react-draggable";
import FileSystem from "../devops/FileSystem";
import GuacdClipboard from "./GuacdClipboard";
import {debounce} from "../../utils/fun";
import {useIsMobile} from "../../hook/use-breakpoint";
import BackButton from "../BackButton";
import './Guacd.css';

// HACK: fixedSize 原为模块级变量，带宽高参数打开过后无参打开会沿用旧值导致 resize 失效。
// 改为组件内 ref，随组件卸载销毁。

const STATE_IDLE = 0;
const STATE_CONNECTING = 1;
const STATE_WAITING = 2;
const STATE_CONNECTED = 3;
const STATE_DISCONNECTING = 4;
const STATE_DISCONNECTED = 5;

const Guacd = () => {

    let [searchParams] = useSearchParams();
    let assetId = searchParams.get('assetId');
    let assetName = searchParams.get('assetName');
    let protocol = searchParams.get('protocol');
    let width = searchParams.get('width');
    let height = searchParams.get('height');

    const fixedSizeRef = React.useRef(false);
    const isMobile = useIsMobile();

    if (width && height) {
        fixedSizeRef.current = true;
    } else {
        width = window.innerWidth;
        height = window.innerHeight;
    }

    let [box, setBox] = useState({width, height});
    // 连接建立后的重渲染触发器。注意：所有对 client/sink 的读取都必须走 guacdRef，
    // 不要再读这个 state——它的值可能是上一轮渲染的。保留 state 是因为它承载
    // 「连接就绪」这一时点的重渲染语义，删掉会改变渲染时序。
    let [, setGuacd] = useState({});
    let [session, setSession] = useState({});
    // guacd 的 ref 镜像：销毁路径需要读当前 client，但不能把 guacd 放进 effect 依赖，
    // 否则每次 setGuacd({...}) 传入新对象引用都会触发 cleanup（详见下方两个 effect 的分工）
    const guacdRef = useRef({});

    // 断线重连状态
    const sessionRef = useRef(null);           // 会话对象（闭包稳定引用）
    const reconnectTimerRef = useRef(null);    // 重连退避定时器
    const reconnectAttemptsRef = useRef(0);    // 连续重连次数（上限 5）
    const reconnectGivenUpRef = useRef(false); // 放弃重连后不再自动重试
    const reconnectingRef = useRef(false);     // 重连中（抑制 DISCONNECTED 提示）
    const manualCloseRef = useRef(false);      // 用户主动关闭不重连
    const reconnectTokenRef = useRef('');      // 重连令牌
    let [clipboardText, setClipboardText] = useState('');
    let [fullScreened, setFullScreened] = useState(false);
    let [clipboardVisible, setClipboardVisible] = useState(false);
    let [fileSystemVisible, setFileSystemVisible] = useState(false);

    useEffect(() => {
        document.title = assetName;
        manualCloseRef.current = false;
        reconnectGivenUpRef.current = false;
        reconnectAttemptsRef.current = 0;
        createSession();
    }, [assetId, assetName]);

    const createSession = async () => {
        let session = await sessionApi.create(assetId, 'guacd');
        if (!strings.hasText(session['id'])) {
            return;
        }
        // 断线重连令牌：存 sessionStorage 供页面刷新后重连使用
        if (session['reconnectToken']) {
            reconnectTokenRef.current = session['reconnectToken'];
            sessionStorage.setItem(`rt-${session['id']}`, session['reconnectToken']);
        }
        sessionRef.current = session;
        setSession(session);
        renderDisplay(session['id'], protocol, width, height);
    }

    const renderDisplay = (sessionId, protocol, width, height) => {
        // 清空旧 client 的 display/sink DOM（重建连接时避免元素叠加）
        const displayEle = document.getElementById("display");
        displayEle.innerHTML = '';

        // 刷新令牌：优先 sessionStorage（跨页面刷新）
        if (!reconnectTokenRef.current) {
            reconnectTokenRef.current = sessionStorage.getItem(`rt-${sessionId}`) || '';
        }

        let tunnel = new Guacamole.WebSocketTunnel(`${wsServer}/sessions/${sessionId}/tunnel`);
        let client = new Guacamole.Client(tunnel);

        // 处理从虚拟机收到的剪贴板内容
        client.onclipboard = handleClipboardReceived;

        // 处理客户端的状态变化事件
        client.onstatechange = (state) => {
            onClientStateChange(state, sessionId);
        };

        client.onerror = onError;
        tunnel.onerror = onError;

        // Add client to display div
        const element = client.getDisplay().getElement();
        displayEle.appendChild(element);

        let dpi = 96;
        if (protocol === 'telnet') {
            dpi = dpi * 2;
        }

        let token = getToken();

        let params = {
            'width': width,
            'height': height,
            'dpi': dpi,
            'X-Auth-Token': token,
            'reconnectToken': reconnectTokenRef.current
        };

        let paramStr = qs.stringify(params);

        client.connect(paramStr);
        let display = client.getDisplay();
        display.onresize = function (width, height) {
            // 宽高两个方向分别取比，再取较小者；原实现两处都除 getHeight()，
            // 当窗口宽高比窄于远端画面时算出的比例偏大，画面右侧被裁切
            display.scale(Math.min(
                window.innerHeight / display.getHeight(),
                window.innerWidth / display.getWidth()
            ))
        }

        const sink = new Guacamole.InputSink();
        displayEle.appendChild(sink.getElement());
        sink.focus();

        const keyboard = new Guacamole.Keyboard(sink.getElement());

        keyboard.onkeydown = (keysym) => {
            client.sendKeyEvent(1, keysym);
            if (keysym === 65288) {
                return false;
            }
        };
        keyboard.onkeyup = (keysym) => {
            client.sendKeyEvent(0, keysym);
        };

        const sinkFocus = debounce(() => {
            sink.focus();
        });

        const mouse = new Guacamole.Mouse(element);

        mouse.onmousedown = mouse.onmouseup = function (mouseState) {
            sinkFocus();
            client.sendMouseState(mouseState);
        }

        // 鼠标移动节流：用 rAF 合并同一帧内的多次移动，只发最新位置。
        // 原实现每次 mousemove 都发一条 WebSocket 消息，快速拖动时每秒上百条，
        // 消息在浏览器→Go→guacd→RDP 链路上排队，是操作"跟手感"变差的主因。
        // 缓存坐标快照而非状态对象本身（guacamole 可能复用同一实例）。
        let pendingMouse = null;
        let mouseRafId = null;
        mouse.onmousemove = function (mouseState) {
            sinkFocus();
            pendingMouse = {
                x: mouseState.x, y: mouseState.y,
                left: mouseState.left, middle: mouseState.middle, right: mouseState.right,
                up: mouseState.up, down: mouseState.down
            };
            if (mouseRafId !== null) {
                return;
            }
            mouseRafId = requestAnimationFrame(() => {
                mouseRafId = null;
                // 组件已卸载/断开时丢弃待发的移动（rAF 可能在此之后才触发）
                if (!pendingMouse || manualCloseRef.current) {
                    return;
                }
                const snapshot = pendingMouse;
                pendingMouse = null;
                const scale = client.getDisplay().getScale();
                client.getDisplay().showCursor(false);
                client.sendMouseState(new Guacamole.Mouse.State({
                    x: snapshot.x / scale,
                    y: snapshot.y / scale,
                    left: snapshot.left,
                    middle: snapshot.middle,
                    right: snapshot.right,
                    up: snapshot.up,
                    down: snapshot.down
                }));
            });
        };

        const touch = new Guacamole.Mouse.Touchpad(element); // or Guacamole.Touchscreen

        // 触摸同样节流（手指滑动时事件频率更高，手机上收益更明显）
        let pendingTouch = null;
        let touchRafId = null;
        touch.onmousedown = touch.onmouseup = function (state) {
            client.sendMouseState(state);
        };
        touch.onmousemove = function (state) {
            pendingTouch = {
                x: state.x, y: state.y,
                left: state.left, middle: state.middle, right: state.right,
                up: state.up, down: state.down
            };
            if (touchRafId !== null) {
                return;
            }
            touchRafId = requestAnimationFrame(() => {
                touchRafId = null;
                if (!pendingTouch || manualCloseRef.current) {
                    return;
                }
                const s = pendingTouch;
                pendingTouch = null;
                client.sendMouseState(new Guacamole.Mouse.State(s));
            });
        };



        guacdRef.current = {client, sink};
        setGuacd({
            client,
            sink,
        });
    }

    // 事件监听：依赖必须为空数组。
    // 监听器的注册/注销与「连接生命周期」无关——只要组件挂载着就该监听窗口 resize。
    useEffect(() => {
        let resize = debounce(() => {
            onWindowResize();
        });
        window.addEventListener('resize', resize);
        window.addEventListener('beforeunload', handleUnload);
        window.addEventListener('focus', handleWindowFocus);

        return () => {
            window.removeEventListener('resize', resize);
            window.removeEventListener('beforeunload', handleUnload);
            window.removeEventListener('focus', handleWindowFocus);
        };
    }, []);

    // 连接销毁：依赖必须是 [assetId]。
    //
    // 这里原本与上面的监听器写在同一个 effect 里、依赖 [guacd]，是个致命错配：
    // setGuacd({client, sink}) 每次连接都会传入新的对象字面量，React 按 Object.is
    // 比较必然判定「变了」，于是首次连接成功后立刻触发一次 cleanup，
    // 把 manualCloseRef.current 置为 true——而唯一复位它的地方在 [assetId] 的
    // effect 里，早于连接建立就已执行过。结果是「连上即标记主动关闭」，
    // tryReconnect 的重连守卫永远为真，RDP/VNC 自动重连功能整体失效。
    //
    // 规则：含单向置位语义的 cleanup，其依赖只能是生命周期标识（assetId），
    // 不能是每次连接都换引用的连接句柄。同项目 Term.js 的写法可作参照。
    useEffect(() => {
        return () => {
            // 标记主动关闭：退避定时器不再触发重连
            manualCloseRef.current = true;
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            // 断开 Guacamole 隧道：原实现不 disconnect，Guacamole 内置自动重连会使
            // 后台隧道继续存活至服务端超时（参照 GuacdMonitor.js 的正确做法）
            const current = guacdRef.current;
            if (current && current.client) {
                current.client.disconnect();
            }
        };
    }, [assetId]);

    // 注意：本函数由依赖 [] 的 resize 监听器调用，闭包捕获的是首次渲染的 guacd（空对象）。
    // 必须读 ref，否则缩放处理器永远拿不到 client、窗口缩放后画面不再自适应。
    const onWindowResize = () => {
        const current = guacdRef.current;
        if (current && current.client && !fixedSizeRef.current) {
            const display = current.client.getDisplay();
            let width = window.innerWidth;
            let height = window.innerHeight;
            setBox({width, height});
            // 同上：分别按高、宽取比再取小者（原实现两次都除 getHeight()）
            let scale = Math.min(
                height / display.getHeight(),
                width / display.getWidth()
            );
            display.scale(scale);
            current.client.sendSize(width, height);
        }
    }

    const handleUnload = (e) => {
        const message = "要离开网站吗？";
        (e || window.event).returnValue = message; //Gecko + IE
        return message;
    }

    const focus = () => {
        if (guacdRef.current.sink) {
            guacdRef.current.sink.focus();
        }
    }

    // 剪贴板同步：仅在「安全上下文 + 用户手势」下可用。
    //
    // 移动端的现实：iOS Safari 要求 readText() 由用户手势触发，且会弹出授权提示；
    // 而本函数挂在 window 的 focus 事件上（不是手势链内），因此在手机上该 Promise
    // 必然 reject。原实现只用 try/catch 包了同步调用，没有 .catch()——
    // Promise 的拒绝不会被 try/catch 捕获，会在控制台留下未处理的 rejection。
    // 这里补上 .catch，并把整个能力探测收进 Promise 链，桌面端行为不变。
    const clipboardReadable = () =>
        typeof navigator !== 'undefined' &&
        !!navigator.clipboard &&
        typeof navigator.clipboard.readText === 'function';

    const handleWindowFocus = () => {
        if (!clipboardReadable()) {
            return;
        }
        navigator.clipboard.readText()
            .then((text) => {
                if (text) {
                    sendClipboard({'data': text, 'type': 'text/plain'});
                }
            })
            .catch(() => {
                // 手机端未授权/非手势触发属预期路径，静默即可，不打扰用户
            });
    };

    const handleClipboardReceived = (stream, mimetype) => {
        if (session['copy'] === '0') {
            // message.warn('禁止复制');
            return
        }

        if (/^text\//.exec(mimetype)) {
            let reader = new Guacamole.StringReader(stream);
            let data = '';
            reader.ontext = function textReceived(text) {
                data += text;
            };
            reader.onend = async () => {
                setClipboardText(data);
                if (navigator.clipboard) {
                    await navigator.clipboard.writeText(data);
                }
                // message.success('您选择的内容已复制到您的粘贴板中，在右侧的输入框中可同时查看到。');
            };
        } else {
            let reader = new Guacamole.BlobReader(stream, mimetype);
            reader.onend = () => {
                setClipboardText(reader.getBlob());
            }
        }
    };

    const sendClipboard = (data) => {
        if (!guacdRef.current.client) {
            return;
        }
        if (session['paste'] === '0') {
            message.warn('禁止粘贴');
            return
        }
        const stream = guacdRef.current.client.createClipboardStream(data.type);
        if (typeof data.data === 'string') {
            let writer = new Guacamole.StringWriter(stream);
            writer.sendText(data.data);
            writer.sendEnd();
        } else {
            let writer = new Guacamole.BlobWriter(stream);
            writer.oncomplete = function clipboardSent() {
                writer.sendEnd();
            };
            writer.sendBlob(data.data);
        }

        if (data.data && data.data.length > 0) {
            // message.info('您输入的内容已复制到远程服务器上');
        }
    }

    const onClientStateChange = (state, sessionId) => {
        const key = 'message';
        switch (state) {
            case STATE_IDLE:
                message.destroy(key);
                message.loading({content: '正在初始化中...', duration: 0, key: key});
                break;
            case STATE_CONNECTING:
                message.destroy(key);
                message.loading({content: '正在努力连接中...', duration: 0, key: key});
                break;
            case STATE_WAITING:
                message.destroy(key);
                message.loading({content: '正在等待服务器响应...', duration: 0, key: key});
                break;
            case STATE_CONNECTED:
                Modal.destroyAll();
                message.destroy(key);
                message.destroy('reconnect');
                message.success({content: '连接成功', duration: 3, key: key});
                // 重连成功：重置计数与标记
                reconnectAttemptsRef.current = 0;
                reconnectGivenUpRef.current = false;
                reconnectingRef.current = false;
                // 向后台发送请求，更新会话的状态
                sessionApi.connect(sessionId);
                break;
            case STATE_DISCONNECTING:

                break;
            case STATE_DISCONNECTED:
                // 重连流程中主动 disconnect 产生的状态变化不提示
                if (!reconnectingRef.current) {
                    message.info({content: '连接已关闭', duration: 3, key: key});
                }
                break;
            default:
                break;
        }
    };

    const sendCombinationKey = (keys) => {
        // 读 ref：本函数可能经 guacamole 客户端回调链被调用，闭包里的 guacd 可能过期
        const current = guacdRef.current;
        if (!current || !current.client) {
            return;
        }
        for (let i = 0; i < keys.length; i++) {
            current.client.sendKeyEvent(1, keys[i]);
        }
        for (let j = 0; j < keys.length; j++) {
            current.client.sendKeyEvent(0, keys[j]);
        }
        message.success('发送组合键成功');
    }

    const showMessage = (msg) => {
        message.destroy();
        Modal.confirm({
            title: '提示',
            icon: <ExclamationCircleOutlined/>,
            content: msg,
            centered: true,
            okText: '重新连接',
            cancelText: '返回会话列表',
            onOk() {
                window.location.reload();
            },
            onCancel() {
                // 原实现是 window.close()：它只对 window.open 打开的窗口有效，
                // 而本页通常是同页跳转或直接输入 URL 进入，点击后**静默无反应**，
                // 用户留在已断线的黑屏页；PWA 独立窗口下更是 100% 无效。
                // 改为跳回会话列表（与 Term.js 的「断开连接并返回」保持一致）。
                manualCloseRef.current = true;
                window.location.href = '/#/online-session';
            },
        });
    }

    // 重连：指数退避（1s/2s/4s/8s/16s，最多 5 次），重建 tunnel+client 挂接同一 guacd 隧道
    const tryReconnect = () => {
        if (manualCloseRef.current || reconnectGivenUpRef.current) {
            return;
        }
        if (reconnectAttemptsRef.current >= 5) {
            reconnectGivenUpRef.current = true;
            reconnectingRef.current = false;
            showMessage('连接已断开，自动重连失败，请重新连接。');
            return;
        }
        reconnectAttemptsRef.current += 1;
        reconnectingRef.current = true;
        const attempt = reconnectAttemptsRef.current;
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
        message.destroy();
        message.loading({content: `连接断开，${delay / 1000}s 后重连（第 ${attempt}/5 次）...`, duration: 0, key: 'reconnect'});
        reconnectTimerRef.current = setTimeout(() => {
            message.destroy('reconnect');
            if (manualCloseRef.current || reconnectGivenUpRef.current) {
                return;
            }
            // 销毁旧 client（断开旧 ws），重建 tunnel+client 携带重连令牌挂接同一隧道。
            // 读 ref：本回调经客户端状态回调链触发，闭包里的 guacd 可能是上一轮渲染的值
            if (guacdRef.current && guacdRef.current.client) {
                guacdRef.current.client.disconnect();
            }
            if (sessionRef.current && sessionRef.current['id']) {
                renderDisplay(sessionRef.current['id'], protocol, width, height);
            }
        }, delay);
    }

    const onError = (status) => {
        // 网络层瞬断（ws 异常关闭映射 UPSTREAM_NOT_FOUND=516 / UPSTREAM_UNAVAILABLE=520）
        // → 自动重连；业务状态码（如 802 管理员强制断开）→ 保持原弹窗逻辑
        if ((status.code === 516 || status.code === 520) && !manualCloseRef.current && !reconnectGivenUpRef.current) {
            tryReconnect();
            return;
        }
        switch (status.code) {
            case 256:
                showMessage('未支持的访问');
                break;
            case 512:
                showMessage('远程服务异常，请检查目标设备能否正常访问。');
                break;
            case 513:
                showMessage('服务器忙碌');
                break;
            case 514:
                showMessage('服务器连接超时');
                break;
            case 515:
                showMessage('远程服务异常');
                break;
            case 516:
                showMessage('资源未找到');
                break;
            case 517:
                showMessage('资源冲突');
                break;
            case 518:
                showMessage('资源已关闭');
                break;
            case 519:
                showMessage('远程服务未找到');
                break;
            case 520:
                showMessage('远程服务不可用');
                break;
            case 521:
                showMessage('会话冲突');
                break;
            case 522:
                showMessage('会话连接超时');
                break;
            case 523:
                showMessage('会话已关闭');
                break;
            case 768:
                showMessage('网络不可达');
                break;
            case 769:
                showMessage('服务器密码验证失败');
                break;
            case 771:
                showMessage('客户端被禁止');
                break;
            case 776:
                showMessage('客户端连接超时');
                break;
            case 781:
                showMessage('客户端异常');
                break;
            case 783:
                showMessage('错误的请求类型');
                break;
            case 800:
                showMessage('会话不存在');
                break;
            case 801:
                showMessage('创建隧道失败，请检查Guacd服务是否正常。');
                break;
            case 802:
                showMessage('管理员强制关闭了此会话');
                break;
            default:
                if (status.message) {
                    // guacd 无法处理中文字符，所以进行了base64编码。
                    showMessage(Base64.decode(status.message));
                } else {
                    showMessage('未知错误。');
                }

        }
    };

    const fullScreen = () => {
        if (fullScreened) {
            exitFull();
            setFullScreened(false);
            focus();
            return;
        }
        // 原实现无条件 setFullScreened(true)：iPhone Safari 对非媒体元素不支持全屏 API，
        // 调用是空操作，但图标照样翻转 —— 用户以为进了全屏，其实什么都没发生。
        // 改为以「是否真正发起」为准，未生效时给出可执行的替代建议。
        if (requestFullScreen(document.documentElement)) {
            setFullScreened(true);
        } else {
            message.info('当前浏览器不支持网页全屏，可横屏使用，或用浏览器的「添加到主屏幕」获得全屏体验');
        }
        focus();
    }

    const hotKeyMenu = (
        <Menu>
            <Menu.Item key={'ctrl+alt+delete'}
                       onClick={() => sendCombinationKey(['65507', '65513', '65535'])}>Ctrl+Alt+Delete</Menu.Item>
            <Menu.Item key={'ctrl+alt+backspace'}
                       onClick={() => sendCombinationKey(['65507', '65513', '65288'])}>Ctrl+Alt+Backspace</Menu.Item>
            <Menu.Item key={'windows+d'}
                       onClick={() => sendCombinationKey(['65515', '100'])}>Windows+D</Menu.Item>
            <Menu.Item key={'windows+e'}
                       onClick={() => sendCombinationKey(['65515', '101'])}>Windows+E</Menu.Item>
            <Menu.Item key={'windows+r'}
                       onClick={() => sendCombinationKey(['65515', '114'])}>Windows+R</Menu.Item>
            <Menu.Item key={'windows+x'}
                       onClick={() => sendCombinationKey(['65515', '120'])}>Windows+X</Menu.Item>
            <Menu.Item key={'windows'}
                       onClick={() => sendCombinationKey(['65515'])}>Windows</Menu.Item>
        </Menu>
    );

    return (
        <div>
            {/* 移动端返回入口。
                PWA standalone（manifest display: standalone，iOS 添加到主屏）下
                没有浏览器返回键，而本页是铺满全屏的远端桌面、没有任何导航栏——
                连上 RDP 后想回会话列表，此前只能杀掉 App 重开。
                本组件原先完全没有移动端分支（全文 isMobile 零命中）。
                放在左上角是为了避开右上角那组悬浮按钮；返回本身不断开会话，
                服务端在 ws 断开后按宽限期回收。 */}
            {isMobile && <BackButton to="/#/online-session" text="返回"/>}
            <div className="container" style={{
                width: box.width,
                height: box.height,
                margin: '0 auto',
                backgroundColor: '#1b1b1b'
            }}>
                <div id="display"/>
            </div>

            <Draggable>
                <Affix style={{position: 'absolute', top: 50, right: 50}}>
                    <Button icon={<ExpandOutlined/>} onClick={() => {
                        fullScreen();
                    }}/>
                </Affix>
            </Draggable>

            {
                session['copy'] === '1' || session['paste'] === '1' ?
                    <Draggable>
                        <Affix style={{position: 'absolute', top: 50, right: 100}}>
                            <Button icon={<CopyOutlined/>}
                                    onClick={() => {
                                        setClipboardVisible(true);
                                    }}/>
                        </Affix>
                    </Draggable> : undefined
            }


            {
                protocol === 'vnc' &&
                <Draggable>
                    <Affix style={{position: 'absolute', top: 100, right: 100}}>
                        <Dropdown overlay={hotKeyMenu} trigger={['click']} placement="bottomLeft">
                            <Button icon={<WindowsOutlined/>}/>
                        </Dropdown>
                    </Affix>
                </Draggable>
            }

            {
                (protocol === 'rdp' && session['fileSystem'] === '1') &&
                <Draggable>
                    <Affix style={{position: 'absolute', top: 100, right: 50}}>
                        <Button icon={<FolderOutlined/>} onClick={() => {
                            setFileSystemVisible(true);
                        }}/>
                    </Affix>
                </Draggable>
            }

            {
                protocol === 'rdp' &&
                <Draggable>
                    <Affix style={{position: 'absolute', top: 100, right: 100}}>
                        <Dropdown overlay={hotKeyMenu} trigger={['click']} placement="bottomLeft">
                            <Button icon={<WindowsOutlined/>}/>
                        </Dropdown>
                    </Affix>
                </Draggable>
            }

            <Drawer
                title={'文件管理'}
                placement="right"
                width={window.innerWidth * 0.8}
                closable={true}
                onClose={() => {
                    focus();
                    setFileSystemVisible(false);
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

            <GuacdClipboard
                visible={clipboardVisible}
                clipboardText={clipboardText}
                handleOk={(text) => {
                    sendClipboard({
                        'data': text,
                        'type': 'text/plain'
                    });
                    setClipboardText(text);
                    setClipboardVisible(false);
                    focus();
                }}
                handleCancel={() => {
                    setClipboardVisible(false);
                    focus();
                }}
            />
        </div>
    );
};

export default Guacd;