import React from 'react';
import {Badge} from "antd";
import {
    IconAsset,
    IconCommand,
    IconFile,
    IconMe,
    IconMore,
    IconOverview,
    IconSession,
} from "./TabIcons";

/**
 * 移动端底部标签栏。
 *
 * 设计意图：桌面端的「左侧 Sider + 汉堡菜单 + 面包屑」是桌面范式——
 * 拇指够不到左上角，且每换一个模块要「打开抽屉 → 选一级 → 再选二级 → 关抽屉」四步。
 * 手机上的既定范式是底部标签栏：一级功能常驻拇指区、一步直达、当前位置一眼可见。
 *
 * 取舍：只放 5 个一级入口，层级更深的功能收进「更多」（复用原有抽屉的完整菜单）。
 * 这是移动端的常规做法——不是功能删减，而是入口分层。
 *
 * 标签按用户实际可访问的菜单动态生成，不会出现「点进去 403」。
 */

/** 一级标签定义。path 为 null 表示由 menuKeys 按权限择一。 */
const TAB_DEFS = [
    {
        key: 'overview', label: '概览', icon: <IconOverview/>,
        menuKeys: ['dashboard'], paths: {dashboard: '/dashboard'},
    },
    {
        key: 'session', label: '会话', icon: <IconSession/>,
        menuKeys: ['online-session', 'offline-session'],
        paths: {'online-session': '/online-session', 'offline-session': '/offline-session'},
    },
    {
        key: 'asset', label: '资产', icon: <IconAsset/>,
        menuKeys: ['asset', 'my-asset'],
        paths: {asset: '/asset', 'my-asset': '/my-asset'},
    },
    // 第 4 个标签的变迁：「运维」→「我的」→ 移除（2026-09-12 用户反馈「我的按钮
    // 其实没什么用」）。个人中心与系统设置本就是低频配置项，占着一级拇指位不划算，
    // 二者仍在「更多」抽屉里，入口没有消失。管理端底部栏因此固定为
    // 「概览 / 会话 / 资产 / 更多」四个，把腾出的宽度留给前三项。
    //
    // ⚠️ 只删管理端的：普通用户的 USER_TAB_DEFS 保留「我的」（my-info）——
    // 那是普通用户唯一的个人中心入口，删掉就再也进不去了。
];

/** 普通用户（UserLayout）的一级标签：只有自己的资产/指令/文件/个人中心 */
const USER_TAB_DEFS = [
    {
        key: 'asset', label: '资产', icon: <IconAsset/>,
        menuKeys: ['my-asset'], paths: {'my-asset': '/my-asset'},
    },
    {
        key: 'command', label: '指令', icon: <IconCommand/>,
        menuKeys: ['my-command'], paths: {'my-command': '/my-command'},
    },
    {
        key: 'file', label: '文件', icon: <IconFile/>,
        menuKeys: ['my-file'], paths: {'my-file': '/my-file'},
    },
    {
        key: 'me', label: '我的', icon: <IconMe/>,
        menuKeys: ['my-info'], paths: {'my-info': '/my-info'},
    },
];

const USER_PATH_TO_TAB = {
    'my-asset': 'asset', 'my-command': 'command', 'my-file': 'file', 'my-info': 'me',
};

/** 路径 → 标签 key，用于高亮当前所在的一级模块 */
const pathToTabKey = (pathname) => {
    const first = (pathname || '').split('/')[1];
    if (['dashboard'].includes(first)) return 'overview';
    if (['online-session', 'offline-session'].includes(first)) return 'session';
    if (['asset', 'my-asset'].includes(first)) return 'asset';
    // 以下页面已不在底部栏（改由「更多」抽屉进入），故不高亮任何一级标签：
    // 原「运维」三页（系统监控/计划任务/磁盘空间）+ 原「我的」两页（个人中心/系统设置）
    return null;
};

const MobileTabBar = ({userMenus, pathname, navigate, onMore, sessionCount, variant = 'admin'}) => {
    const has = (k) => userMenus.includes(k);
    const defs = variant === 'user' ? USER_TAB_DEFS : TAB_DEFS;

    // 按权限挑出每个一级标签真正的落地路径；一个子项都没有则整个标签不渲染
    const tabs = defs.map((def) => {
        const hit = def.menuKeys.find((k) => has(k));
        if (!hit) {
            return null;
        }
        return {key: def.key, label: def.label, icon: def.icon, path: def.paths[hit]};
    }).filter(Boolean);

    const activeKey = variant === 'user'
        ? USER_PATH_TO_TAB[(pathname || '').split('/')[1]]
        : pathToTabKey(pathname);

    return (
        <nav className="nt-tabbar" role="navigation" aria-label="主导航">
            {tabs.map((t) => (
                <button
                    type="button"
                    key={t.key}
                    className={`nt-tabbar-item${activeKey === t.key ? ' is-active' : ''}`}
                    aria-current={activeKey === t.key ? 'page' : undefined}
                    onClick={() => navigate(t.path)}
                >
                    <span className="nt-tabbar-icon">
                        {/* 在线会话数做成角标：运维最关心的一个数字，省掉一次进入操作 */}
                        {t.key === 'session' && sessionCount > 0 ? (
                            <Badge count={sessionCount} size="small" offset={[2, -2]}>
                                {t.icon}
                            </Badge>
                        ) : t.icon}
                    </span>
                    <span className="nt-tabbar-label">{t.label}</span>
                </button>
            ))}
            {/* 「更多」是管理端的逃生口（抽屉里有完整菜单）。
                普通用户 4 个页面全在标签里，不需要额外入口。 */}
            {variant !== 'user' && (
            <button
                type="button"
                className="nt-tabbar-item"
                onClick={onMore}
                aria-label="更多功能"
            >
                <span className="nt-tabbar-icon">
                    <IconMore/>
                </span>
                <span className="nt-tabbar-label">更多</span>
            </button>
            )}
        </nav>
    );
};

export default MobileTabBar;
