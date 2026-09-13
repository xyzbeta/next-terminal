import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Button, Segmented, Spin} from "antd";
import request from "../../common/request";
import './DashboardMobile.css';

/**
 * 控制面板的**移动端实现**。由 Dashboard.js 按设备分发，桌面走 DashboardDesktop。
 *
 * 为什么重写而不是复用桌面版：
 *   桌面版是 ProCard 五层嵌套分栏 + G2Plot 饼图/折线图，信息密度取向。
 *   在 390px 上这套结构失效——分栏被压到约 195px 宽（统计卡文字逐字竖排），
 *   饼图缩到读不出扇区，折线三条线重叠、图例挤成一团。
 *   mobile.css 里那几条 :has() 规则只能把它们「压扁」，观感是「塞进手机的后台」。
 *
 * 本实现不引入任何图表库（这是拆分的核心目的，见 Dashboard.js 的说明）：
 *   · 趋势用**小倍数条形图**——三个指标各占一行、各自归一化。三条折线挤在同一
 *     坐标系里在窄屏必然糊，分开画才能读出各自的形状；各自归一化是因为三个指标
 *     量级差一到两个数量级（登录次数常是活跃资产的十倍以上），共用标度会让小值
 *     全部压成一条线。
 *   · 资产类型用横向条形——饼图在 390px 上扇区角度无法分辨，条形可以直接比较长度。
 */

/** 趋势图的三个指标。名称必须与后端 dto.DateCounter.Type 完全一致（接口按中文字面量分组）。 */
const SERIES_NAMES = ['登录次数', '活跃用户', '活跃资产'];

/** 与桌面折线图同源：G2Plot 默认分类色的前三位，保证两端观感一致 */
const SERIES_COLORS = {
    '登录次数': '#5B8FF9',
    '活跃用户': '#5AD8A6',
    '活跃资产': '#F6BD16',
};

/** 资产协议分布。key 对应 /overview/asset 返回的字段名 */
const ASSET_TYPES = [
    {key: 'ssh', label: 'SSH', color: '#5B8FF9'},
    {key: 'rdp', label: 'RDP', color: '#5AD8A6'},
    {key: 'vnc', label: 'VNC', color: '#F6BD16'},
    {key: 'telnet', label: 'Telnet', color: '#E8684A'},
    {key: 'kubernetes', label: 'K8s', color: '#9270CA'},
];

/**
 * 「最近连接」展示条数。2×2 网格 —— 四台是拇指区一眼扫完、不用滑动就点得到的上限。
 */
const RECENT_LIMIT = 4;

/** 拉取最近会话的条数：要比 RECENT_LIMIT 宽裕，因为同一台资产可能连续产生多条会话，去重后才能凑够 4 台 */
const RECENT_FETCH_SIZE = 20;

/**
 * 资产协议 → 角标文案与配色。
 * 与「资产类型」卡同源（同协议同色），两处并排看时不至于同一协议两种颜色。
 */
const PROTOCOL_BADGE = {
    ssh: {label: 'SSH', color: '#5B8FF9'},
    rdp: {label: 'RDP', color: '#5AD8A6'},
    vnc: {label: 'VNC', color: '#F6BD16'},
    telnet: {label: 'Telnet', color: '#E8684A'},
    kubernetes: {label: 'K8s', color: '#9270CA'},
};

const BAR_AREA_HEIGHT = 40;

/** 大数折算：五位数以上换算成「万」，否则千分位。手机卡片宽度有限，原始位数会撑破布局。 */
const fmtNum = (n) => {
    const v = Number(n);
    if (!isFinite(v)) {
        return '0';
    }
    if (v >= 100000) {
        return (v / 10000).toFixed(1) + '万';
    }
    return v.toLocaleString('zh-CN');
};

/**
 * 条形高度（px）。max 为 0 表示该周期内该指标全为 0，
 * 此时必须短路返回——否则除零得到 NaN，style.height 变成非法值，整行动画抖动。
 * 非零值保底 2px：极小值在归一化后可能不足 1px，会整条消失，
 * 让用户误以为「那天没有数据」，而实际上只是量级小。
 */
const barHeight = (value, max) => {
    if (!(max > 0)) {
        return 2;
    }
    return Math.max(2, Math.round((value / max) * BAR_AREA_HEIGHT));
};

