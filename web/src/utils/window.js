// 移动端断点（px）。与 src/mobile.css / components/Login.css 的媒体查询保持一致。
// 常量归属工具层：hook/use-breakpoint.js 反向 import 本文件，依赖方向单向（hook → utils），无循环引用。
export const MOBILE_BREAKPOINT = 768;

/**
 * 移动端判定媒体查询。
 *
 * 除了宽度，还必须补一条「触摸设备 + 视口矮」——纯宽度断点对**横屏手机**是失配的：
 * iPhone 14/15/16 横屏宽度为 844 / 844 / 932px，全部 > 768，
 * 于是 useIsMobile() 返回 false、mobile.css 整块媒体查询失效，整个应用退回桌面布局。
 * 后果最严重的是 Term.js 的软键盘补偿被跳过：横屏打字时终端下半屏被键盘盖住，
 * 而这正是该文件注释里专门修过的故障；同时移动端按键条消失、改为渲染桌面端拖拽按钮。
 *
 * 补的这条不会误伤其它设备：
 *   · 平板横屏（iPad 1024×768）高度 768 > 500，不匹配 → 保持桌面布局（大屏本就该如此）；
 *   · 触屏笔记本（1920×1080）主指针是 fine，且高度远超 500 → 不匹配；
 *   · 只有「主指针粗糙 + 视口高度 < 500」这一种组合会被判定为移动端，即横屏手机。
 */
export const MOBILE_MEDIA_QUERY =
    `(max-width: ${MOBILE_BREAKPOINT}px), (pointer: coarse) and (max-height: 500px)`;

/**
 * 打开监控/回放页面。
 *
 * 桌面端新开小窗、移动端走当前页 hash 导航，是**有意设计**，不是未完成的兼容处理：
 * - 桌面端：window.open 弹出独立小窗，便于与主界面并排查看；
 * - 移动端：小屏幕上并排窗口无意义，且移动端浏览器普遍拦截非用户手势链上的 window.open，
 *   因此改为 window.location.hash 导航当前页，保证点击必定有响应。
 *
 * url 形如 "#/term-monitor?sessionId=xxx"，是 HashRouter 的路由形态，
 * 赋值给 location.hash 即可被 HashRouter 识别并完成路由跳转（桌面端新开窗口同理）。
 */
export const openTinyWin = function (url, name, width, height) {
    const isMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
    if (isMobile) {
        // 移动端：当前页 hash 导航（HashRouter 兼容），规避弹窗拦截
        window.location.hash = url;
        return;
    }
    //获得窗口的垂直位置
    const top = (window.screen.availHeight - 30 - height) / 2;
    //获得窗口的水平位置
    const left = (window.screen.availWidth - 10 - width) / 2;
    window.open(url, name, `height=${height},innerHeight=${height},width=${width},innerWidth=${width},top='${top},left=${left},status=no,toolbar=no,menubar=no,location=no,resizable=no,scrollbars=0,titlebar=no`);
}

/** 设备名（UA 解析）：用于会话来源标识，多设备并存时区分具体是哪台。
 *  输出形如「iPhone · Safari 17」「Android · Chrome 126」「Mac · Chrome 126」。
 *  无法解析时按 clientType 兜底。 */
export const getClientName = (isMobile) => {
    try {
        const ua = navigator.userAgent;
        let os = '';
        let browser = '';
        if (/iPhone/.test(ua)) os = 'iPhone';
        else if (/iPad/.test(ua)) os = 'iPad';
        else if (/Android/.test(ua)) os = 'Android';
        else if (/Windows/.test(ua)) os = 'Windows';
        else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
        else if (/Linux/.test(ua)) os = 'Linux';
        if (/Edg\//.test(ua)) browser = 'Edge';
        else if (/CriOS|Chrome\//.test(ua)) browser = 'Chrome';
        else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
        else if (/Firefox\//.test(ua)) browser = 'Firefox';
        const ver = /(?:Version|Chrome|CriOS|Edg|Firefox)\/(\d+)/.exec(ua);
        if (os || browser) {
            return (os ? os : '') + (browser ? ' · ' + browser : '') + (ver ? ' ' + ver[1] : '');
        }
    } catch (e) { /* UA 不可用时兜底 */ }
    return isMobile ? '手机端' : '电脑端';
};
