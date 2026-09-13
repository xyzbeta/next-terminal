import React, {Suspense, useEffect, useState} from 'react';
import {Alert, Breadcrumb, Button, Drawer, Dropdown, Layout, Menu, Popconfirm} from "antd";
import {DesktopOutlined, DownOutlined, LogoutOutlined} from "@ant-design/icons";
import {Link, Outlet, useLocation, useNavigate} from "react-router-dom";
import {getCurrentUser} from "../service/permission";
import LogoWithName from "../images/logo-with-name.png";
import Logo from "../images/logo.png";
import FooterComponent from "./FooterComponent";
import accountApi from "../api/account";
import sessionApi from "../api/session";
import {routers} from "./router";
import RouteFallback from "../components/RouteFallback";
import ErrorBoundary from "../components/ErrorBoundary";
import MobileTabBar from "./MobileTabBar";
import {setTitle} from "../hook/title";
import {useIsMobile} from "../hook/use-breakpoint";
import {clearRequestFailure, subscribeRequestStatus} from "../service/request-status";

const {Sider, Header} = Layout;

const breadcrumbMatchMap = {
    '/asset/': '资产详情',
    '/user/': '用户详情',
    '/role/': '角色详情',
    '/user-group/': '用户组详情',
    '/login-policy/': '登录策略详情',
    '/command-filter/': '命令过滤器详情',
    '/strategy/': '授权策略详情',
};
const breadcrumbNameMap = {};

routers.forEach(r => {
    if (r.children) {
        r.children.forEach(c => {
            breadcrumbNameMap['/' + c.key] = c.label;
        })
    } else {
        breadcrumbNameMap['/' + r.key] = r.label;
    }
});

