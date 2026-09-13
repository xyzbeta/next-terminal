import {useEffect, useState} from 'react';
import {MOBILE_MEDIA_QUERY} from '../utils/window';

/**
 * 订阅移动端断点的变化，返回取消订阅函数。
 *
 * 抽出来是为了让 class 组件也能用同一套逻辑（Setting.js 是 class 组件，
 * 用不了 hook）。复制一遍 matchMedia 的注册/注销会漏掉 Safari 13 的
 * addListener 回退，所以这里作为唯一实现。
 */
export const subscribeIsMobile = (onChange) => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const handler = (e) => onChange(e.matches);

    // Safari 13 及更早版本没有 addEventListener，只有已废弃的 addListener，
    // 不加回退会在注册时抛 TypeError 击穿组件树；cleanup 与注册方式保持对称
    if (mql.addEventListener) {
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
};

/** 当前是否为移动端（一次性读取，不订阅变化） */
export const isMobileNow = () => window.matchMedia(MOBILE_MEDIA_QUERY).matches;

// 移动端判定 Hook。断点常量统一由 utils/window.js 提供（工具层），
// 依赖方向固定为 hook → utils，不反向依赖，无循环引用。
export const useIsMobile = () => {
    const [isMobile, setIsMobile] = useState(isMobileNow);
    useEffect(() => subscribeIsMobile(setIsMobile), []);
    return isMobile;
};
