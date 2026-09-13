import React, {useEffect} from 'react';
import {useQuery} from "react-query";
import accountApi from "../api/account";
import {setCurrentUser} from "../service/permission";
import {useNavigate} from "react-router-dom";
import Landing from "./Landing";

const Redirect = () => {

    let navigate = useNavigate();

    // 落地页：管理员一律「控制面板」，普通用户「我的资产」。
    //
    // 移动端曾单独落在「在线会话」，那是**性能决策而非偏好** —— 当时控制面板依赖
    // @ant-design/charts，一次冷启动要下载 872KB 的图表 chunk（1227.chunk.js）。
    // 自 v1.4.33 起移动端概览页已是独立的零图表实现（实测该路由只加载 17KB chunk，
    // 图表与 pro-components 两个大 chunk 都不进入下载队列），代价不复存在，
    // 故两端统一，管理员打开应用先看到概览。
    let infoQuery = useQuery('infoQuery', accountApi.getUserInfo);

    // 跳转必须由「数据」驱动，不能用 useQuery 的 onSuccess 回调驱动。
    //
    // onSuccess 只在 queryFn **真正执行**时触发一次；而 react-query 的 staleTime 是 5 分钟，
    // 期间再次挂载 useQuery 会直接返回缓存、**不执行 queryFn、也就不会触发 onSuccess**。
    // 后果：登录后 navigate('/') 落到本组件，若 'infoQuery' 还在缓存里（典型场景是
    // 「退出登录 → 重新登录」，同一份内存缓存没被销毁），页面就永远停在 <Landing/>
    // ——用户看到的是「点登录后一直正在努力加载中」，只有杀掉应用重开（清空内存）才能恢复。
    //
    // 依赖 infoQuery.data 的 effect 没有这个问题：缓存命中时 data 立即有值，effect 照常执行。
    useEffect(() => {
        const data = infoQuery.data;
        if (!data || !data.type) {
            return;
        }
        setCurrentUser(data);
        if (data.type === 'user') {
            navigate('/my-asset');
        } else if (data.type === 'admin') {
            // 管理员落地页统一为「控制面板」，移动端不再改落「在线会话」。
            //
            // 当初移动端落在 /online-session 是**性能决策**：那时控制面板依赖
            // @ant-design/charts，一次冷启动要下载 872KB 的图表 chunk。
            // v1.4.33 已把移动端概览页改为独立的零图表实现（实测只加载 17KB 的路由
            // chunk，图表 chunk 与 pro-components chunk 都不进入下载队列），
            // 这个理由不复存在；而概览页正是管理员打开应用最想先看到的信息。
            navigate('/dashboard');
        }
    }, [infoQuery.data, navigate]);

    return (
        <div>
            <Landing/>
        </div>
    );
};

export default Redirect;