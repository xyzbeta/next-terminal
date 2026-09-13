import React, {useState} from 'react';
import ColumnState, {useColumnState} from "../../hook/column-state";
import {Button, Layout, message, Popconfirm, Select, Tag, Tooltip} from "antd";
import {ReloadOutlined} from "@ant-design/icons";
import {ProTable} from "@ant-design/pro-components";
import {useIsMobile} from "../../hook/use-breakpoint";
import sessionApi from "../../api/session";
import {PROTOCOL_COLORS} from "../../common/constants";
import {MobileOutlined, DesktopOutlined, SafetyCertificateOutlined} from "@ant-design/icons";
import {differTime} from "../../utils/utils";
import {openTinyWin} from "../../utils/window";
import Show from "../../dd/fi/show";
import MobileList from "../mobile/MobileList";
import {getCurrentUser} from "../../service/permission";
import {useQuery} from "react-query";
import userApi from "../../api/user";
import assetApi from "../../api/asset";

const {Content} = Layout;
const api = sessionApi;

const OnlineSession = () => {
    const actionRef = React.useRef(null);
    const isMobile = useIsMobile();

    const [columnsStateMap, setColumnsStateMap] = useColumnState(ColumnState.ONLINE_SESSION);
    // 断开会话后让移动端列表重新取数（卡片列表自管分页，没有 actionRef）
    const [mobileReloadKey, setMobileReloadKey] = useState(0);
    let userQuery = useQuery('userQuery', userApi.getAll);
    let assetQuery = useQuery('assetQuery', assetApi.getAll);

    const userOptions = userQuery.data?.map(item=>{
        return {
            label: item.nickname,
            value: item.id
        }
    })

    const assetOptions = assetQuery.data?.map(item=>{
        return {
            label: item.name,
            value: item.id
        }
    })

    const columns = [
        {
            dataIndex: 'index',
            valueType: 'indexBorder',
            width: 48,
        }, {
            title: '来源IP',
            dataIndex: 'clientIp',
            key: 'clientIp',
        }, {
            title: '用户昵称',
            dataIndex: 'creatorName',
            key: 'creatorName',
            renderFormItem: (item, {type, defaultRender, ...rest}, form) => {
                if (type === 'form') {
                    return null;
                }

                return (
                    <Select showSearch
                            filterOption={(input, option) =>
                                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                            }
                            allowClear
                            options={userOptions}
                    >

                    </Select>
                );
            },
        }, {
            title: '资产名称',
            dataIndex: 'assetName',
            key: 'assetName',
            renderFormItem: (item, {type, defaultRender, ...rest}, form) => {
                if (type === 'form') {
                    return null;
                }

                return (
                    <Select showSearch
                            filterOption={(input, option) =>
                                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                            }
                            allowClear
                            options={assetOptions}>
                    </Select>
                );
            },
        }, {
            title: '连接协议',
            dataIndex: 'protocol',
            key: 'protocol',
            render: (text, record) => {
                const title = `${record.username}@${record.ip}:${record.port}`;
                return (
                    <Tooltip title={title}>
                        <Tag color={PROTOCOL_COLORS[text]}>{text}</Tag>
                    </Tooltip>
                )
            },
            renderFormItem: (item, {type, defaultRender, ...rest}, form) => {
                if (type === 'form') {
                    return null;
                }

                return (
                    <Select>
                        <Select.Option value="rdp">RDP</Select.Option>
                        <Select.Option value="ssh">SSH</Select.Option>
                        <Select.Option value="telnet">Telnet</Select.Option>
                        <Select.Option value="kubernetes">Kubernetes</Select.Option>
                    </Select>
                );
            },
        }, {
            title: '接入时间',
            dataIndex: 'connectedTime',
            key: 'connectedTime',
            hideInSearch: true,
        }, {
            title: '接入时长',
            dataIndex: 'connectedTimeDur',
            key: 'connectedTimeDur',
            render: (text, record) => {
                if (!record['connectedTime']) {
                    return '-';
                }
                return differTime(new Date(record['connectedTime']), new Date());
            },
            hideInSearch: true,
        },
        {
            title: '操作',
            valueType: 'option',
            key: 'option',
            render: (text, record, _, action) => [
                canResume(record) && (
                    <Button
                        key='resume'
                        type="link"
                        size='small'
                        onClick={() => {
                            const mode = record['mode'];
                            const q = `assetId=${record['assetId']}&assetName=${encodeURIComponent(record['assetName'] || '')}&sessionId=${record['id']}&keep=1`;
                            if (mode === 'guacd') {
                                window.location.hash = `#/access?${q}&protocol=${record['protocol']}`;
                            } else {
                                window.location.hash = `#/term?${q}`;
                            }
                        }}>
                        继续
                    </Button>
                ),
                <Show menu={'online-session-monitor'} key={'online-session-monitor'}>
                    <Button
                        key='monitor'
                        type="link"
                        size='small'
                        onClick={() => {
                            switch (record['mode']) {
                                case 'naive':
                                case 'native':
                                case 'terminal':
                                    openTinyWin(`#/term-monitor?sessionId=${record['id']}`, record['id'], 1024, 768);
                                    break;
                                case 'guacd':
                                    openTinyWin(`#/guacd-monitor?sessionId=${record['id']}`, record['id'], 1024, 768);
                                    break;
                                default:
                                    message.info('数据异常');
                                    break;
                            }
                        }}>
                        监控
                    </Button>
                </Show>,
                <Show menu={'online-session-disconnect'} key={'online-session-disconnect'}>
                    {record['status'] === 'disconnected' && record['keepAlive'] === '1' ? (
                        <Popconfirm
                            key={'confirm-cleanup'}
                            title="清理此会话？将终止远端 tmux 并删除记录。"
                            onConfirm={async () => {
                                await api.cleanupKeepAlive(record.id);
                                window.dispatchEvent(new Event('nt-session-count-refresh'));
                                actionRef.current.reload();
                            }}
                            okText="确认"
                            cancelText="取消"
                        >
                            <a key='cleanup' className='danger'>清理</a>
                        </Popconfirm>
                    ) : (
                        <Popconfirm
                            key={'confirm-disconnect'}
                            title="您确定要断开此会话吗?"
                            onConfirm={async () => {
                                await api.disconnect(record.id);
                                window.dispatchEvent(new Event('nt-session-count-refresh'));
                                actionRef.current.reload();
                            }}
                            okText="确认"
                            cancelText="取消"
                        >
                            <a key='delete' className='danger'>断开</a>
                        </Popconfirm>
                    )}
                </Show>,
            ],
        },
    ];

    // 能否「继续」：必须是自己的会话，且会话可恢复。
    //
    // keep_alive=1 的会话（tmux 保持）：无论 connected 还是 disconnected，
    // 都可恢复——服务端有两条路径：
    //   · connected + 有令牌 → TryReattach（换绑 ws，不新建 SSH）
    //   · connected + 无令牌 → 接管（关旧连接 + 新建 SSH + tmux attach）
    //   · disconnected → 新建 SSH + tmux attach
    // 三条路径都不需要前端提前校验令牌——服务端会根据内存状态自动选择。
    // 之前对 connected 走令牌校验，导致换设备/换标签页时「继续」按钮不出现，
    // 用户被迫先「断开」才能恢复。
    //
    // 非 keep-alive 的在线会话仍需令牌（TryReattach），否则服务端会拒绝。
    const canResume = (record) => {
        try {
            if (record['mode'] === 'guacd') {
                return false;
            }
            const me = getCurrentUser();
            if (!me || record['creator'] !== me['id']) {
                return false;
            }
            // tmux 保持的会话：可接管或 attach 恢复，不需要令牌
            if (record['keepAlive'] === '1') {
                return true;
            }
            // 普通在线会话：需要令牌走 TryReattach
            return !!sessionStorage.getItem(`rt-${record['id']}`);
        } catch (e) {
            return false;
        }
    };

    // 移动端：卡片列表替代「查询表单 + 多列表格 + 工具栏」。
    // 桌面端分支完全不动，两套并存——用户要的是手机上像 App，不是把桌面改掉。
    if (isMobile) {
        return (
            <div className="page-container">
                <MobileList
                    key={mobileReloadKey}
                    title="在线会话"
                    searchPlaceholder="搜索来源 IP"
                    emptyText="当前没有在线会话"
                    filters={[
                        {
                            name: 'protocol', label: '连接协议', options: [
                                {label: 'RDP', value: 'rdp'},
                                {label: 'SSH', value: 'ssh'},
                                {label: 'Telnet', value: 'telnet'},
                                {label: 'Kubernetes', value: 'kubernetes'},
                            ]
                        },
                        {name: 'userId', label: '用户', options: userOptions},
                        {name: 'assetId', label: '资产', options: assetOptions},
                    ]}
                    request={async ({pageIndex, pageSize, keyword, filters: f}) => {
                        const r = await api.getPaging({
                            pageIndex,
                            pageSize,
                            status: 'connected',
                            protocol: f.protocol,
                            userId: f.userId,
                            assetId: f.assetId,
                            clientIp: keyword,
                        });
                        return {items: r['items'] || [], total: r['total'] || 0};
                    }}
                    renderCard={(record) => (
                        <>
                            <div className="ml-card-title">
                                <Tag color={PROTOCOL_COLORS[record['protocol']]} style={{marginRight: 0}}>
                                    {record['protocol']}
                                </Tag>
                                {/* 客户端来源：图标 + 设备名称（无名称时用"手机"/"电脑"兜底） */}
                                <span title={record['clientName'] || (record['clientType'] === 'mobile' ? '手机端连接' : '电脑端连接')}
                                      style={{flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 3, color: '#8c8c8c', fontSize: 12}}>
                                    {record['clientType'] === 'mobile'
                                        ? <MobileOutlined style={{fontSize: 14}}/>
                                        : <DesktopOutlined style={{fontSize: 14}}/>}
                                    {record['clientName'] || (record['clientType'] === 'mobile' ? '手机' : '电脑')}
                                </span>
                                {/* 会话保持标识：tmux 生效的会话可断线重连、任务不中断。
                                    断开状态（宽限期后）标识为"已断开·可恢复" */}
                                {record['keepAlive'] === '1' && (
                                    <span title={record['status'] === 'disconnected' ? '会话已断开，tmux 仍存活，点「继续」可恢复' : '会话保持已开启（断线任务不中断）'}
                                          style={{flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 2,
                                                  color: record['status'] === 'disconnected' ? '#faad14' : '#16a34a',
                                                  fontSize: 11, fontWeight: 500}}>
                                        <SafetyCertificateOutlined style={{fontSize: 12}}/>
                                        {record['status'] === 'disconnected' ? '已断开·可恢复' : '保持'}
                                    </span>
                                )}
                                <span>{record['assetName'] || record['ip']}</span>
                            </div>
                            <div className="ml-card-row">
                                <span className="k">用户</span>
                                <span className="v">{record['creatorName'] || '-'}</span>
                            </div>
                            <div className="ml-card-row">
                                <span className="k">来源 IP</span>
                                <span className="v">{record['clientIp'] || '-'}</span>
                            </div>
                            <div className="ml-card-row">
                                <span className="k">接入</span>
                                <span className="v">
                                    {differTime(new Date(record['connectedTime']), new Date())}
                                    {record['username'] ? ` · ${record['username']}@${record['ip']}:${record['port']}` : ''}
                                </span>
                            </div>
                            <div className="ml-card-actions">
                                {/* 「继续」——回到自己那个仍在连接中的会话。
                                    ─────────────────────────────────────────────
                                    为什么必须判断「令牌在不在」才显示：
                                    服务端 /sessions/:id/ssh 在会话仍在内存时会走 TryReattach，
                                    令牌无效则直接返回「会话已存在且重连令牌无效」——**不会退回新建**。
                                    所以对一个不可恢复的会话显示「继续」= 用户点了得到报错。
                                    令牌是建会话时写进 sessionStorage 的（rt-<id>），
                                    客户端能直接判断，因此按钮只在真能恢复时出现，不做假承诺。

                                    归属校验：只有自己的会话才谈得上「继续」，
                                    别人的会话走「监控」。 */}
                                {canResume(record) && (
                                    <Button type="primary"
                                            onClick={() => {
                                                const mode = record['mode'];
                                                const q = `assetId=${record['assetId']}&assetName=${encodeURIComponent(record['assetName'] || '')}&sessionId=${record['id']}&keep=1`;
                                                if (mode === 'guacd') {
                                                    window.location.hash = `#/access?${q}&protocol=${record['protocol']}`;
                                                } else {
                                                    window.location.hash = `#/term?${q}`;
                                                }
                                            }}>
                                        继续
                                    </Button>
                                )}
                                <Show menu={'online-session-monitor'}>
                                    <Button
                                        onClick={() => {
                                            switch (record['mode']) {
                                                case 'naive':
                                                case 'native':
                                                case 'terminal':
                                                    openTinyWin(`#/term-monitor?sessionId=${record['id']}`, record['id'], 1024, 768);
                                                    break;
                                                case 'guacd':
                                                    openTinyWin(`#/guacd-monitor?sessionId=${record['id']}`, record['id'], 1024, 768);
                                                    break;
                                                default:
                                                    message.info('数据异常');
                                                    break;
                                            }
                                        }}>
                                        监控
                                    </Button>
                                </Show>
                                {record['status'] === 'disconnected' && record['keepAlive'] === '1' ? (
                                    <Show menu={'online-session-disconnect'}>
                                        <Popconfirm
                                            title="清理此会话？将终止远端 tmux 并删除记录，不可恢复。"
                                            onConfirm={async () => {
                                                await api.cleanupKeepAlive(record.id);
                                                window.dispatchEvent(new Event('nt-session-count-refresh'));
                                                message.success('已清理');
                                                setMobileReloadKey((k) => k + 1);
                                            }}
                                            okText="确认"
                                            cancelText="取消"
                                        >
                                            <Button danger>清理</Button>
                                        </Popconfirm>
                                    </Show>
                                ) : (
                                <Show menu={'online-session-disconnect'}>
                                    <Popconfirm
                                        title="您确定要断开此会话吗?"
                                        onConfirm={async () => {
                                            await api.disconnect(record.id);
                                            window.dispatchEvent(new Event('nt-session-count-refresh'));
                                            message.success('已断开');
                                            setMobileReloadKey((k) => k + 1);
                                        }}
                                        okText="确认"
                                        cancelText="取消"
                                    >
                                        <Button danger>断开</Button>
                                    </Popconfirm>
                                </Show>
                                )}
                            </div>
                        </>
                    )}
                />
            </div>
        );
    }

    return (<Content className="page-container">
        <ProTable
            scroll={isMobile ? {x: 'max-content'} : undefined}
            columns={columns}
            actionRef={actionRef}
            columnsState={{
                value: columnsStateMap,
                onChange: setColumnsStateMap
            }}
            request={async (params = {}, sort, filter) => {

                let field = '';
                let order = '';
                if (Object.keys(sort).length > 0) {
                    field = Object.keys(sort)[0];
                    order = Object.values(sort)[0];
                }

                let queryParams = {
                    pageIndex: params.current,
                    pageSize: params.pageSize,
                    protocol: params.protocol,
                    field: field,
                    order: order,
                    status: 'connected'
                }
                let result = await api.getPaging(queryParams);
                return {
                    data: result['items'],
                    success: true,
                    total: result['total']
                };
            }}
            rowKey="id"
            search={{
                labelWidth: 'auto',
            }}
            pagination={{
                defaultPageSize: 10,
            }}
            dateFormatter="string"
            headerTitle="在线会话列表"
            // 在线会话是「活的」列表：此前既无轮询也无手动刷新入口
            // （toolBarRender 返回空数组），新接入的会话不出现、已断开的不消失，
            // 运维盯屏只能手动 F5。这里同时提供自动轮询与手动刷新：
            // 自动轮询负责常态更新，「接入时长」等渲染期计算的列也随之刷新。
            polling={10000}
            toolBarRender={() => [
                <Button key="refresh"
                        icon={<ReloadOutlined/>}
                        onClick={() => {
                            actionRef.current && actionRef.current.reload();
                        }}>
                    刷新
                </Button>,
            ]}
        />
    </Content>);
};

export default OnlineSession;