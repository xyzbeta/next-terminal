import React, {Suspense} from 'react';
import {useIsMobile} from "../../hook/use-breakpoint";
import RouteFallback from "../RouteFallback";
import DashboardMobile from "./DashboardMobile";

/**
 * 控制面板（概览页）的设备分发器。两套实现有意分离，不共享组件：
 *
 * · 桌面 `DashboardDesktop`：ProCard 分栏 + G2Plot 饼图/折线图，信息密度高，
 *   依赖 @ant-design/plots（构建出 872KB / gzip ~250KB 的图表 chunk）。
 * · 移动 `DashboardMobile`：竖向卡片流，零图表库依赖，自绘条形图。
 *
 * 为什么不把两套写在同一个文件里：那样图表库会被静态打入同一个 chunk，
 * 手机永远要为它付流量（实测 872KB，是该页最大的单个资源）。
 * 这里用内层 React.lazy 把桌面实现推到独立异步 chunk —— 移动端分支根本不触发
 * 这条 import，图表库就不进入下载队列。桌面用户的加载路径与拆分前一致
 * （仍然是一次路由跳转后的按需 chunk，只是从 1 个变 2 个，总字节不变）。
 *
 * 本地 Suspense 是必须的：内层 lazy 若没有边界会向上冒泡到路由级的 Suspense，
 * 那一层的 fallback 是整页的——桌面首次进入会整屏闪一下。
 */
const DashboardDesktop = React.lazy(() => import("./DashboardDesktop"));

const Dashboard = () => {
    const isMobile = useIsMobile();
    return (
        <Suspense fallback={<RouteFallback/>}>
            {isMobile ? <DashboardMobile/> : <DashboardDesktop/>}
        </Suspense>
    );
};

export default Dashboard;