const ManagerLayout = () => {

    const location = useLocation();
    const navigate = useNavigate();

    let currentUser = getCurrentUser();

    let userMenus = currentUser['menus'] || [];
    let menus = routers.filter(router => userMenus.includes(router.key)).map(router => {
        if (router.children) {
            router.children = router.children.filter(r => userMenus.includes(r.key));
        }
        return router;
    });

    let [collapsed, setCollapsed] = useState(false);
    // Mobile: the fixed Sider is replaced by a Drawer with the same menu
    let [drawerVisible, setDrawerVisible] = useState(false);
    const isMobile = useIsMobile();

    // 最近一次请求失败：以常驻横幅替代「3 秒 toast 后表格显示暂无数据」，
    // 避免把「加载失败」误读为「没有记录」
    const [requestFailure, setRequestFailure] = useState(null);
    useEffect(() => subscribeRequestStatus(setRequestFailure), []);

    // 在线会话数：作为底部标签的角标。仅移动端拉取，30s 一次——
    // 这是运维在手机上最关心的数字，做成角标可以省掉「进入在线会话页」这一步。
    const [sessionCount, setSessionCount] = useState(0);
    useEffect(() => {
        if (!isMobile || !userMenus.includes('online-session')) {
            return;
        }
        let cancelled = false;
        const load = async () => {
            try {
                const r = await sessionApi.getPaging({pageIndex: 1, pageSize: 1, status: 'connected'});
                if (!cancelled) {
                    setSessionCount(Number(r['total'] || 0));
                }
            } catch (e) {
                /* 角标失败不影响导航，静默 */
            }
        };
        load();
        const timer = setInterval(load, 30000);
        // 断开会话后立即刷新：30s 轮询会让角标在强断后延迟几秒才变化（用户实测反馈）。
        // 断开成功处 dispatch 该事件，这里即时重拉。
        window.addEventListener('nt-session-count-refresh', load);
        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener('nt-session-count-refresh', load);
        };
    }, [isMobile]);

    let _current = location.pathname.split('/')[1];

    // 顶栏标题：优先取菜单名，取不到再退回详情页映射，最后兜底为「详情」
    const currentTitle = (() => {
        const byMenu = breadcrumbNameMap[location.pathname] || breadcrumbNameMap['/' + _current];
        if (byMenu) {
            return byMenu;
        }
        for (let k in breadcrumbMatchMap) {
            if (location.pathname.includes(k)) {
                return breadcrumbMatchMap[k];
            }
        }
        return 'Next Terminal';
    })();


    let [current, setCurrent] = useState(_current);
    let [logo, setLogo] = useState(LogoWithName);
    let [logoWidth, setLogoWidth] = useState(140);
    let [openKeys, setOpenKeys] = useState(JSON.parse(sessionStorage.getItem('openKeys')));

    useEffect(() => {
        setCurrent(_current);
        setTitle(breadcrumbNameMap['/' + _current]);
    }, [_current]);

    const pathSnippets = location.pathname.split('/').filter(i => i);

    const extraBreadcrumbItems = pathSnippets.map((_, index) => {
        const url = `/${pathSnippets.slice(0, index + 1).join('/')}`;
        let label = breadcrumbNameMap[url];
        if (!label) {
            for (let k in breadcrumbMatchMap) {
                if (url.includes(k)) {
                    label = breadcrumbMatchMap[k];
                    break;
                }
            }
        }
        return (
            <Breadcrumb.Item key={url}>
                <Link to={url}>{label}</Link>
            </Breadcrumb.Item>
        );
    });

    const breadcrumbItems = [
        <Breadcrumb.Item key="home">
            <Link to="/">首页</Link>
        </Breadcrumb.Item>,
    ].concat(extraBreadcrumbItems);

    const onCollapse = () => {
        let _collapsed = !collapsed;
        if (_collapsed) {
            setLogo(Logo);
            setLogoWidth(46);
            setCollapsed(_collapsed);
        } else {
            setLogo(LogoWithName);
            setLogoWidth(140);
            setCollapsed(false);
        }
    };

    const subMenuChange = (openKeys) => {
        setOpenKeys(openKeys);
        sessionStorage.setItem('openKeys', JSON.stringify(openKeys));
    }

    const menu = (
        <Menu>
            <Menu.Item>
                <Link to={'/my-asset'}><DesktopOutlined/> 我的资产</Link>
            </Menu.Item>
            {/* 原 DEBUG 菜单项已移除：
                ① 后端从未注册 pprof（server/ 下无任何 pprof 引用），
                   而它指向的 /debug/pprof 也不是前端路由 → 任何用户点它都落 404；
                ② 它是本文件中唯一没有 hasMenu 守卫的菜单项，对所有角色可见。
                如日后确实需要暴露 pprof，应同时补后端路由与菜单权限，再恢复此项。 */}
            <Menu.Item>
                <Popconfirm
                    key='login-btn-pop'
                    title="您确定要退出登录吗?"
                    onConfirm={async () => {
                        await accountApi.logout();
                        navigate('/login');
                    }}
                    okText="确定"
                    cancelText="取消"
                    placement="left"
                >
                    <LogoutOutlined/> 退出登录
                </Popconfirm>
            </Menu.Item>
        </Menu>
    );

    // Desktop renders this menu in the fixed Sider; mobile renders it in a Drawer
    const sideMenu = (
        <>
            <div className="logo">
                <img src={logo} alt='logo' width={logoWidth}/>
            </div>

            <Menu
                onClick={(e) => {
                    navigate(e.key);
                    setCurrent(e.key);
                    if (isMobile) {
                        setDrawerVisible(false);
                    }
                }}
                selectedKeys={[current]}
                onOpenChange={subMenuChange}
                defaultOpenKeys={openKeys}
                theme="dark"
                mode="inline"
                defaultSelectedKeys={['']}
                items={menus}
            >
            </Menu>
        </>
    );

    return (
        <Layout className="layout" style={{minHeight: '100vh'}}>
            {!isMobile &&
                <Sider
                    collapsible
                    collapsed={collapsed}
                    onCollapse={onCollapse}
                    style={{
                        overflow: 'auto',
                        height: '100vh',
                        position: 'fixed',
                        left: 0,
                        top: 0,
                        bottom: 0,
                    }}
                >
                    {sideMenu}
                </Sider>
            }
            {isMobile &&
                <Drawer
                    className="nt-sider-drawer"
                    placement="left"
                    width={220}
                    closable={false}
                    headerStyle={{display: 'none'}}
                    contentStyle={{background: '#001529'}}
                    bodyStyle={{padding: 0, background: '#001529'}}
                    visible={drawerVisible}
                    onClose={() => setDrawerVisible(false)}
                >
                    {sideMenu}
                </Drawer>
            }

            <Layout className="site-layout" style={{marginLeft: isMobile ? 0 : (collapsed ? 80 : 200)}}>
                <Header style={{padding: 0, height: 60, zIndex: 20}}>
                    <div className='layout-header'>
                        <div className='layout-header-left'>
                            <div>
                                {/* 移动端顶栏只显示当前页面名，不显示面包屑路径：
                                    「首页 / 会话审计 / 在线会话」是桌面端的层级表达，
                                    手机上宽度不够只能截断成「首页 / 会话…」，信息量为零，
                                    还占掉顶栏一大半。App 的顶栏惯例就是「当前页名」。
                                    导航由底部标签栏 + 「更多」承担，不需要面包屑回溯。 */}
                                {isMobile
                                    ? <span className='nt-mobile-title'>{currentTitle}</span>
                                    : <Breadcrumb>{breadcrumbItems}</Breadcrumb>}
                            </div>
                        </div>

                        <div className='layout-header-right'>
                            {isMobile ? (
                                // 移动端顶栏右侧改为「设置」入口：昵称下拉里只有「我的资产 + 退出」，
                                // 而这两项在底部标签栏（资产标签）与「更多」里都能到达，
                                // 顶栏这块黄金位置留给高频的退出登录。
                                <Popconfirm
                                    title="您确定要退出登录吗?"
                                    onConfirm={async () => {
                                        await accountApi.logout();
                                        navigate('/login');
                                    }}
                                    okText="确定"
                                    cancelText="取消"
                                    placement="bottomRight"
                                >
                                    <div className='layout-header-right-item' aria-label="退出登录">
                                        <LogoutOutlined/>
                                    </div>
                                </Popconfirm>
                            ) : (
                                <Dropdown overlay={menu}>
                                    <div className='nickname layout-header-right-item'>
                                        {getCurrentUser()['nickname']} &nbsp;<DownOutlined/>
                                    </div>
                                </Dropdown>
                            )}
                        </div>
                    </div>
                </Header>

                {/* 请求失败常驻横幅：接口报错时表格会渲染成「暂无数据」，
                    仅靠 3 秒 toast 无法让用户区分「没有数据」与「加载失败」。
                    终端/接入页是全屏固定布局（position:fixed），横幅会穿透覆盖终端，
                    且这些页面的背景 API 调用（如 getCommands）失败对用户无意义，
                    故在这些页面不渲染横幅。 */}
                {requestFailure && !location.pathname.startsWith('/access') && (
                    <Alert
                        banner
                        closable
                        type="warning"
                        showIcon
                        style={{margin: '8px 16px 0'}}
                        message={`数据加载失败：${requestFailure.message}`}
                        description="当前列表内容可能不完整或不准确，请确认后重试，勿据此判断「没有记录」。"
                        onClose={clearRequestFailure}
                    />
                )}

                {/* 错误边界包在 Suspense 内层：单个页面渲染异常时只替换内容区，
                    导航栏与已建立的会话不受影响，用户还能切到别的页面 */}
                <div className={isMobile ? 'nt-mobile-content' : undefined}>
                    <Suspense fallback={<RouteFallback/>}>
                        <ErrorBoundary>
                            <Outlet/>
                        </ErrorBoundary>
                    </Suspense>
                </div>

                {/* 移动端不渲染页脚：App 里没有「页脚」这种概念，
                    且它会把底部标签栏顶上去造成双重底栏 */}
                {!isMobile && <FooterComponent/>}

            {isMobile && (
                <MobileTabBar
                    userMenus={userMenus}
                    pathname={location.pathname}
                    navigate={navigate}
                    onMore={() => setDrawerVisible(true)}
                    sessionCount={sessionCount}
                />
            )}
            </Layout>
        </Layout>
    );
}

export default ManagerLayout;