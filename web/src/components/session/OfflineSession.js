import React, {useState} from 'react';
import {Button, Drawer, Layout, message, Modal, Popconfirm, Select, Table, Tag, Tooltip} from "antd";
import {ProTable} from "@ant-design/pro-components";
import {useIsMobile} from "../../hook/use-breakpoint";
import ColumnState, {useColumnState} from "../../hook/column-state";

import {differTime} from "../../utils/utils";
import {openTinyWin} from "../../utils/window";
import {MODE_COLORS, PROTOCOL_COLORS} from "../../common/constants";
import sessionApi from "../../api/session";
import './OfflineSession.css'
import Show from "../../dd/fi/show";
import {useQuery} from "react-query";
import userApi from "../../api/user";
import assetApi from "../../api/asset";
import MobileList from "../mobile/MobileList";

const {Content} = Layout;
const api = sessionApi;

// 卡片标题里的名称文字：MobileList 的 .ml-card-title 只对「第一个 span 子元素」做省略，
// 而协议 Tag（也是 span）才是第一个子元素，名称拿到的是不收缩的默认 flex 行为，
// 遇到超长资产名会撑破卡片造成横向溢出。这里显式补上省略规则。
const cardTitleTextStyle = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
};

const OfflineSession = () => {
    const actionRef = React.useRef(null);
    const isMobile = useIsMobile();

    const [columnsStateMap, setColumnsStateMap] = useColumnState(ColumnState.OFFLINE_SESSION);

    let [selectedRowKeys, setSelectedRowKeys] = useState([]);
    // 删除/标记已读后让移动端列表重新取数（卡片列表自管分页，没有 actionRef）
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
                return differTime(new Date(record['connectedTime']), new Date(record['disconnectedTime']));
            },
            hideInSearch: true,
        },
        {
            title: '操作',
            valueType: 'option',
            key: 'option',
            render: (text, record, _, action) => {
                let disablePlayback = record['recording'] !== '1';
                let disableCmdRecord = record['commandCount'] === 0;
                return [
                    <Show menu={'offline-session-playback'} key={'offline-session-playback'}>
                        <Button
                            key='monitor'
                            disabled={disablePlayback}
                            type="link"
                            size='small'
                            onClick={() => {
                                switch (record['mode']) {
                                    case 'naive':
                                    case 'native':
                                    case 'terminal':
                                        openTinyWin(`#/term-playback?sessionId=${record['id']}`, record['id'], 1024, 520);
                                        break;
                                    case 'guacd':
                                        openTinyWin(`#/guacd-playback?sessionId=${record['id']}`, record['id'], 1024, 768);
                                        break;
                                    default:
                                        message.info('数据异常');
                                        break;
                                }
                            }}>
                            回放
                        </Button>
                    </Show>,
                    <Show menu={'offline-session-reviewed'} key={'offline-session-reviewed'}>
                        {/* 审计闭环：此前「未审查」只体现为行背景色（无图例、无处置入口），
                            后端三套端点早已就绪却没有前端入口，用户看到一片蓝色无从下手 */}
                        <a key='reviewed'
                           onClick={async () => {
                               const ok = record['reviewed']
                                   ? await api.markUnreviewed(record.id)
                                   : await api.markReviewed(record.id);
                               if (!ok) {
                                   return;
                               }
                               message.success(record['reviewed'] ? '已标记为未审查' : '已标记为已审查');
                               actionRef.current.reload();
                           }}>
                            {record['reviewed'] ? '标记未读' : '标记已读'}
                        </a>
                    </Show>,
                    <Show menu={'offline-session-del'} key={'offline-session-del'}>
                        <Popconfirm
                            key={'confirm-delete'}
                            title="您确定要删除此会话吗?"
                            onConfirm={async () => {
                                const ok = await api.deleteById(record.id);
                                if (!ok) {
                                    return;
                                }
                                message.success('删除成功');
                                actionRef.current.reload();
                            }}
                            okText="确认"
                            cancelText="取消"
                        >
                            <a key='delete' className='danger'>删除</a>
                        </Popconfirm>
                    </Show>,
                ]
            },
        },
    ];

    // 移动端：卡片列表替代「查询表单 + 多列表格 + 工具栏」。
    // 桌面端分支完全不动，两套并存——用户要的是手机上像 App，不是把桌面改掉。
    if (isMobile) {
        return (
            <div className="page-container">
                <MobileList
                    key={mobileReloadKey}
                    title="历史会话"
                    searchPlaceholder="搜索来源 IP"
                    emptyText="暂无历史会话"
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
                        {
                            name: 'reviewed', label: '审查状态', options: [
                                {label: '已审查', value: 'true'},
                                {label: '未审查', value: 'false'},
                            ]
                        },
                    ]}
                    request={async ({pageIndex, pageSize, keyword, filters: f}) => {
                        const r = await api.getPaging({
                            pageIndex,
                            pageSize,
                            status: 'disconnected',
                            protocol: f.protocol,
                            userId: f.userId,
                            assetId: f.assetId,
                            reviewed: f.reviewed,
                            clientIp: keyword,
                        });
                        return {items: r['items'] || [], total: r['total'] || 0};
                    }}
                    renderCard={(record) => {
                        // 与桌面端同一判定：录屏文件不存在（recording !== '1'）时不可回放
                        const disablePlayback = record['recording'] !== '1';
                        const connectedTime = record['connectedTime'];
                        const disconnectedTime = record['disconnectedTime'];
                        const duration = (connectedTime && disconnectedTime)
                            ? differTime(new Date(connectedTime), new Date(disconnectedTime))
                            : '-';
                        return (
                            <>
                                <div className="ml-card-title">
                                    <Tag color={PROTOCOL_COLORS[record['protocol']]}
                                         style={{marginRight: 0, flex: '0 0 auto'}}>
                                        {record['protocol']}
                                    </Tag>
                                    <span style={cardTitleTextStyle}>
                                        {record['assetName'] || record['ip']}
                                    </span>
                                    {/* 未审查：桌面端只靠行背景色（无图例），卡片上直接给 Tag 更明确 */}
                                    {!record['reviewed'] && (
                                        <Tag color="blue" style={{marginRight: 0, flex: '0 0 auto'}}>未审查</Tag>
                                    )}
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
                                    <span className="k">接入时间</span>
                                    <span className="v">{connectedTime || '-'}</span>
                                </div>
                                <div className="ml-card-row">
                                    <span className="k">时长</span>
                                    <span className="v">{duration}</span>
                                </div>
                                <div className="ml-card-actions">
                                    {/* 「继续」——断网/换网络后恢复原会话（tmux 会话保持）。
                                        仅对自己创建的 SSH 类会话显示：恢复会走 /term 的复用重连
                                        （同一 sessionId，服务端 attach 回原 tmux，任务继续）。
                                        桌面端直连（keep=0）的会话也能进来 —— 服务端会按
                                        keep 参数新建连接（任务不保证延续，但入口无害）。 */}
                                    {record['mode'] !== 'guacd' && (
                                        <Button type="primary"
                                                onClick={() => {
                                                    const q = `assetId=${record['assetId']}&assetName=${encodeURIComponent(record['assetName'] || '')}&sessionId=${record['id']}&keep=1`;
                                                    window.location.hash = `#/term?${q}`;
                                                }}>
                                            继续
                                        </Button>
                                    )}
                                    <Show menu={'offline-session-playback'}>
                                        <Button
                                            disabled={disablePlayback}
                                            title={disablePlayback ? '该会话未生成录屏文件，无法回放' : undefined}
                                            onClick={() => {
                                                switch (record['mode']) {
                                                    case 'naive':
                                                    case 'native':
                                                    case 'terminal':
                                                        openTinyWin(`#/term-playback?sessionId=${record['id']}`, record['id'], 1024, 520);
                                                        break;
                                                    case 'guacd':
                                                        openTinyWin(`#/guacd-playback?sessionId=${record['id']}`, record['id'], 1024, 768);
                                                        break;
                                                    default:
                                                        message.info('数据异常');
                                                        break;
                                                }
                                            }}>
                                            回放
                                        </Button>
                                    </Show>
                                    <Show menu={'offline-session-reviewed'}>
                                        <Button
                                            onClick={async () => {
                                                const ok = record['reviewed']
                                                    ? await api.markUnreviewed(record.id)
                                                    : await api.markReviewed(record.id);
                                                if (!ok) {
                                                    return;
                                                }
                                                message.success(record['reviewed'] ? '已标记为未审查' : '已标记为已审查');
                                                setMobileReloadKey((k) => k + 1);
                                            }}>
                                            {record['reviewed'] ? '标记未读' : '标记已读'}
                                        </Button>
                                    </Show>
                                    <Show menu={'offline-session-del'}>
                                        <Popconfirm
                                            title="您确定要删除此会话吗?"
                                            onConfirm={async () => {
                                                const ok = await api.deleteById(record.id);
                                                if (!ok) {
                                                    return;
                                                }
                                                message.success('删除成功');
                                                setMobileReloadKey((k) => k + 1);
                                            }}
                                            okText="确认"
                                            cancelText="取消"
                                        >
                                            <Button danger>删除</Button>
                                        </Popconfirm>
                                    </Show>
                                </div>
                            </>
                        );
                    }}
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
                    clientIp: params.clientIp,
                    userId: params.creatorName,
                    assetId: params.assetName,
                    field: field,
                    order: order,
                    status: 'disconnected',
                }
                let result = await api.getPaging(queryParams);
                return {
                    data: result['items'],
                    success: true,
                    total: result['total']
                };
            }}
            rowKey="id"
            rowClassName={(record, index) => {
                return record['reviewed'] ? '' : 'unreviewed';
            }}
            rowSelection={{
                // 自定义选择项参考: https://ant.design/components/table-cn/#components-table-demo-row-selection-custom
                // 注释该行则默认不显示下拉选项
                selections: [Table.SELECTION_ALL, Table.SELECTION_INVERT],
                selectedRowKeys: selectedRowKeys,
                onChange: (keys) => {
                    setSelectedRowKeys(keys);
                }
            }}
            search={{
                labelWidth: 'auto',
            }}
            pagination={{
                defaultPageSize: 10,
                showSizeChanger: true
            }}
            dateFormatter="string"
            headerTitle="离线会话列表"
            toolBarRender={() => [
                <Show menu={'offline-session-reviewed-all'}>
                    <Button key="reviewedAll"
                            onClick={() => {
                                Modal.confirm({
                                    title: '将全部未审查会话标记为已审查？',
                                    okText: '确定',
                                    cancelText: '取消',
                                    onOk: async () => {
                                        const ok = await api.markAllReviewed();
                                        if (!ok) {
                                            return;
                                        }
                                        message.success('已全部标记为已审查');
                                        actionRef.current.reload();
                                    }
                                });
                            }}>
                        全部标记已读
                    </Button>
                </Show>,
                <Show menu={'offline-session-del'}>
                    <Button key="delete" danger
                            type="primary"
                            disabled={selectedRowKeys.length === 0}
                            onClick={() => {
                                Modal.confirm({
                                    title: '您确定要删除选中的行吗?',
                                    content: '删除之后无法进行恢复，请慎重考虑。',
                                    okText: '确定',
                                    okType: 'danger',
                                    cancelText: '取消',
                                    onOk: async () => {
                                        const ok = await api.deleteById(selectedRowKeys.join(","));
                                        if (!ok) {
                                            return;
                                        }
                                        message.success('删除成功');
                                        actionRef.current.reload();
                                        setSelectedRowKeys([]);
                                    }
                                });
                            }}>
                        删除
                    </Button>
                </Show>,
                <Show menu={'offline-session-clear'}>
                    <Button key="clear" danger
                            type="primary"
                            onClick={() => {
                                Modal.confirm({
                                    title: '您确定要清空全部会话吗?',
                                    content: '清空之后无法进行恢复，请慎重考虑。',
                                    okText: '确定',
                                    okType: 'danger',
                                    cancelText: '取消',
                                    onOk: async () => {
                                        await api.clear();
                                        actionRef.current.reload();
                                        setSelectedRowKeys([]);
                                    }
                                });
                            }}>
                        清空
                    </Button>
                </Show>,
            ]}
        />
    </Content>);
};

export default OfflineSession;