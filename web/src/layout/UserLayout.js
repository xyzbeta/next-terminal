import React, {Suspense, useEffect} from 'react';
import {Link, Outlet, useLocation, useNavigate} from "react-router-dom";
import {Breadcrumb, Button, Dropdown, Layout, Menu, Popconfirm} from "antd";
import {
    CodeOutlined,
    DashboardOutlined,
    DesktopOutlined,
    DownOutlined,
    LogoutOutlined,
    UserOutlined
} from "@ant-design/icons";
import {getCurrentUser, isAdmin} from "../service/permission";
import FooterComponent from "./FooterComponent";
import accountApi from "../api/account";
import LogoWithName from "../images/logo-with-name.png";
import Landing from "../components/Landing";
import {setTitle} from "../hook/title";
import MobileTabBar from "./MobileTabBar";
import {useIsMobile} from "../hook/use-breakpoint";

const {Header, Content} = Layout;

const breadcrumbNameMap = {
    '/my-asset': '我的资产',
    '/my-command': '我的指令',
    '/my-info': '个人中心',
};

const UserLayout = () => {

    const location = useLocation();
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    // 普通用户的可见菜单（用于底部标签栏按权限择项）
    const userMenus = (getCurrentUser() || {})['menus'] || [];

    let _current = location.pathname.split('/')[1];

    useEffect(() => {
        setTitle(breadcrumbNameMap['/' + _current]);
    }, [_current]);

    const pathSnippets = location.pathname.split('/').filter(i => i);

    const extraBreadcrumbItems = pathSnippets.map((_, index) => {
        const url = `/${pathSnippets.slice(0, index + 1).join('/')}`;
        return (
            <Breadcrumb.Item key={url}>
                <Link to={url}>{breadcrumbNameMap[url]}</Link>
            </Breadcrumb.Item>
        );
    });

    const breadcrumbItems = [
        <Breadcrumb.Item key="home">
            <Link to="/my-asset">首页</Link>
        </Breadcrumb.Item>,
    ].concat(extraBreadcrumbItems);

    const menu = (
        <Menu>
            {
                isAdmin() &&
                <Menu.Item>
                    <Link to={'/dashboard'}><DashboardOutlined/> 后台管理</Link>
                </Menu.Item>
            }

            <Menu.Item>
                <Popconfirm
                    key='login-btn-pop'
                    title="您确定要退出登录吗?"
                    onConfirm={async ()=>{
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

    return (
        <Layout className="layout" style={{minHeight: '100vh'}}>
            <Header style={{padding: 0}}>
                <div className='km-header'>
                    <div style={{flex: '1 1 0%'}}>
                        <Link to={'/my-asset'}>
                            <img src={LogoWithName} alt='logo' width={120}/>
                        </Link>

                        <Link to={'/my-asset'}>
                            <Button type="text" style={{color: 'white'}}
                                    icon={<DesktopOutlined/>}>
                                我的资产
                            </Button>
                        </Link>

                        <Link to={'/my-command'}>
                            <Button type="text" style={{color: 'white'}}
                                    icon={<CodeOutlined/>}>
                                我的指令
                            </Button>
                        </Link>

                        <Link to={'/my-info'}>
                            <Button type="text" style={{color: 'white'}}
                                    icon={<UserOutlined/>}>
                                个人中心
                            </Button>
                        </Link>

                    </div>
                    <div className='km-header-right'>
                        <Dropdown overlay={menu}>
                            <div className={'nickname layout-header-right-item'}>
                                {getCurrentUser()['nickname']} &nbsp;<DownOutlined/>
                            </div>
                        </Dropdown>
                    </div>
                </div>
            </Header>

            <Content className='nt-container'>
                <div style={{marginBottom: 16}}>
                    <Breadcrumb>{breadcrumbItems}</Breadcrumb>
                </div>
                <Suspense fallback={<Landing/>}>
                    <Outlet/>
                </Suspense>
            </Content>
            {/* 移动端不渲染页脚（App 里没有页脚，且会与底部标签栏形成双重底栏） */}
            {!isMobile && <FooterComponent/>}

            {/* 普通用户在手机上同样需要应用级导航：
                此前只有管理端（ManagerLayout）有底部标签栏，
                而普通用户（手机上最典型的角色）落在 UserLayout，
                拿到的仍是桌面式的顶部横向导航。 */}
            {isMobile && (
                <MobileTabBar
                    variant="user"
                    userMenus={userMenus}
                    pathname={location.pathname}
                    navigate={navigate}
                />
            )}
        </Layout>
    );
}

export default UserLayout;