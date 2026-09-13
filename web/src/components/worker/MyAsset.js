import React from 'react';
import {Badge, Button, Select, Tag, Tooltip} from "antd";
import {ProTable} from "@ant-design/pro-components";
import {useIsMobile} from "../../hook/use-breakpoint";
import {PROTOCOL_COLORS} from "../../common/constants";
import strings from "../../utils/strings";
import {useQuery} from "react-query";
import workAssetApi from "../../api/worker/asset";
import dayjs from "dayjs";
import MobileList from "../mobile/MobileList";

// 卡片标题里的名称文字：MobileList 的 .ml-card-title 只对「第一个 span 子元素」做省略，
// 而协议 Tag（也是 span）才是第一个子元素，名称拿到的是不收缩的默认 flex 行为，
// 遇到超长资产名会撑破卡片造成横向溢出。这里显式补上省略规则。
const cardTitleTextStyle = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
};

// 状态点：不参与收缩（不被长名称挤扁），并固定贴在标题行最右侧
const cardStatusStyle = {
    flex: '0 0 auto',
    marginLeft: 'auto',
};

const MyAsset = () => {
    const actionRef = React.useRef(null);
    const isMobile = useIsMobile();

    const tagQuery = useQuery('getAllTag', workAssetApi.tags);

    const columns = [
        {
            dataIndex: 'index',
            valueType: 'indexBorder',
            width: 48,
        },
        {
            title: '名称',
            dataIndex: 'name',
            sorter: true,
            render: (text, record) => {
                if (record['description'] === '-') {
                    record['description'] = '';
                }
                return <div>
                    <div>{text}</div>
                    <div style={{
                        color: 'rgba(0, 0, 0, 0.45)',
                        lineHeight: 1.45,
                        fontSize: '14px'
                    }}>{record['description']}</div>
                </div>
            },
        }, {
            title: '协议',
            dataIndex: 'protocol',
            key: 'protocol',
            sorter: true,
            render: (text, record) => {
                return (
                    <Tag color={PROTOCOL_COLORS[text]}>{text}</Tag>
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
            title: '标签',
            dataIndex: 'tags',
            key: 'tags',
            render: tags => {
                if (strings.hasText(tags)) {
                    return tags.split(',').filter(tag => tag !== '-').map(tag => <Tag key={tag}>{tag}</Tag>);
                }
            },
            renderFormItem: (item, {type, defaultRender, ...rest}, form) => {
                if (type === 'form') {
                    return null;
                }

                return (
                    <Select mode="multiple"
                            allowClear>
                        {
                            tagQuery.data?.map(tag => {
                                if (tag === '-') {
                                    return undefined;
                                }
                                return <Select.Option key={tag}>{tag}</Select.Option>
                            })
                        }
                    </Select>
                );
            },
        }, {
            title: '状态',
            dataIndex: 'active',
            key: 'active',
            sorter: true,
            render: (text, record) => {
                if (record['testing'] === true) {
                    return (
                        <Tooltip title='测试中'>
                            <Badge status="processing" text='测试中'/>
                        </Tooltip>
                    )
                }
                if (text) {
                    return (
                        <Tooltip title='运行中'>
                            <Badge status="success" text='运行中'/>
                        </Tooltip>
                    )
                } else {
                    return (
                        <Tooltip title={record['activeMessage']}>
                            <Badge status="error" text='不可用'/>
                        </Tooltip>
                    )
                }
            },
            renderFormItem: (item, {type, defaultRender, ...rest}, form) => {
                if (type === 'form') {
                    return null;
                }

                return (
                    <Select>
                        <Select.Option value="true">运行中</Select.Option>
                        <Select.Option value="false">不可用</Select.Option>
                    </Select>
                );
            },
        },
        {
            title: '最后接入时间',
            key: 'lastAccessTime',
            sorter: true,
            dataIndex: 'lastAccessTime',
            hideInSearch: true,
            render: (text, record) => {
                if (text === '0001-01-01 00:00:00') {
                    return '-';
                }
                return (
                    <Tooltip title={text}>
                        {dayjs(text).fromNow()}
                    </Tooltip>
                )
            },
        },
        {
            title: '操作',
            valueType: 'option',
            key: 'option',
            render: (text, record, index, action) => {
                const id = record['id'];
                const protocol = record['protocol'];
                const name = record['name'];
                let url = '';
                if (protocol === 'ssh') {
                    url = `#/term?assetId=${id}&assetName=${name}&isWorker=true`;
                } else {
                    url = `#/access?assetId=${id}&assetName=${name}&protocol=${protocol}`;
                }

                return [
                    <a
                        key="access"
                        href={url}
                        rel="noreferrer"
                        target='_blank'
                    >
                        接入
                    </a>,
                ]
            },
        },
    ];

    // 移动端：卡片列表替代「查询表单 + 多列表格 + 工具栏」。
    // 桌面端分支完全不动，两套并存——用户要的是手机上像 App，不是把桌面改掉。
    if (isMobile) {
        const tagOptions = tagQuery.data
            ?.filter(tag => tag !== '-')
            .map(tag => ({label: tag, value: tag}));

        return (
            <div>
                <MobileList
                    title="我的资产"
                    searchPlaceholder="搜索资产名称"
                    emptyText="暂无已授权的资产"
                    // 只做后端支持的筛选：/worker/assets/paging 仅接受 name/protocol/tags，
                    // 没有 active 参数（管理端 /assets/paging 才有），故不提供「状态」筛选
                    filters={[
                        {
                            name: 'protocol', label: '协议', options: [
                                {label: 'RDP', value: 'rdp'},
                                {label: 'SSH', value: 'ssh'},
                                {label: 'Telnet', value: 'telnet'},
                                {label: 'Kubernetes', value: 'kubernetes'},
                            ]
                        },
                        {name: 'tags', label: '标签', options: tagOptions},
                    ]}
                    request={async ({pageIndex, pageSize, keyword, filters: f}) => {
                        const r = await workAssetApi.getPaging({
                            pageIndex,
                            pageSize,
                            name: keyword,
                            protocol: f.protocol,
                            tags: f.tags,
                        });
                        return {items: r['items'] || [], total: r['total'] || 0};
                    }}
                    renderCard={(record) => {
                        const protocol = record['protocol'];
                        const id = record['id'];
                        const name = record['name'];
                        // 与桌面端同一跳转规则：ssh 走原生终端（带 worker 标记），其余走 Guacamole 接入页
                        const url = protocol === 'ssh'
                            ? `#/term?assetId=${id}&assetName=${name}&isWorker=true`
                            : `#/access?assetId=${id}&assetName=${name}&protocol=${protocol}`;
                        const tags = (record['tags'] || '')
                            .split(',')
                            .filter(tag => tag && tag !== '-')
                            .join(' / ');
                        // 与桌面端一致：零值时间显示为 '-'；这里用空串作「无值」哨兵，
                        // 若用 '-' 会被下面的三元判定当作有效值送进 dayjs，渲染出 "NaN 年前"
                        const rawLastAccessTime = record['lastAccessTime'];
                        const lastAccessTime = (!rawLastAccessTime || rawLastAccessTime === '0001-01-01 00:00:00')
                            ? ''
                            : dayjs(rawLastAccessTime).fromNow();
                        return (
                            <>
                                <div className="ml-card-title">
                                    <Tag color={PROTOCOL_COLORS[protocol]}
                                         style={{marginRight: 0, flex: '0 0 auto'}}>
                                        {protocol}
                                    </Tag>
                                    <span style={cardTitleTextStyle}>{name}</span>
                                    {record['testing'] === true ? (
                                        <Tooltip title='测试中'>
                                            <Badge status="processing" style={cardStatusStyle}/>
                                        </Tooltip>
                                    ) : record['active'] ? (
                                        <Tooltip title='运行中'>
                                            <Badge status="success" style={cardStatusStyle}/>
                                        </Tooltip>
                                    ) : (
                                        <Tooltip title={record['activeMessage'] || '不可用'}>
                                            <Badge status="error" style={cardStatusStyle}/>
                                        </Tooltip>
                                    )}
                                </div>
                                {strings.hasText(record['description']) && record['description'] !== '-' && (
                                    <div className="ml-card-row">
                                        <span className="k">描述</span>
                                        <span className="v">{record['description']}</span>
                                    </div>
                                )}
                                <div className="ml-card-row">
                                    <span className="k">网络</span>
                                    <span className="v">{`${record['ip'] || '-'}:${record['port'] || ''}`}</span>
                                </div>
                                <div className="ml-card-row">
                                    <span className="k">标签</span>
                                    <span className="v">{tags || '-'}</span>
                                </div>
                                <div className="ml-card-row">
                                    <span className="k">最后接入</span>
                                    <span className="v">{lastAccessTime || '-'}</span>
                                </div>
                                <div className="ml-card-actions">
                                    {/* 普通用户只有接入一个操作，与桌面端一致 */}
                                    <Button href={url} target='_blank' rel="noreferrer">接入</Button>
                                </div>
                            </>
                        );
                    }}
                />
            </div>
        );
    }

    return (
        <div>
            <ProTable
                scroll={isMobile ? {x: 'max-content'} : undefined}
                columns={columns}
                actionRef={actionRef}
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
                        name: params.name,
                        type: params.type,
                        protocol: params.protocol,
                        active: params.active,
                        'tags': params.tags?.join(','),
                        field: field,
                        order: order
                    }
                    let result = await workAssetApi.getPaging(queryParams);

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
                    pageSizeOptions: [10, 20, 50, 100],
                    showSizeChanger: true,
                    }}
                dateFormatter="string"
                headerTitle="资产列表"
            />
        </div>
    );
}

export default MyAsset;