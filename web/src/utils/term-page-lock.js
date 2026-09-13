// 终端页对文档全局样式的锁定/还原，收拢为幂等的一对函数。
//
// 背景与教训：终端页是 position:fixed 的全屏容器，为对抗 iOS 的聚焦滚动/
// 橡皮筋/双指缩放，必须临时修改 body/html 的 6 项全局样式（height×2、
// overflow×2、overscrollBehavior×2、touchAction）。此前这些修改与还原
// **散在 Term.js 的三个 effect 里**，还原完全依赖 React cleanup 按挂载序
// 完美执行 —— 任何一步抛错（如排在最前的 xterm.dispose）都会中断后续还原，
// 把下一个页面渲染在错误的视口里。这是「断开连接后白屏」的重大嫌疑。
//
// 收敛后：
//   · unlock() 幂等：任何路径（断开、返回、错误边界重置、重复调用）都安全；
//   · disconnectAndBack 在导航/重载前**主动** unlock，不依赖 cleanup 时机；
//   · lock() 重入安全：重复挂载（React 18 严格模式、热更）不会覆盖已存基线。

let locked = false;
let saved = null;

/** 终端页挂载时调用：锁定页面滚动/回弹/缩放，基线存起来供还原 */
export const lockTerminalPage = () => {
    if (locked) {
        return;
    }
    const doc = document.documentElement;
    const body = document.body;
    saved = {
        doc: {
            height: doc.style.height,
            overflow: doc.style.overflow,
            overscrollBehaviorY: doc.style.overscrollBehaviorY,
        },
        body: {
            height: body.style.height,
            overflow: body.style.overflow,
            overscrollBehaviorY: body.style.overscrollBehaviorY,
            touchAction: body.style.touchAction,
        },
    };
    // 初始高度 100%：实际值随后由 applySize 按 visualViewport 持续覆盖
    doc.style.height = '100%';
    body.style.height = '100%';
    doc.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    // iOS 在 overflow:hidden 下仍会橡皮筋回弹；overscroll-behavior 才是关掉回弹的那一项
    doc.style.overscrollBehaviorY = 'none';
    body.style.overscrollBehaviorY = 'none';
    // 禁双指缩放（index.html 的 user-scalable=no 被 iOS Safari/Chrome 忽略）；
    // pan-x pan-y 保留平移，不影响终端触摸滑动与抽屉滚动
    body.style.touchAction = 'pan-x pan-y';
    locked = true;
};

/** 还原文档全局样式。幂等：未锁定或重复调用均为空操作 */
export const unlockTerminalPage = () => {
    if (!locked || !saved) {
        return;
    }
    const doc = document.documentElement;
    const body = document.body;
    doc.style.height = saved.doc.height;
    doc.style.overflow = saved.doc.overflow;
    doc.style.overscrollBehaviorY = saved.doc.overscrollBehaviorY;
    body.style.height = saved.body.height;
    body.style.overflow = saved.body.overflow;
    body.style.overscrollBehaviorY = saved.body.overscrollBehaviorY;
    body.style.touchAction = saved.body.touchAction;
    locked = false;
    saved = null;
};

export const isTerminalPageLocked = () => locked;
