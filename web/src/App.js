import React, {Suspense} from 'react';
import {Outlet, Route, Routes} from "react-router-dom";

import './App.css';
import './Arco.css';
import './mobile.css';
import './dark-theme.css';

// FE-05：@ant-design/pro-components 全量样式（84KB）此前由 App.css 静态 @import 打进主包，
// 主 CSS 因此达 608KB / gzip 78KB 且渲染阻塞——只访问登录页的用户也要下载整套 ProTable 样式。
// 使用它的 29 个页面全部是下面的 React.lazy 路由，故改为运行时异步 import：
// webpack 拆出独立 CSS chunk，不阻塞首屏（本模块在首屏渲染前求值，管理页真正挂载时早已就绪）。
// 具体转发原因（sideEffects 会摇掉包内 dist/components.css）见 layout/pro-components.css。
import('./layout/pro-components.css');

import ManagerLayout from "./layout/ManagerLayout";
import UserLayout from "./layout/UserLayout";

import NoMatch from "./components/NoMatch";
import ErrorBoundary from "./components/ErrorBoundary";
import NoPermission from "./components/NoPermission";
import Redirect from "./components/Redirect";
// 路由级 Suspense 的 fallback 带「挂起自愈」：chunk 请求被挂住时不能永远停在加载中，
// 详见 RouteFallback.js 顶部说明
import RouteFallback from "./components/RouteFallback";

const GuacdMonitor = React.lazy(() => import("./components/session/GuacdMonitor"));
const GuacdPlayback = React.lazy(() => import("./components/session/GuacdPlayback"));
const TermMonitor = React.lazy(() => import("./components/session/TermMonitor"));
const TermPlayback = React.lazy(() => import("./components/session/TermPlayback"));

const BatchCommand = React.lazy(() => import("./components/devops/BatchCommand"));
const LoginPolicyDetail = React.lazy(() => import("./components/security/LoginPolicyDetail"));
const Login = React.lazy(() => import("./components/Login"));
const Dashboard = React.lazy(() => import("./components/dashboard/Dashboard"));
const Monitoring = React.lazy(() => import(/* webpackPrefetch: true */ "./components/dashboard/Monitoring"));

const Asset = React.lazy(() => import("./components/asset/Asset"));
const AssetDetail = React.lazy(() => import("./components/asset/AssetDetail"));
const MyFile = React.lazy(() => import("./components/worker/MyFile"));
const AccessGateway = React.lazy(() => import("./components/asset/AccessGateway"));
const MyAsset = React.lazy(() => import("./components/worker/MyAsset"));
const MyCommand = React.lazy(() => import("./components/worker/MyCommand"));
const MyInfo = React.lazy(() => import("./components/worker/MyInfo"));

const Guacd = React.lazy(() => import("./components/access/Guacd"));
const Term = React.lazy(() => import("./components/access/Term"));

const User = React.lazy(() => import("./components/user/user/User"));
const UserDetailPage = React.lazy(() => import("./components/user/user/UserDetailPage"));
const Role = React.lazy(() => import("./components/user/Role"));
const RoleDetail = React.lazy(() => import("./components/user/RoleDetail"));
const UserGroup = React.lazy(() => import("./components/user/UserGroup"));
const UserGroupDetail = React.lazy(() => import("./components/user/UserGroupDetail"));

const Strategy = React.lazy(() => import("./components/authorised/Strategy"));
const StrategyDetail = React.lazy(() => import("./components/authorised/StrategyDetail"));
const Info = React.lazy(() => import("./components/Info"));

const OnlineSession = React.lazy(() => import("./components/session/OnlineSession"));
const OfflineSession = React.lazy(() => import("./components/session/OfflineSession"));
const Command = React.lazy(() => import("./components/asset/Command"));
const ExecuteCommand = React.lazy(() => import("./components/devops/ExecuteCommand"));
const Credential = React.lazy(() => import("./components/asset/Credential"));

const Job = React.lazy(() => import("./components/devops/Job"));
const LoginLog = React.lazy(() => import("./components/log-audit/LoginLog"));
const Security = React.lazy(() => import("./components/security/Security"));
const Storage = React.lazy(() => import("./components/devops/Storage"));

const Setting = React.lazy(() => import("./components/setting/Setting"));
const LoginPolicy = React.lazy(() => import("./components/security/LoginPolicy"));

const App = () => {

    return (
        <Routes>

            <Route path="/" element={<Redirect/>}/>

            <Route element={
                <Suspense fallback={<RouteFallback/>}>
                    {/* 终端/监控/回放等全屏页面同样需要错误边界：
                        没有它，任一渲染异常都会卸载整棵树变成白屏 */}
                    <ErrorBoundary>
                        <Outlet/>
                    </ErrorBoundary>
                </Suspense>
            }>
                <Route path="/access" element={<Guacd/>}/>
                <Route path="/term" element={<Term/>}/>
                <Route path="/term-monitor" element={<TermMonitor/>}/>
                <Route path="/term-playback" element={<TermPlayback/>}/>
                <Route path="/guacd-monitor" element={<GuacdMonitor/>}/>
                <Route path="/guacd-playback" element={<GuacdPlayback/>}/>
                <Route path="/login" element={<Login/>}/>
                <Route path="/permission-denied" element={<NoPermission/>}/>
                <Route path="*" element={<NoMatch/>}/>
            </Route>

            <Route element={<ManagerLayout/>}>
                <Route path="/dashboard" element={<Dashboard/>}/>
                <Route path="/monitoring" element={<Monitoring/>}/>

                <Route path="/user" element={<User/>}/>
                <Route path="/user/:userId" element={<UserDetailPage/>}/>
                <Route path="/role" element={<Role/>}/>
                <Route path="/role/:roleId" element={<RoleDetail/>}/>
                <Route path="/user-group" element={<UserGroup/>}/>
                <Route path="/user-group/:userGroupId" element={<UserGroupDetail/>}/>

                <Route path="/asset" element={<Asset/>}/>
                <Route path="/asset/:assetId" element={<AssetDetail/>}/>
                <Route path="/credential" element={<Credential/>}/>
                <Route path="/command" element={<Command/>}/>
                <Route path="/batch-command" element={<BatchCommand/>}/>
                <Route path="/execute-command" element={<ExecuteCommand/>}/>
                <Route path="/online-session" element={<OnlineSession/>}/>
                <Route path="/offline-session" element={<OfflineSession/>}/>
                <Route path="/login-log" element={<LoginLog/>}/>
                <Route path="/info" element={<Info/>}/>
                <Route path="/setting" element={<Setting/>}/>
                <Route path="/job" element={<Job/>}/>
                <Route path="/file" element={<MyFile/>}/>
                <Route path="/access-security" element={<Security/>}/>
                <Route path="/access-gateway" element={<AccessGateway/>}/>
                <Route path="/storage" element={<Storage/>}/>
                <Route path="/strategy" element={<Strategy/>}/>
                <Route path="/strategy/:strategyId" element={<StrategyDetail/>}/>
                <Route path="/login-policy" element={<LoginPolicy/>}/>
                <Route path="/login-policy/:loginPolicyId" element={<LoginPolicyDetail/>}/>
            </Route>

            <Route element={<UserLayout/>}>
                <Route path="/my-asset" element={<MyAsset/>}/>
                <Route path="/my-info" element={<MyInfo/>}/>
                <Route path="/my-file" element={<MyFile/>}/>
                <Route path="/my-command" element={<MyCommand/>}/>
            </Route>
        </Routes>
    );
}

export default App;
