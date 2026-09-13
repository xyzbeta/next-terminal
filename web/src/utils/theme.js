// 外观主题：跟随系统 / 浅色 / 深色。
//
// 架构（v1.4.51 重构）：**「跟随系统」完全交给浏览器层**，JS 只处理手动覆盖。
//
// 为什么重构：真机（iOS Web Clip）实测 `prefers-color-scheme` 的 **JS** 媒体查询
// 不可靠（跟随系统判定失效、页面保持浅色），而 CSS 层的媒体查询与
// <meta name="color-scheme"> 是同源信号、可靠（同一环境里 antd 表单控件已正确变暗）。
// 因此：
//   · antd.dark.css：index.html 里的 <link media="(prefers-color-scheme: dark)">
//     由浏览器自动启用/停用；
//   · 自定义样式：dark-theme.css 用 CSS 变量 + @media 查询（同源信号）；
//   · JS 只做手动覆盖：dataset.theme=light/dark + 改 link 的 media（dark→"all"，
//     light→"not all"）。auto 时 dataset.theme 不设置、link media 恢复原值。

const STORAGE_KEY = 'nt_theme'; // auto | light | dark
const DARK_CSS_ID = 'nt-antd-dark-css';
const AUTO_MEDIA = '(prefers-color-scheme: dark)';

const getPref = () => {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'light' || v === 'dark' || v === 'auto') return v;
    } catch (e) { /* 隐私模式 */ }
    return 'auto';
};

export const applyTheme = (pref) => {
    if (pref === 'light') {
        document.documentElement.dataset.theme = 'light';
    } else if (pref === 'dark') {
        document.documentElement.dataset.theme = 'dark';
    } else {
        delete document.documentElement.dataset.theme;
    }
    const link = document.getElementById(DARK_CSS_ID);
    if (link) {
        // auto：交给浏览器（media 查询）；dark：强制启用；light：强制停用
        link.media = pref === 'dark' ? 'all' : (pref === 'light' ? 'not all' : AUTO_MEDIA);
    }
};

export const initTheme = () => {
    applyTheme(getPref());
    // auto 模式无需 JS 监听：CSS 媒体查询与 link media 由浏览器实时维护
};

export const setThemePref = (pref) => {
    try {
        localStorage.setItem(STORAGE_KEY, pref);
    } catch (e) { /* 隐私模式：仅本次会话生效 */ }
    applyTheme(pref);
};

export const getThemePref = getPref;
