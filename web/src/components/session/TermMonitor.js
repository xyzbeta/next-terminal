import React, {useEffect, useState} from 'react';
import {Terminal} from "xterm";
import {FitAddon} from "xterm-addon-fit";
import {getToken} from "../../utils/utils";
import {debounce} from "../../utils/fun";
import qs from "qs";
import {wsServer} from "../../common/env";
import Message from "../access/Message";
import {useSearchParams} from "react-router-dom";
import "xterm/css/xterm.css";

const TermMonitor = () => {

    const [searchParams] = useSearchParams();
    const sessionId = searchParams.get('sessionId');
    const [box, setBox] = useState({width: window.innerWidth, height: window.innerHeight});

    const onWindowResize = (fitAddon) => {
        if (fitAddon) {
            setBox(() => {
                return {width: window.innerWidth, height: window.innerHeight}
            })
            fitAddon.fit();
        }
    };

    const init = (sessionId) => {

        const term = new Terminal({
            fontFamily: 'monaco, Consolas, "Lucida Console", monospace',
            fontSize: 14,
            theme: {
                background: '#1b1b1b'
            },
        });

        term.open(document.getElementById('terminal'));
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitAddon.fit();
        term.focus();
        term.writeln("等待用户输入中...");

        term.onData(data => {

        });

        let token = getToken();
        let params = {
            'X-Auth-Token': token
        };

        let paramStr = qs.stringify(params);
        let waiting = true;

        let webSocket = new WebSocket(`${wsServer}/sessions/${sessionId}/ssh-monitor?${paramStr}`);
        webSocket.binaryType = 'arraybuffer';

        // rAF 节流渲染
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
            if (tailTimer) clearTimeout(tailTimer);
            tailTimer = setTimeout(() => {
                if (pendingData.length > 0) {
                    if (rafId) cancelAnimationFrame(rafId);
                    flushData();
                }
            }, 30);
        };

        webSocket.onmessage = (e) => {
            const data = (e.data instanceof ArrayBuffer) ? new TextDecoder("utf-8").decode(e.data) : e.data;
            let msg = Message.parse(data);
            switch (msg['type']) {
                case Message.Connected:
                    term.clear();
                    break;
                case Message.Data:
                    if (waiting === true) {
                        waiting = false;
                        term.clear();
                    }
                    pendingData += msg['content'];
                    scheduleFlush();
                    break;
                case Message.Closed:
                    if (pendingData.length > 0) {
                        if (rafId) cancelAnimationFrame(rafId);
                        flushData();
                    }
                    term.writeln(`\x1B[1;3;31m${msg['content']}\x1B[0m `)
                    webSocket.close();
                    break;
                default:
                    break;
            }
        }

        // 网络层断开感知：原实现无 onclose，连接意外断开时页面静默冻结
        webSocket.onclose = (e) => {
            if (pendingData.length > 0) {
                if (rafId) cancelAnimationFrame(rafId);
                flushData();
            }
            term.writeln(`\x1B[1;3;31m连接已断开 (code: ${e.code})\x1B[0m `);
        }

        return [webSocket, fitAddon, term];
    }

    useEffect(() => {
        let [webSocket, fitAddon, term] = init(sessionId);
        let resize = debounce(() => {
            onWindowResize(fitAddon);
        });
        window.addEventListener('resize', resize);
        return () => {
            if (webSocket) {
                webSocket.close();
            }
            // 释放 xterm 实例（原实现泄漏完整终端实例：scrollback buffer + DOM 引用）
            if (term) {
                term.dispose();
            }
            window.removeEventListener('resize', resize);
        }
    }, [sessionId]);

    return (
        <div id='terminal'
             style={{
                 width: box.width,
                 height: box.height,
                 backgroundColor: '#1b1b1b'
             }}/>
    );
};

export default TermMonitor;