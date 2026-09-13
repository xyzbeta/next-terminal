import React, {useEffect, useState} from 'react';
import {Button} from 'antd';
import Landing from './Landing';

/**
 * 路由级 Suspense 的 fallback。
 *
 * 为什么不能直接用 `<Landing/>`：React.lazy 的 promise 若**既不 resolve 也不 reject**
 * （例如 chunk 请求被 Service Worker 或网络层挂住），Suspense 会永远停在 fallback，
 * 页面上没有任何错误、没有任何可点的东西 —— 用户看到的就是「一直加载中」的白屏，
 * 唯一出路是手动上滑杀掉应用再重进。
 *
 * 实测复现：拦截 `*.chunk.js` 使其不响应，页面在「正在努力加载中」卡住 23 秒以上，
 * 控制台无任何报错。这正是用户反馈的 PWA 冷启动现象。
 *
 * 因此这里加一道时间兜底：
 *   · 超过 STALL_MS 仍未渲染出内容 → 自动整页重载一次（webpack 的 chunk 加载器
 *     会把失败/挂起的请求缓存住，单纯重试同一个 import 无效，必须重载让 runtime 重新初始化）；
 *   · 若重载后又卡住，说明不是偶发，改为显示按钮交给用户决定，避免无限刷新循环。
 *
 * 自动重载仅在「距上次自动重载超过 RELOAD_COOLDOWN_MS」时执行 —— 这个时间窗口
 * 既拦住了死循环，又不需要在成功加载后显式清除标记（下次卡住若已过窗口，仍能自救）。
 */

const STALL_MS = 15000;
const RELOAD_COOLDOWN_MS = 30000;
const RELOAD_KEY = 'nt-stall-reload-at';

const RouteFallback = () => {
    const [stalled, setStalled] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            let last = 0;
            try {
                last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
            } catch (e) {
                /* 隐私模式不可读，按「从未重载过」处理 */
            }
            if (Date.now() - last > RELOAD_COOLDOWN_MS) {
                try {
                    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
                } catch (e) {
                    /* 写不进去就退化为「每次都自动重载一次」，由窗口判断兜底 */
                }
                window.location.reload();
                return; // 保持 Landing 直到页面开始重载
            }
            setStalled(true);
        }, STALL_MS);
        return () => clearTimeout(timer);
    }, []);

    if (!stalled) {
        return <Landing/>;
    }

    return (
        <div style={{
            minHeight: '60vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            textAlign: 'center',
        }}>
            <div style={{fontSize: 14, color: 'rgba(0,0,0,.65)'}}>页面资源加载失败</div>
            <div style={{fontSize: 12, color: 'rgba(0,0,0,.45)', lineHeight: 1.6}}>
                可能是网络不稳定或缓存未就绪。<br/>重新加载通常即可恢复。
            </div>
            <Button type="primary" onClick={() => window.location.reload()}>重新加载</Button>
        </div>
    );
};

export default RouteFallback;
