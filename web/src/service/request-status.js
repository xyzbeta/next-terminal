/**
 * 全局请求失败状态。
 *
 * 背景：请求失败时 request.js 只弹一个 3 秒的 message.error，随后 Promise 仍然
 * resolve、ProTable 拿到空数据渲染成 antd 默认的「暂无数据」。用户 3 秒后回看，
 * 无法区分「确实没有记录」与「接口挂了」——运维排障时会把后者误读为前者，
 * 进而得出「这段时间没人登录」这类错误结论。
 *
 * 这里把「最近一次请求失败」提升为可持续观察的全局信号，
 * 由 ManagerLayout 渲染成常驻横幅，直到用户手动关闭或下一次请求成功。
 *
 * 不引入状态库：一个极小的发布订阅即可，订阅方只有布局层一处。
 */

let failed = null; // {message, at} | null
const listeners = new Set();

const emit = () => {
    listeners.forEach((fn) => {
        try {
            fn(failed);
        } catch (e) {
            // 订阅方异常不应影响请求链路
            console.error('[request-status] 订阅回调异常', e);
        }
    });
};

/** 记录一次请求失败（在弹 toast 的同时调用） */
export const reportRequestFailure = (msg) => {
    failed = {message: msg || '请求失败', at: Date.now()};
    emit();
};

/** 记录一次请求成功：清除失败态（一次成功即可认为链路恢复） */
export const reportRequestSuccess = () => {
    if (failed !== null) {
        failed = null;
        emit();
    }
};

/** 手动关闭横幅 */
export const clearRequestFailure = () => {
    failed = null;
    emit();
};

export const subscribeRequestStatus = (fn) => {
    listeners.add(fn);
    fn(failed);
    return () => listeners.delete(fn);
};
