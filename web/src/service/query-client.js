import {QueryClient} from 'react-query';

/**
 * 全局 queryClient 单例。
 *
 * 为什么从 index.js 抽出来：登录成功时必须清空它，而此前它定义在 index.js 的
 * 函数作用域里，没有任何模块能拿到 —— 于是**退出登录后缓存里仍留着上一个账号的
 * 用户信息、资产、会话数据**，换个账号登录会先读到旧数据（既会让页面显示错误内容，
 * 也是跨账号的数据泄露）。抽成模块后，Login.js 与 index.js 共用同一个实例。
 *
 * 默认值的取值理由见 index.js 的注释（staleTime 5 分钟、关掉聚焦重拉、retry 1）。
 */
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});

export default queryClient;
