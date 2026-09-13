import Api from "./api";
import qs from "qs";
import request from "../common/request";

class SessionApi extends Api {
    constructor() {
        super("sessions");
    }

    GetCommandPagingBySessionId = async (sessionId, params) => {
        let paramsStr = qs.stringify(params);
        let result = await request.get(`/${this.group}/${sessionId}/commands/paging?${paramsStr}`);
        if (result['code'] !== 1) {
            return {};
        }
        return result['data'];
    }

    create = async (assetsId, mode) => {
        let result = await request.post(`/${this.group}?assetId=${assetsId}&mode=${mode}`);
        if (result['code'] !== 1) {
            return {};
        }
        return result['data'];
    }

    connect = async (sessionId) => {
        let result = await request.post(`/${this.group}/${sessionId}/connect`);
        return result['code'] === 1;
    }

    disconnect = async (sessionId) => {
        let result = await request.post(`/${this.group}/${sessionId}/disconnect`);
        return result['code'] === 1;
    }

    clear = async () => {
        let result = await request.post(`/${this.group}/clear`);
        return result['code'] === 1;
    }

    cleanupKeepAlive = async (sessionId) => {
        let result = await request.post(`/${this.group}/${sessionId}/cleanup`);
        return result['code'] === 1;
    }

    stats = async (sessionId) => {
        let result = await request.get(`/${this.group}/${sessionId}/stats`);
        if (result['code'] !== 1) {
            return {};
        }
        return result['data'];
    }

    resize = async (sessionId, width, height) => {
        let result = await request.post(`/sessions/${sessionId}/resize?width=${width}&height=${height}`);
        return result.code === 1;
    }

    // 审计标记：后端端点早已存在（/sessions/:id/reviewed 等），但前端一直没有入口，
    // 导致「未审查」高亮只是一个用户无法处置的死信号。
    markReviewed = async (id) => {
        const result = await request.post(`/${this.group}/${id}/reviewed`);
        return result['code'] === 1;
    }

    markUnreviewed = async (id) => {
        const result = await request.post(`/${this.group}/${id}/unreviewed`);
        return result['code'] === 1;
    }

    markAllReviewed = async () => {
        const result = await request.post(`/${this.group}/reviewed`);
        return result['code'] === 1;
    }
}

const sessionApi = new SessionApi();
export default sessionApi;