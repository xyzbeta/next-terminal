import React from 'react';
import {Button} from "antd";
import {ArrowLeftOutlined} from "@ant-design/icons";

/**
 * 全屏页面的浮动返回入口。
 *
 * 为什么需要：监控 / 回放 / 接入这几类页面在移动端是通过「当前页 hash 跳转」打开的
 * （见 utils/window.js 的 openTinyWin——移动端浏览器会拦截 window.open），
 * 页面自身又是裸的全屏容器、没有任何导航栏。而 PWA standalone 模式下
 * （manifest.json 的 display: standalone，iOS「添加到主屏」）**根本没有浏览器返回键**，
 * 用户会被永久困在页面里，只能杀掉应用重开。
 *
 * 同类问题在 Term.js 已有正确解法（移动端「断开连接并返回」），此处抽成公共组件，
 * 供其余几个全屏页复用，避免每处各写一遍。
 */
const BackButton = ({to = '/#/online-session', text = '返回', top = 12, right = 12}) => {
    const goBack = () => {
        window.location.href = to;
    };

    return (
        <Button
            icon={<ArrowLeftOutlined/>}
            onClick={goBack}
            // 固定在右上角而非左上角：这几页的终端/播放器都从 (0,0) 铺满，
            // 放左上会盖住终端第一行最左侧的字符（TermMonitor 首行正好是
            // 「等待用户输入中…」）。右上角在这 4 个页面均无其它控件。
            style={{
                position: 'fixed',
                top,
                right,
                zIndex: 2000,
                opacity: 0.85,
            }}
        >
            {text}
        </Button>
    );
};

export default BackButton;
