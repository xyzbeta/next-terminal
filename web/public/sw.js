/*
 * Next Terminal 的 Service Worker —— 只做「静态外壳」缓存，绝不触碰业务数据。
 *
 * 安全边界（堡垒机场景）：
 *   · 仅处理 GET 且同源的请求；
 *   · 仅缓存构建产物（.js/.css/字体/图标等静态资源），API、会话、上传下载一律直连、不落缓存；
 *   · 不拦截 index.html / manifest.json / sw.js —— 它们由服务端发 no-cache，
 *     且 index.html 的内容是「指向 main.<hash>.js 的入口」，一旦被缓存住，
 *     发版后就会指向已从镜像中消失的旧 chunk（404 → 白屏）。
 *
 * 说明：Service Worker 仅在安全上下文（HTTPS 或 localhost）注册，
 * 纯 HTTP 部署下浏览器不会启用它——此时仅 manifest 与 iOS 全屏 meta 生效。
 *
 * ── 2026-09-12 缓存策略由「网络优先」改为「缓存优先 + 后台更新」──
 *
 * 起因（用户反馈）：PWA 从桌面图标冷启动后，登录页能打开，但点登录后
 * 永久停在「正在努力加载中」；上滑退出再打开一次就正常。
 *
 * 复现结论：该界面是 Suspense 的 fallback —— 路由 chunk 的请求既不成功也不失败，
 * 于是 React.lazy 的 promise 永远 pending。而旧实现 `fetch(request).catch(...)`
 * 在网络请求挂起时（PWA 冷启动、SW 刚被唤醒、网络栈未就绪）会**永久挂起**，
 * respondWith 不 settle，页面的 fetch 就永远等下去。实测挂起 23 秒仍无任何错误。
 *
 * 两个改动：
 *   ① 缓存优先：构建产物的文件名都带 content hash，内容变了文件名就变了，
 *      所以「命中缓存直接返回」永远不会拿到过期内容；命中时后台仍会拉一次网络
 *      更新缓存，供下次使用。冷启动因此不再依赖网络就绪。
 *   ② 网络请求加超时：缓存未命中时（发版后的新 chunk）若网络挂起，
 *      10 秒后中止并回退缓存，避免把「挂起」传导给页面。
 */

const CACHE_NAME = 'nt-shell-v2';

// 只缓存这些扩展名的资源（构建产物 + 图标），其余一律放行给网络
const CACHEABLE = /\.(?:js|css|woff2?|ttf|eot|png|jpe?g|gif|svg|ico|webp)$/i;

// 网络请求超时：超时后中止并回退缓存，避免请求永久挂起
const NETWORK_TIMEOUT_MS = 10000;

// 缓存条目上限。产物文件名带 hash，发版即产生新条目，旧条目再也不会被请求；
// 不设上限会随发版次数无限增长（本项目曾一天迭代十余个版本）。
// 超出后按插入顺序删最旧的（Cache.keys() 即插入顺序）。
const MAX_ENTRIES = 150;

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

/** 带超时的 fetch：AbortController 中止后进入 catch，回退到缓存 */
const fetchWithTimeout = (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    return fetch(request, {signal: controller.signal})
        .finally(() => clearTimeout(timer));
};

/** 缓存写入 + 容量裁剪（不阻塞响应返回） */
const putAndTrim = (request, response) => {
    caches.open(CACHE_NAME).then((cache) =>
        cache.put(request, response)
            .then(() => cache.keys())
            .then((keys) => {
                if (keys.length <= MAX_ENTRIES) {
                    return;
                }
                const excess = keys.slice(0, keys.length - MAX_ENTRIES);
                return Promise.all(excess.map((k) => cache.delete(k)));
            })
    ).catch(() => { /* 配额满/隐私模式：缓存失败不影响请求本身 */ });
};

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') {
        return;
    }
    let url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return;
    }
    // 跨域与静态资源之外的一律不介入（API、预览、上传下载、WebSocket 等）
    if (url.origin !== self.location.origin || !CACHEABLE.test(url.pathname)) {
        return;
    }
    event.respondWith(
        caches.match(request).then((cached) => {
            // 后台更新：无论是否命中缓存都拉一次网络，成功则刷新缓存供下次使用。
            // catch 里回退 cached —— 这里必须接住，否则网络失败会成为未处理的 rejection。
            const network = fetchWithTimeout(request)
                .then((response) => {
                    if (response && response.ok) {
                        putAndTrim(request, response.clone());
                    }
                    return response;
                })
                .catch(() => cached || Response.error());

            // 命中缓存：立即返回，不等待网络（这正是冷启动不再卡住的原因）
            return cached || network;
        })
    );
});
