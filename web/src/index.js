import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';
import zhCN from 'antd/es/locale-provider/zh_CN';
import {ConfigProvider} from 'antd';
import {HashRouter as Router} from "react-router-dom";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import 'dayjs/locale/zh-cn';
import {QueryClientProvider} from 'react-query';
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

// 全局查询默认值：不配置时 react-query v3 的默认是 staleTime:0 +
// refetchOnWindowFocus:true + retry:3，导致每次进入列表页、以及每次窗口重新聚焦
// 都会重新拉取「全量用户列表 / 全量资产列表」——这些数据只用于填几个筛选下拉框，
// 在数千资产的堡垒机上每次是 MB 级响应；retry:3 还会在后端异常时放大三倍请求量。
// 实例定义已抽到 service/query-client.js：登录成功时需要清空它，见该文件说明。
import queryClient from "./service/query-client";
import {initTheme} from "./utils/theme";

initTheme();

ReactDOM.render(
    <ConfigProvider locale={zhCN}>
        <Router>
            <QueryClientProvider client={queryClient}>
                <App/>
            </QueryClientProvider>
        </Router>
    </ConfigProvider>,
    document.getElementById('root')
);

// 注意：这里不能调用 CRA 模板的 serviceWorker.unregister()。
// 它的实现是 navigator.serviceWorker.ready.then(r => r.unregister())，
// 而 ready 返回的是「当前作用域下已激活的 registration」，不区分来源——
// public/index.html 中注册的自定义 sw.js（离线外壳/可安装性）会被它立刻注销。
// 本项目不使用 CRA 的 src/serviceWorker.js，该文件已删除。