const DashboardMobile = () => {
    const [counter, setCounter] = useState(null);
    const [asset, setAsset] = useState(null);
    const [trend, setTrend] = useState([]);
    const [recent, setRecent] = useState([]);
    const [range, setRange] = useState('week');
    const [loading, setLoading] = useState(true);
    // 按资源分别记录失败：三项请求是独立的，趋势请求失败不该让资产卡也显示「加载失败」。
    const [failed, setFailed] = useState({counter: false, asset: false, trend: false});

    // 卸载后不再 setState。挂在 ref 上而不是靠闭包变量，是因为下面的
    // load 会被 range 变化反复调用，闭包捕获的初值会失效。
    const aliveRef = useRef(true);
    // 请求序号：按周/按月来回切时，先发的请求可能后到，把新周期的数据覆盖成旧的
    // （经典竞态）。每次发起自增，回来时序号不等即丢弃。
    const seqRef = useRef(0);

    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
        };
    }, []);

    const load = useCallback(async (d) => {
        const seq = ++seqRef.current;
        setLoading(true);
        // 三项请求独立记录成败。catch 里全部保持 false —— 网络异常/超时会让
        // 三个 await 一起抛，标记为三项皆失败，避免把「加载失败」渲染成「0」
        // 或「暂无数据」（项目明令禁止：用户会把失败读成没有记录）。
        let okC = false;
        let okA = false;
        let okT = false;
        try {
            const [c, a, t] = await Promise.all([
                request.get('/overview/counter'),
                request.get('/overview/asset'),
                request.get('/overview/date-counter?d=' + d),
            ]);
            if (seq !== seqRef.current || !aliveRef.current) {
                return;
            }
            // request 对业务码失败只弹提示并**照常 resolve**（见 common/request.js
            // 的 handleResult / settleAsError），所以必须自己判 code，
            // 否则会把失败当成功、页面停在骨架屏上永不结束。
            okC = !!(c && c.code === 1);
            okA = !!(a && a.code === 1);
            okT = !!(t && t.code === 1);
            if (okC) {
                setCounter(c.data);
            }
            if (okA) {
                setAsset(a.data);
            }
            if (okT) {
                setTrend(t.data || []);
            }
        } catch (e) {
            // 失败原因由 request.js 的全局横幅（ManagerLayout 的 Alert）统一说明，
            // 这里只负责结束加载态并给出重试入口，不重复解释。
        } finally {
            if (seq === seqRef.current && aliveRef.current) {
                setFailed({counter: !okC, asset: !okA, trend: !okT});
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        load(range);
    }, [range, load]);

    // 「最近连接」：从会话列表取最近若干条，按 assetId 去重后取前几台。
    // 与上面三个统计接口相互独立——它只影响一张卡，不该拖累整页的成败判定。
    //
    // ⚠️ 必须带 status 参数：SessionRepository.Find 的 SQL 是硬编码的
    // `WHERE s.STATUS = ?`（server/repository/session.go），传空串匹配不到任何行、
    // 静默返回 0 条 —— 不是「没有数据」，是这个接口的既定行为。
    // 因此在连接中的会话要单独查一次，两次结果合并后才是一份完整的「最近」。
    //
    // 失败时**整张卡不渲染**（而非显示「暂无」）：这是个附加的便捷入口，
    // 缺了不影响页面完整性；而显示「暂无连接记录」会把接口故障说成事实。
    const loadRecent = useCallback(async () => {
        const fetchByStatus = async (status) => {
            const r = await request.get(
                `/sessions/paging?pageIndex=1&pageSize=${RECENT_FETCH_SIZE}&status=${status}`);
            return (r && r.code === 1 && r.data && r.data.items) ? r.data.items : [];
        };
        try {
            // 在线会话排在前面：它才是「此刻正连着」的那台
            const [connected, disconnected] = await Promise.all([
                fetchByStatus('connected'),
                fetchByStatus('disconnected'),
            ]);
            if (!aliveRef.current) {
                return;
            }
            const seen = new Set();
            const list = [];
            for (const s of connected.concat(disconnected)) {
                const id = s['assetId'];
                // assetName 来自 `LEFT JOIN assets`：为空说明资产已被删除，
                // 这种记录点下去必然新建失败，直接跳过（'-' 是历史遗留的占位值）
                if (!id || id === '-' || !s['assetName'] || seen.has(id)) {
                    continue;
                }
                seen.add(id);
                list.push({
                    assetId: id,
                    assetName: s['assetName'],
                    protocol: s['protocol'] || '',
                    mode: s['mode'] || '',
                });
                if (list.length >= RECENT_LIMIT) {
                    break;
                }
            }
            setRecent(list);
        } catch (e) {
            /* 见上：静默不渲染，不影响页面其余部分 */
        }
    }, []);

    useEffect(() => {
        loadRecent();
    }, [loadRecent]);

    // 点一台资产 = 直接发起连接（这正是「最近连接」的价值：一步回到常用机器）。
    // 分流规则与在线会话页的「继续」按钮一致：guacd 类走接入页（需带 protocol），
    // SSH 类走终端页。不带 sessionId，因此是**新建会话**而非恢复。
    const openAsset = (a) => {
        const q = `assetId=${encodeURIComponent(a.assetId)}&assetName=${encodeURIComponent(a.assetName)}`;
        if (a.mode === 'guacd') {
            window.location.hash = `#/access?${q}&protocol=${encodeURIComponent(a.protocol)}`;
        } else {
            window.location.hash = `#/term?${q}`;
        }
    };

    // 趋势数据按指标拆行。[{type,date,value}] → 每行一条按天排列的序列。
    const series = useMemo(() => {
        return SERIES_NAMES.map((name) => {
            const values = trend
                .filter((item) => item.type === name)
                .map((item) => Number(item.value) || 0);
            return {
                name,
                values,
                max: values.reduce((m, v) => (v > m ? v : m), 0),
            };
        });
    }, [trend]);

    // 完整日期序列（后端按天依次输出三条记录，取任一指标即得）。用于条形的 tooltip。
    const allDates = useMemo(() => trend
        .filter((item) => item.type === SERIES_NAMES[0])
        .map((item) => String(item.date || '').slice(5)), [trend]);

    // 轴标签：7/30 个日期在 390px 上必然重叠，只标首/中/末三个，作为区间提示。
    // 与 allDates 分开保存——轴标签是压缩过的，不能拿来索引每个条形。
    const axisDates = useMemo(() => {
        if (allDates.length <= 3) {
            return allDates;
        }
        return [allDates[0], allDates[Math.floor(allDates.length / 2)], allDates[allDates.length - 1]];
    }, [allDates]);

    const assetTotal = asset ? Number(asset.all) || 0 : 0;
    const assetMax = asset
        ? ASSET_TYPES.reduce((m, t) => Math.max(m, Number(asset[t.key]) || 0), 0)
        : 0;
    const retry = () => load(range);
    const anyFailed = failed.counter || failed.asset || failed.trend;

    // 首屏骨架：仅在没有数据时显示。切按周/按月会重新请求，但此时 counter 已有值，
    // 再整屏闪一次骨架会让页面跳得厉害——那种情况改为把图表区置灰（见 is-loading）。
    if (loading && counter === null && !anyFailed) {
        return (
            <div className="md-page md-center">
                <Spin/>
            </div>
        );
    }

    return (
        <div className="md-page">
            {anyFailed && (
                <div className="md-error">
                    <span>数据加载失败</span>
                    <Button size="small" onClick={retry}>重试</Button>
                </div>
            )}

            {counter !== null && (
                <div className="md-grid2">
                    <div className="md-stat">
                        <div className="md-stat-label">在线用户</div>
                        <div className="md-stat-value">{fmtNum(counter.onlineUser)}</div>
                        <div className="md-stat-note">共 {fmtNum(counter.totalUser)} 位用户</div>
                    </div>
                    <div className="md-stat">
                        <div className="md-stat-label">运行中资产</div>
                        <div className="md-stat-value">{fmtNum(counter.activeAsset)}</div>
                        <div className="md-stat-note">共 {fmtNum(counter.totalAsset)} 台资产</div>
                    </div>
                    <div className="md-stat">
                        <div className="md-stat-label">登录失败</div>
                        <div className="md-stat-value">{fmtNum(counter.failLoginCount)}</div>
                        <div className="md-stat-note">历史累计</div>
                    </div>
                    <div className="md-stat">
                        <div className="md-stat-label">历史会话</div>
                        <div className="md-stat-value">{fmtNum(counter.offlineSession)}</div>
                        <div className="md-stat-note">历史累计</div>
                    </div>
                </div>
            )}

            {/* 最近连接：放在统计卡正下方而非页尾 —— 这是本页唯一的「操作」入口，
                其余都是只读数据。放页尾要滑到底才点得到，违背了快捷入口的初衷。 */}
            {recent.length > 0 && (
                <div className="md-card">
                    <div className="md-card-head">
                        <span className="md-card-title">最近连接</span>
                        <span className="md-card-extra">点击直接连接</span>
                    </div>
                    <div className="md-recent">
                        {recent.map((a) => {
                            const badge = PROTOCOL_BADGE[a.protocol]
                                || {label: (a.protocol || '?').toUpperCase(), color: '#8c8c8c'};
                            return (
                                <button
                                    type="button"
                                    className="md-recent-item"
                                    key={a.assetId}
                                    onClick={() => openAsset(a)}
                                >
                                    <span className="md-recent-badge" style={{background: badge.color}}>
                                        {badge.label}
                                    </span>
                                    <span className="md-recent-name">{a.assetName}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            <div className="md-card">
                <div className="md-card-head">
                    <span className="md-card-title">会话趋势</span>
                    <Segmented
                        size="small"
                        value={range}
                        onChange={setRange}
                        options={[
                            {label: '按周', value: 'week'},
                            {label: '按月', value: 'month'},
                        ]}
                    />
                </div>

                {trend.length === 0 ? (
                    /* 失败与「真的没有数据」必须区分：都显示「暂无数据」会让用户
                       把接口故障读成「这段时间没人登录」。 */
                    <div className="md-hint">
                        {loading ? '加载中…' : (failed.trend ? '加载失败' : '该周期暂无数据')}
                    </div>
                ) : (
                    <div className={loading ? 'md-trend is-loading' : 'md-trend'}>
                        <div className="md-trend-row md-trend-head">
                            <span/>
                            <span/>
                            <span className="md-trend-peak-label">峰值</span>
                        </div>
                        {series.map((s) => (
                            <div className="md-trend-row" key={s.name}>
                                <span className="md-trend-name">{s.name}</span>
                                <div className="md-trend-bars">
                                    {s.values.map((v, i) => (
                                        <div
                                            className="md-trend-bar"
                                            key={i}
                                            style={{
                                                height: barHeight(v, s.max),
                                                /* 值为 0 的那天用轨道灰，不用系列色：
                                                   归一化后 0 也保底 2px，涂成实色会变成一根贴着
                                                   底部的彩色扁线，看起来像 UI 分隔线而不是
                                                   「这天没有数据」。灰色与资产类型的空轨道同色，
                                                   语义一致：灰 = 空。 */
                                                background: v > 0 ? SERIES_COLORS[s.name] : '#f0f0f0',
                                            }}
                                            title={allDates[i] ? `${allDates[i]}：${v}` : String(v)}
                                        />
                                    ))}
                                </div>
                                <span className="md-trend-peak">{fmtNum(s.max)}</span>
                            </div>
                        ))}
                        <div className="md-trend-row md-trend-axis">
                            <span/>
                            <div className="md-trend-axis-dates">
                                {axisDates.map((d, i) => <span key={i}>{d}</span>)}
                            </div>
                            <span/>
                        </div>
                    </div>
                )}
            </div>

            <div className="md-card">
                <div className="md-card-head">
                    <span className="md-card-title">资产类型</span>
                    {asset && <span className="md-card-extra">共 {fmtNum(assetTotal)} 台</span>}
                </div>
                {assetTotal === 0 ? (
                    <div className="md-hint">{failed.asset ? '加载失败' : '暂无资产'}</div>
                ) : (
                    <div className="md-assets">
                        {ASSET_TYPES.map((t) => {
                            const value = Number(asset[t.key]) || 0;
                            return (
                                <div className="md-asset-row" key={t.key}>
                                    <span className="md-asset-name">{t.label}</span>
                                    <div className="md-asset-track">
                                        <div
                                            className="md-asset-fill"
                                            style={{
                                                width: assetMax > 0 ? `${(value / assetMax) * 100}%` : 0,
                                                background: t.color,
                                            }}
                                        />
                                    </div>
                                    <span className="md-asset-value">{fmtNum(value)}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

        </div>
    );
};

export default DashboardMobile;
