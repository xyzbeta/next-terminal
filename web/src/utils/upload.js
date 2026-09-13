import {getHeaders} from './utils';
import {server} from '../common/env';

// 后端 SSH 分支在传输开始前就 WriteHeader(200)，随后以 SSE（text/event-stream）
// 逐段写出「已传字节数 + 分隔符」，末尾才是 JSON 结果。分隔符与 FileSystem.js 保持一致。
const SSE_SEPARATOR = '㊥';

/**
 * 上传文件到指定会话（复用后端 POST /sessions/:id/upload 端点）。
 *
 * @param {string} sessionId 会话 ID
 * @param {File|Blob} file 文件对象
 * @param {string} dir 远端目录（相对会话工作目录，后端会自动创建）
 * @param {Object} [opts]
 * @param {string} [opts.fileName] 覆盖上传文件名（Blob 无 name 时使用）
 * @param {number} [opts.maxSize] 体积上限（字节），超出直接 reject，不发请求
 * @param {(info:{phase:'upload'|'transfer', percent:number, loaded:number, total:number})=>void} [opts.onProgress]
 *        两段进度：upload = 浏览器→服务器，transfer = 服务器→目标机器
 * @param {AbortSignal} [opts.signal] 中止信号
 * @returns {Promise<{name:string, dir:string}>}
 */
export const uploadToSession = (sessionId, file, dir, opts = {}) => {
    const {fileName, maxSize, onProgress, signal} = opts;
    const name = fileName || file.name || `upload-${Date.now()}`;
    const total = file.size || 0;

    return new Promise((resolve, reject) => {
        if (!sessionId) {
            reject(new Error('会话未就绪'));
            return;
        }
        if (maxSize && total > maxSize) {
            reject(new Error(`文件 ${(total / 1024 / 1024).toFixed(1)}MB 超过 ${Math.round(maxSize / 1024 / 1024)}MB 上限`));
            return;
        }

        const xhr = new XMLHttpRequest();
        // 令牌走请求头，不放 URL query（避免进入反代/网关访问日志）
        const headers = getHeaders();
        Object.keys(headers).forEach(k => xhr.setRequestHeader(k, headers[k]));

        if (onProgress) {
            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable) {
                    onProgress({
                        phase: 'upload',
                        percent: Math.min(Math.floor(event.loaded * 100 / event.total), 99),
                        loaded: event.loaded,
                        total: event.total,
                    });
                }
            }, false);
        }

        xhr.onreadystatechange = () => {
            // 3 = LOADING：后端正边收边向目标机转发，解析 SSE 进度
            if (xhr.readyState !== 4 && onProgress) {
                const parts = (xhr.responseText || '').split(SSE_SEPARATOR).filter(item => item !== '');
                if (parts.length > 0) {
                    const transferred = parseInt(parts[parts.length - 1]);
                    if (!isNaN(transferred) && total > 0) {
                        onProgress({
                            phase: 'transfer',
                            percent: Math.min(Math.floor(transferred * 100 / total), 99),
                            loaded: transferred,
                            total,
                        });
                    }
                }
                return;
            }
            if (xhr.readyState !== 4) {
                return;
            }

            const okStatus = xhr.status >= 200 && xhr.status < 300;
            // 状态码 200 早于文件真正落盘就已发出，末尾 JSON 才是最终结果
            let okBody = true;
            let errMsg = '';
            const text = xhr.responseText || '';
            const jsonStart = text.lastIndexOf('{');
            if (jsonStart >= 0) {
                try {
                    const res = JSON.parse(text.slice(jsonStart));
                    if (res && typeof res.code === 'number') {
                        okBody = res.code === 1;
                        errMsg = res.message || '';
                    }
                } catch (e) { /* 尾部不是完整 JSON（纯进度流）：以状态码为准 */ }
            }
            if (okStatus && okBody) {
                resolve({name, dir});
            } else {
                reject(new Error(errMsg || (okStatus ? '上传失败' : `上传失败（HTTP ${xhr.status}）`)));
            }
        };
        xhr.onerror = () => reject(new Error('网络请求异常'));
        xhr.ontimeout = () => reject(new Error('上传超时'));
        xhr.onabort = () => reject(new Error('已取消'));

        if (signal) {
            if (signal.aborted) {
                reject(new Error('已取消'));
                return;
            }
            signal.addEventListener('abort', () => xhr.abort(), {once: true});
        }

        xhr.open('POST', `${server}/sessions/${sessionId}/upload?dir=${encodeURIComponent(dir)}`, true);
        const formData = new FormData();
        formData.append('file', file, name);
        xhr.send(formData);
    });
};
