import React from 'react';

/**
 * 底部标签栏图标（自绘）。
 *
 * 为什么不用 @ant-design/icons：
 *   那套图标是 1024 视图框的细线描边风格，缩到 22px 显示时线条发虚、笔画粗细
 *   在深色底上还会显得脏；且各图标来自不同批次，笔画粗细与圆角并不统一。
 *   底部标签栏是最高频的视觉元素，需要的是「简洁、扁平、笔画一致」。
 *
 * 这套图标统一规格：
 *   · 24×24 视图框，实际绘制区 20×20（四周留 2px 呼吸）
 *   · 只用实心形状（fill=currentColor），无描边 —— 缩小时不失真、不发虚
 *   · 圆角统一：方形 r=3，线条端点 rx=1.75（= 3.5px 线宽的一半）
 *   · 跟随父级 color，选中态由 CSS 的 is-active 控制
 *
 * 用 currentColor 而非固定颜色，是为了让「选中变蓝」只靠 CSS 一处控制。
 */

const base = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
    focusable: false,
};

/** 概览：四宫格（两块大 + 两块小，比等分四格更有节奏感，也更易辨识） */
export const IconOverview = (props) => (
    <svg {...base} {...props}>
        <rect x="2" y="2" width="9" height="11" rx="3"/>
        <rect x="13" y="2" width="9" height="6" rx="3"/>
        <rect x="2" y="15" width="9" height="7" rx="3"/>
        <rect x="13" y="10" width="9" height="12" rx="3"/>
    </svg>
);

/** 会话：终端窗口 + 提示符（一眼看出是「连接」而非普通文档） */
export const IconSession = (props) => (
    <svg {...base} {...props}>
        <path d="M4 3h16a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zm2.2 6.1a1.1 1.1 0 0 0 0 1.56L8.1 12.5l-1.9 1.84a1.1 1.1 0 0 0 1.56 1.56l2.7-2.62a1.1 1.1 0 0 0 0-1.56l-2.7-2.62a1.1 1.1 0 0 0-1.56 0zM12.6 15.4a1.1 1.1 0 1 0 0 2.2h5.2a1.1 1.1 0 0 0 0-2.2h-5.2z"/>
    </svg>
);

/** 资产：双层机架（服务端资源的标准意象） */
export const IconAsset = (props) => (
    <svg {...base} {...props}>
        <rect x="2" y="3" width="20" height="7.5" rx="2.5"/>
        <rect x="2" y="13.5" width="20" height="7.5" rx="2.5"/>
        <circle cx="6" cy="6.75" r="1.25" fill="#fff" fillOpacity=".9"/>
        <circle cx="6" cy="17.25" r="1.25" fill="#fff" fillOpacity=".9"/>
    </svg>
);

/** 我的：人像 */
export const IconMe = (props) => (
    <svg {...base} {...props}>
        <circle cx="12" cy="7.5" r="4.5"/>
        <path d="M12 14c-4.42 0-8 2.69-8 6v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-3.31-3.58-6-8-6z"/>
    </svg>
);

/** 更多：三点 */
export const IconMore = (props) => (
    <svg {...base} {...props}>
        <circle cx="5" cy="12" r="2.1"/>
        <circle cx="12" cy="12" r="2.1"/>
        <circle cx="19" cy="12" r="2.1"/>
    </svg>
);

/** 指令：代码尖括号 */
export const IconCommand = (props) => (
    <svg {...base} {...props}>
        <path d="M8.7 4.3a1.2 1.2 0 0 1 .6 1.58L5.9 15.1a1.2 1.2 0 1 1-2.2-.94L7.12 4.9a1.2 1.2 0 0 1 1.58-.6zM15.3 4.3a1.2 1.2 0 0 1 1.58.6l3.42 9.26a1.2 1.2 0 1 1-2.2.94L14.7 5.88a1.2 1.2 0 0 1 .6-1.58zM13.9 3.2a1.2 1.2 0 0 1 .7 1.55l-5.2 15.2a1.2 1.2 0 1 1-2.26-.78l5.2-15.2a1.2 1.2 0 0 1 1.56-.77z"/>
    </svg>
);

/** 文件：文件夹 */
export const IconFile = (props) => (
    <svg {...base} {...props}>
        <path d="M4 3h5.2a3 3 0 0 1 2.4 1.2l.9 1.2H20a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/>
    </svg>
);
