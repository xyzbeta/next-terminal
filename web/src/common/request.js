import axios from 'axios'
import {server} from "./env";
import {message} from 'antd';
import {getHeaders} from "../utils/utils";
import {reportRequestFailure, reportRequestSuccess} from "../service/request-status";

// 测试地址
// axios.defaults.baseURL = server;
// 线上地址
axios.defaults.baseURL = server;
// 全局请求超时：后端慢/挂起时不再无限转圈（文件上传走 FormData+XHR，不受此限制）
//
// 60s 而非 30s：移动网络下首次加载列表要下载全量用户/资产（见 OnlineSession 的
// 两个筛选下拉），30s 在弱网（地铁、电梯、跨运营商）下命中率偏高，
// 表现为弹「请求超时」后表格显示「暂无数据」，用户会误判为没有记录。
axios.defaults.timeout = 60000;

const handleError = (error) => {
    if ("Network Error" === error.toString()) {
        message.error('网络异常');
        reportRequestFailure('网络异常，数据可能不是最新的');
        return false;
    }
    if (error.code === 'ECONNABORTED' || error.toString().indexOf('timeout') !== -1) {
        message.error('请求超时，请稍后重试');
        reportRequestFailure('请求超时，列表内容可能不完整');
        return false;
    }
    if (error.response !== undefined && error.response.status === 401) {
        window.location.href = '#/login';
        return false;
    }
    if (error.response !== undefined) {
        // data 不一定是 JSON：网关/反代超时会直接返回 HTML 错误页，
        // 此时 data.message 为 undefined，提示与横幅都会变成空白。
        const data = error.response.data;
        const msg = (data && data.message) || `请求失败（HTTP ${error.response.status}）`;
        message.error(msg);
        reportRequestFailure(msg);
        return false;
    }
    return true;
};

/**
 * 把已处理的错误转成「一个 code 非 1 的结果对象」，供下面的 .catch 用来 settle。
 *
 * 为什么需要它：handleError 各分支只负责弹提示 + 上报全局横幅，返回 false 表示
 * 「已处理」。而调用方的 .catch 此前写成 `if (!handleError(e)) return;` —— 既不
 * resolve 也不 reject，**Promise 永久挂起**。任何 await 它的地方 finally 都不会
 * 执行：页面永远停在「加载中」，且没有任何重试入口。
 * 实测命中场景：后端返回 5xx 时移动端概览页停在骨架屏、列表页停在转圈。
 *
 * settle 方式是 **resolve** 而非 reject，这是本模块既有的约定——
 * handleResult 对业务码失败同样只弹提示、照常 resolve，调用方统一以
 * `result.code === 1` 判断成败。若改为 reject，90+ 个只判 code、不写 catch
 * 的调用点会集体产生未处理的 rejection。
 */
const settleAsError = (error) => {
    const data = error && error.response && error.response.data;
    // 后端统一返回 {code,message,data}，非 1 的 code 原样透出，
    // 调用方既有的 code === 1 判断无需任何改动即可正确跳过。
    if (data && typeof data === 'object' && data.code !== 1) {
        return data;
    }
    // 网络异常 / 超时 / 非 JSON 响应体：造一个同构结果，
    // 让调用方读到的仍是「一个对象且 code 非 1」，而不是 undefined 或抛错。
    return {
        code: error && error.response ? error.response.status : -1,
        message: (typeof data === 'string' && data) || (error && error.message) || '请求失败',
    };
};

const handleResult = (result) => {
    if (result['code'] === 401) {
        window.location.href = '#/login';
        return false;
    }if (result['code'] === 403) {
        window.location.href = '#/permission-denied';
        return false;
    } else if (result['code'] === 100) {
        return true;
    } else if (result['code'] !== 1) {
        message.error(result['message']);
        // 业务码失败时 Promise 仍会 resolve、表格会渲染成「暂无数据」，
        // 必须额外留下可观察的失败信号，否则用户会把「加载失败」读成「没有记录」
        reportRequestFailure(result['message']);
        return false;
    }
    reportRequestSuccess();
    return true;
}

const request = {

    get: function (url) {
        const headers = getHeaders();

        return new Promise((resolve, reject) => {
            axios.get(url, {headers: headers})
                .then((response) => {
                    let contentType = response.headers['content-type'];
                    if (contentType !== '' && contentType.includes('application/json')) {
                        handleResult(response.data);
                    }
                    resolve(response.data);
                })
                .catch((error) => {
                    if (!handleError(error)) {
                        // 已处理：必须 settle，否则调用方的 finally/加载态永远不结束
                        resolve(settleAsError(error));
                        return;
                    }
                    reject(error);
                });
        })
    },

    post: function (url, params, header) {

        const headers = getHeaders();
        if (header) {
            for (const k in header) {
                headers[k] = header[k];
            }
        }


        return new Promise((resolve, reject) => {
            axios.post(url, params, {headers: headers})
                .then((response) => {
                    handleResult(response.data);
                    resolve(response.data);
                })
                .catch((error) => {
                    if (!handleError(error)) {
                        // 已处理：必须 settle，否则调用方的 finally/加载态永远不结束
                        resolve(settleAsError(error));
                        return;
                    }
                    reject(error);
                });
        })
    },

    put: function (url, params) {

        const headers = getHeaders();

        return new Promise((resolve, reject) => {
            axios.put(url, params, {headers: headers})
                .then((response) => {
                    handleResult(response.data);
                    resolve(response.data);
                })
                .catch((error) => {
                    if (!handleError(error)) {
                        // 已处理：必须 settle，否则调用方的 finally/加载态永远不结束
                        resolve(settleAsError(error));
                        return;
                    }
                    reject(error);
                });
        })
    },

    delete: function (url) {
        const headers = getHeaders();

        return new Promise((resolve, reject) => {
            axios.delete(url, {headers: headers})
                .then((response) => {
                    handleResult(response.data);
                    resolve(response.data);
                })
                .catch((error) => {
                    if (!handleError(error)) {
                        // 已处理：必须 settle，否则调用方的 finally/加载态永远不结束
                        resolve(settleAsError(error));
                        return;
                    }
                    reject(error);
                });
        })
    },

    patch: function (url, params) {
        const headers = getHeaders();

        return new Promise((resolve, reject) => {
            axios.patch(url, params, {headers: headers})
                .then((response) => {
                    handleResult(response.data);
                    resolve(response.data);
                })
                .catch((error) => {
                    if (!handleError(error)) {
                        // 已处理：必须 settle，否则调用方的 finally/加载态永远不结束
                        resolve(settleAsError(error));
                        return;
                    }
                    reject(error);
                });
        })
    },
};
export default request
