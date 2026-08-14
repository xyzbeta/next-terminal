import request from "../common/request";

class MonitorApi {
    getData = async () => {
        let result = await request.get('/overview/ps');
        if (result['code'] !== 1 || !result['data']) {
            // 返回完整空结构（而非 {}）：图表渲染对缺失字段无防护，空对象会导致白屏
            return {
                loadStat: {load1: 0, load5: 0, load15: 0, percent: 0},
                mem: {total: 0, available: 0, usedPercent: 0},
                cpu: {count: 0, usedPercent: 0, info: []},
                disk: {total: 0, available: 0, usedPercent: 0},
                diskIO: [], netIO: [], cpuStat: [], memStat: []
            };
        }
        let data = result['data'];
        // 空数据防护：后端异常时返回空结构，避免图表渲染崩溃
        if (!data['netIO']) data['netIO'] = [];
        if (!data['diskIO']) data['diskIO'] = [];
        let netIO = [];
        for (let i = 0; i < data['netIO'].length; i++) {
            let item = data['netIO'][i];
            netIO.push({
                time: item['time'],
                read: item['read'] / 1024 / 1024 / 1024,
                write: item['write'] / 1024 / 1024 / 1024,
            });
        }
        data['netIO'] = netIO;

        let diskIO = [];
        for (let i = 0; i < data['diskIO'].length; i++) {
            let item = data['diskIO'][i];
            diskIO.push({
                time: item['time'],
                read: item['read'] / 1024 / 1024 / 1024,
                write: item['write'] / 1024 / 1024 / 1024,
            });
        }
        data['diskIO'] = diskIO;

        return data
    }
}

let monitorApi = new MonitorApi();
export default monitorApi;