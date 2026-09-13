// 测试环境全局桩。CRA 5 会自动加载 src/setupTests.js（无需改 package.json / config-overrides.js）。
// 注意：不要在此 import @testing-library/jest-dom —— 本项目未安装该依赖。

// jest-environment-jsdom 27 内置 jsdom 16.x，未实现 window.matchMedia（typeof 为 undefined）。
// 凡渲染用到 useIsMobile 的组件（ManagerLayout / Asset / Term / OnlineSession 等）都会直接抛 TypeError，
// 因此这里补一个最小可用实现。
//
// 刻意采用真实宽度判断而非恒返回 false：
// matches 由 window.innerWidth 与媒体查询中的宽度条件比较得出，
// 测试只需设置 window.innerWidth（如 375）即可真实模拟移动端。
// 附带好处：即便将来 jsdom 自带 matchMedia（新版本仅返回恒 false 的空壳，不求值宽度），
// 本桩也会覆盖它，保证断点相关用例行为一致。

// 从媒体查询字符串中解析指定宽度特性的像素值，未出现则返回 null
const parseWidthPx = (query, feature) => {
    const matched = new RegExp(`\\(\\s*${feature}\\s*:\\s*([\\d.]+)px\\s*\\)`).exec(query);
    return matched ? parseFloat(matched[1]) : null;
};

const evaluateMediaQuery = (query) => {
    const maxWidth = parseWidthPx(query, 'max-width');
    const minWidth = parseWidthPx(query, 'min-width');
    // 本桩只实现宽度断点；不含宽度条件的查询（如 prefers-color-scheme）一律视为不匹配
    if (maxWidth === null && minWidth === null) {
        return false;
    }
    const width = window.innerWidth;
    if (maxWidth !== null && width > maxWidth) {
        return false;
    }
    if (minWidth !== null && width < minWidth) {
        return false;
    }
    return true;
};

const mediaQueryLists = new Map();

const createMediaQueryList = (query) => {
    const listeners = new Set();
    const mql = {
        media: query,
        // 用 getter 而非固定值：改完 window.innerWidth 后无需重建实例即可读到新结果
        get matches() {
            return evaluateMediaQuery(query);
        },
        addEventListener(type, listener) {
            if (type === 'change' && listener) {
                listeners.add(listener);
            }
        },
        removeEventListener(type, listener) {
            listeners.delete(listener);
        },
        // 旧版 API（Safari 13 及更早），与 useIsMobile 中的回退分支互为镜像
        addListener(listener) {
            if (listener) {
                listeners.add(listener);
            }
        },
        removeListener(listener) {
            listeners.delete(listener);
        },
        onchange: null,
        // 供测试主动模拟 resize：改完 innerWidth 后调用即可触发 change 回调
        dispatchEvent(event) {
            listeners.forEach((listener) => listener(event));
            if (typeof mql.onchange === 'function') {
                mql.onchange(event);
            }
            return true;
        }
    };
    return mql;
};

Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query) => {
        // 与浏览器行为一致：同一查询字符串复用同一个 MediaQueryList 实例，
        // 这样测试可以通过 window.matchMedia(query) 拿到组件内部使用的同一实例并对其 dispatchEvent
        if (!mediaQueryLists.has(query)) {
            mediaQueryLists.set(query, createMediaQueryList(query));
        }
        return mediaQueryLists.get(query);
    }
});
