import React, {useEffect, useState} from 'react';

import {
    Badge,
    Button,
    Layout,
    message,
    Modal,
    notification,
    Popconfirm,
    Popover,
    Select,
    Space,
    Table,
    Tag,
    Tooltip,
    Upload
} from "antd";
import {SortAscendingOutlined} from "@ant-design/icons";
import {Link, useNavigate} from "react-router-dom";
import {ProTable, TableDropdown} from "@ant-design/pro-components";
import {useIsMobile} from "../../hook/use-breakpoint";
import assetApi from "../../api/asset";
import tagApi from "../../api/tag";
import {PROTOCOL_COLORS} from "../../common/constants";
import strings from "../../utils/strings";
import AssetModal from "./AssetModal";
import ColumnState, {useColumnState} from "../../hook/column-state";
import {useQuery} from "react-query";
import Show from "../../dd/fi/show";
import {hasMenu} from "../../service/permission";
import ChangeOwner from "./ChangeOwner";
import dayjs from "dayjs";
import MobileList from "../mobile/MobileList";

const api = assetApi;
const {Content} = Layout;

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


function downloadImportExampleCsv() {
    let csvString = 'name,ssh,127.0.0.1,22,username,password,privateKey,passphrase,description,tag1|tag2|tag3';
    //前置的"\uFEFF"为“零宽不换行空格”，可处理中文乱码问题
    const blob = new Blob(["\uFEFF" + csvString], {type: 'text/csv;charset=gb2312;'});
    let a = document.createElement('a');
    a.download = 'sample.csv';
    a.href = URL.createObjectURL(blob);
    a.click();
}

const importExampleContent = <>
    <a onClick={downloadImportExampleCsv}>下载示例</a>
    <div>导入资产时，账号、密码和密钥、密码属于二选一，都填写时优先选择私钥和密码。</div>
</>

const Asset = () => {
    const actionRef = React.useRef(null);
    const isMobile = useIsMobile();
    let [visible, setVisible] = useState(false);
    let [confirmLoading, setConfirmLoading] = useState(false);
    let [selectedRowKey, setSelectedRowKey] = useState(undefined);
    let [items, setItems] = useState([]);
    let [selectedRowKeys, setSelectedRowKeys] = useState([]);
    let [copied, setCopied] = useState(false);

    let [selectedRow, setSelectedRow] = useState(undefined);
    let [changeOwnerVisible, setChangeOwnerVisible] = useState(false);
    // 新建/编辑后让移动端列表重新取数（卡片列表自管分页，没有 actionRef 可 reload）
    const [mobileReloadKey, setMobileReloadKey] = useState(0);
    let [sortMode, setSortMode] = useState(false); // 排序模式：仅开启时允许整行拖拽排序
    const dragStateRef = React.useRef(null);        // {fromId, row} 拖拽中状态（DOM 级反馈）

    const [columnsStateMap, setColumnsStateMap] = useColumnState(ColumnState.ASSET);

    const tagQuery = useQuery('getAllTag', tagApi.getAll);
    let navigate = useNavigate();

    // 整行拖拽排序（仅排序模式）：事件委托在表格容器上，读取 antd 行的 data-row-key
    // 只发送单步移动意图（{id, targetId}），服务端在数据库真实顺序上移动——不会乱序
    const rowIdOf = (target) => {
        const tr = target && target.closest ? target.closest('tr.ant-table-row') : null;
        return tr ? tr.getAttribute('data-row-key') : null;
    };
    const clearDragFeedback = () => {
        if (dragStateRef.current) {
            const {row} = dragStateRef.current;
            if (row) {
                row.style.opacity = '';
                row.style.background = '';
            }
            document.querySelectorAll('.asset-drag-target-row').forEach(el => {
                el.classList.remove('asset-drag-target-row');
                el.style.boxShadow = '';
            });
            dragStateRef.current = null;
        }
    };
    const handleDragStart = (e) => {
        const id = rowIdOf(e.target);
        if (!id) {
            return;
        }
        const row = e.target.closest('tr.ant-table-row');
        dragStateRef.current = {fromId: id, row};
        row.style.opacity = '0.45';
        row.style.background = '#e6f7ff';
        e.dataTransfer.effectAllowed = 'move';
        try {
            e.dataTransfer.setData('text/plain', id);
        } catch (err) {
        }
    };
    const handleDragOver = (e) => {
        const id = rowIdOf(e.target);
        if (!id || !dragStateRef.current) {
            return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.asset-drag-target-row').forEach(el => {
            el.classList.remove('asset-drag-target-row');
            el.style.boxShadow = '';
        });
        if (id !== dragStateRef.current.fromId) {
            const row = e.target.closest('tr.ant-table-row');
            row.classList.add('asset-drag-target-row');
            row.style.boxShadow = 'inset 0 2px 0 #1890ff';
        }
    };
    const handleDrop = async (e) => {
        e.preventDefault();
        const targetId = rowIdOf(e.target);
        const fromId = dragStateRef.current ? dragStateRef.current.fromId : null;
        clearDragFeedback();
        if (!fromId || !targetId || fromId === targetId) {
            return;
        }
        let result = await assetApi.move(fromId, targetId);
        if (result['code'] === 1) {
            actionRef.current && actionRef.current.reload();
        } else {
            message.info(result['message'] || '移动失败');
        }
    };
    const handleDragEnd = () => {
        clearDragFeedback();
    };

    // 排序模式下给每行设置 draggable=true：HTML5 拖拽仅在 draggable 元素上触发，
    // 否则鼠标拖动退化为文本选择（ProTable 不透传 onRow，用 DOM 后处理）
    useEffect(() => {
        if (!sortMode) {
            return;
        }
        const applyDraggable = () => {
            document.querySelectorAll('.asset-sort-mode .ant-table-row').forEach(tr => {
                tr.setAttribute('draggable', 'true');
            });
        };
        applyDraggable();
        // 表格数据重渲染后行节点重建，延迟再应用一次
        const timer = setTimeout(applyDraggable, 300);
        return () => clearTimeout(timer);
    }, [sortMode, items]);

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

                let view = <div>{text}</div>;
                if (hasMenu('asset-detail')) {
                    view = <Link to={`/asset/${record['id']}`}>{text}</Link>;
                }
                return <div>
                    {view}
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
            title: '网络',
            dataIndex: 'network',
            key: 'network',
            sorter: true,
            fieldProps: {
                placeholder: '示例: 127、127.0.0.1、:22、127.0.0.1:22'
            },
            render: (text, record) => {
                return `${record['ip'] + ':' + record['port']}`;
            }
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
        }, {
            title: '所有者',
            dataIndex: 'ownerName',
            key: 'ownerName',
            hideInSearch: true,
        },
        {
            title: '创建时间',
            key: 'created',
            sorter: true,
            dataIndex: 'created',
            hideInSearch: true,
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
                    url = `#/term?assetId=${id}&assetName=${name}`;
                } else {
                    url = `#/access?assetId=${id}&assetName=${name}&protocol=${protocol}`;
                }

                return [
                    <Show menu={'asset-access'} key={'asset-access'}>
                        <a
                            key="access"
                            href={url}
                            target='_blank'
                        >
                            接入
                        </a>
                    </Show>,
                    <Show menu={'asset-edit'} key={'asset-edit'}>
                        <a
                            key="edit"
                            onClick={() => {
                                setVisible(true);
                                setSelectedRowKey(record['id']);
                            }}
                        >
                            编辑
                        </a>
                    </Show>,
                    <Show menu={'asset-del'} key={'asset-del'}>
                        <Popconfirm
                            key={'confirm-delete'}
                            title="您确认要删除此行吗?"
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
                    <TableDropdown
                        key="actionGroup"
                        onSelect={(key) => {
                            switch (key) {
                                case "copy":
                                    setCopied(true);
                                    setVisible(true);
                                    setSelectedRowKey(record['id']);
                                    break;
                                case "test":
                                    connTest(record['id'], index);
                                    break;
                                case "change-owner":
                                    handleChangeOwner(record);
                                    break;
                                case 'asset-detail':
                                    navigate(`/asset/${record['id']}?activeKey=info`);
                                    break;
                                case 'asset-authorised-user':
                                    navigate(`/asset/${record['id']}?activeKey=bind-user`);
                                    break;
                                case 'asset-authorised-user-group':
                                    navigate(`/asset/${record['id']}?activeKey=bind-user-group`);
                                    break;
                            }
                        }}
                        menus={[
                            {key: 'copy', name: '复制', disabled: !hasMenu('asset-copy')},
                            {key: 'test', name: '连通性测试', disabled: !hasMenu('asset-conn-test')},
                            {key: 'change-owner', name: '更换所有者', disabled: !hasMenu('asset-change-owner')},
                            {key: 'asset-detail', name: '详情', disabled: !hasMenu('asset-detail')},
                            {
                                key: 'asset-authorised-user',
                                name: '授权用户',
                                disabled: !hasMenu('asset-authorised-user')
                            },
                            {
                                key: 'asset-authorised-user-group',
                                name: '授权用户组',
                                disabled: !hasMenu('asset-authorised-user-group')
                            },
                        ]}
                    />,
                ]
            },
        },
    ];

    const connTest = async (id, index) => {
        items[index]['testing'] = true;
        setItems(items.slice());
        let [active, msg] = await assetApi.connTest(id);
        items[index]['active'] = active;
        items[index]['activeMessage'] = msg;
        items[index]['testing'] = false;
        setItems(items.slice());
    }

    const connTestInBatch = async () => {
        for (let i = 0; i < items.length; i++) {
            let item = items[i];
            if (selectedRowKeys.includes(item['id'])) {
                connTest(item['id'], i);
            }
        }
        setSelectedRowKeys([]);
    }

    const handleImportAsset = async (file) => {

        let [success, data] = await api.importAsset(file);
        if (success === false) {
            notification['error']({
                message: '导入资产失败',
                description: data,
            });
            return false;
        }

        let successCount = data['successCount'];
        let errorCount = data['errorCount'];
        if (errorCount === 0) {
            notification['success']({
                message: '导入资产成功',
                description: '共导入成功' + successCount + '条资产。',
            });
        } else {
            notification['info']({
                message: '导入资产完成',
                description: `共导入成功${successCount}条资产，失败${errorCount}条资产。`,
            });
        }
        actionRef.current.reload();
        return false;
    }

    const handleChangeOwner = (row) => {
        setSelectedRow(row);
        setChangeOwnerVisible(true);
    }

    // 移动端：卡片列表替代「查询表单 + 多列表格 + 工具栏」。
    // 桌面端分支完全不动——排序模式（整行拖拽）是桌面端专有特性，不搬到卡片里：
    // HTML5 draggable 在触摸屏上根本不触发，且该模式会一次性拉取全量资产。
    if (isMobile) {
        // 桌面端的 handleOk 结尾依赖 actionRef.current.reload()，而移动端不挂载 ProTable
        //（actionRef.current 为 null），故这里用 reloadKey 让卡片列表重新取数，
        // 桌面端那份处理函数一行未动。
        const mobileHandleOk = async (values) => {
            setConfirmLoading(true);
            try {
                let success;
                if (values['id']) {
                    success = await api.updateById(values['id'], values);
                } else {
                    success = await api.create(values);
                }
                if (success) {
                    setVisible(false);
                }
                setMobileReloadKey((k) => k + 1);
            } finally {
                setConfirmLoading(false);
                setSelectedRowKey(undefined);
                setCopied(false);
            }
        };

        const tagOptions = tagQuery.data
            ?.filter(tag => tag !== '-')
            .map(tag => ({label: tag, value: tag}));

        return (
            <div className="page-container">
                <MobileList
                    key={mobileReloadKey}
                    title="资产"
                    searchPlaceholder="搜索资产名称"
                    emptyText="暂无资产"
                    headerExtra={
                        <Show menu={'asset-add'}>
                            <Button type="primary" onClick={() => {
                                setSelectedRowKey(undefined);
                                setCopied(false);
                                setVisible(true);
                            }}>
                                新建
                            </Button>
                        </Show>
                    }
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
                        {
                            name: 'active', label: '状态', options: [
                                {label: '运行中', value: 'true'},
                                {label: '不可用', value: 'false'},
                            ]
                        },
                    ]}
                    request={async ({pageIndex, pageSize, keyword, filters: f}) => {
                        const r = await api.getPaging({
                            pageIndex,
                            pageSize,
                            name: keyword,
                            protocol: f.protocol,
                            tags: f.tags,
                            active: f.active,
                        });
                        return {items: r['items'] || [], total: r['total'] || 0};
                    }}
                    renderCard={(record) => {
                        const protocol = record['protocol'];
                        const id = record['id'];
                        const name = record['name'];
                        // 与桌面端同一跳转规则：ssh 走原生终端，其余走 Guacamole 接入页
                        const url = protocol === 'ssh'
                            ? `#/term?assetId=${id}&assetName=${name}`
                            : `#/access?assetId=${id}&assetName=${name}&protocol=${protocol}`;
                        const tags = (record['tags'] || '')
                            .split(',')
                            .filter(tag => tag && tag !== '-')
                            .join(' / ');
                        const description = record['description'] === '-' ? '' : record['description'];
                        return (
                            <>
                                <div className="ml-card-title">
                                    <Tag color={PROTOCOL_COLORS[protocol]}
                                         style={{marginRight: 0, flex: '0 0 auto'}}>
                                        {protocol}
                                    </Tag>
                                    <span style={cardTitleTextStyle}>{name}</span>
                                    {/* 状态：桌面端是带文字的 Badge，卡片标题行位置有限，只留状态点 + 说明 */}
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
                                {strings.hasText(description) && (
                                    <div className="ml-card-row">
                                        <span className="k">描述</span>
                                        <span className="v">{description}</span>
                                    </div>
                                )}
                                <div className="ml-card-row">
                                    <span className="k">网络</span>
                                    <span className="v">{`${record['ip'] || '-'}:${record['port'] || ''}`}</span>
                                </div>
                                <div className="ml-card-row">
                                    <span className="k">所有者</span>
                                    <span className="v">{record['ownerName'] || '-'}</span>
                                </div>
                                <div className="ml-card-row">
                                    <span className="k">标签</span>
                                    <span className="v">{tags || '-'}</span>
                                </div>
                                <div className="ml-card-row">
                                    <span className="k">创建时间</span>
                                    <span className="v">{record['created'] || '-'}</span>
                                </div>
                                <div className="ml-card-actions">
                                    <Show menu={'asset-access'}>
                                        <Button href={url} target='_blank'>接入</Button>
                                    </Show>
                                    <Show menu={'asset-edit'}>
                                        <Button onClick={() => {
                                            setSelectedRowKey(record['id']);
                                            setVisible(true);
                                        }}>
                                            编辑
                                        </Button>
                                    </Show>
                                    <Show menu={'asset-del'}>
                                        <Popconfirm
                                            title="您确认要删除此行吗?"
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

                {/* 编辑/新建共用的表单弹窗：移动端不挂载 ProTable，故本分支必须自带 */}
                <AssetModal
                    id={selectedRowKey}
                    copied={copied}
                    visible={visible}
                    confirmLoading={confirmLoading}
                    handleCancel={() => {
                        setVisible(false);
                        setSelectedRowKey(undefined);
                        setCopied(false);
                    }}
                    handleOk={mobileHandleOk}
                />
            </div>
        );
    }

    return (<Content className="page-container">
        {/* 排序模式下整行拖拽：事件委托读取 antd 行 data-row-key，单步移动语义防乱序 */}
        <div
            className={sortMode ? 'asset-sort-mode' : ''}
            onDragStart={sortMode ? handleDragStart : undefined}
            onDragOver={sortMode ? handleDragOver : undefined}
            onDrop={sortMode ? handleDrop : undefined}
            onDragEnd={sortMode ? handleDragEnd : undefined}
        >
        <style>{`.asset-sort-mode { user-select: none; }
.asset-sort-mode .ant-table-row { cursor: move; }
.asset-sort-mode .ant-table-row:hover { background: var(--bg-track); }`}</style>
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
                    if (field === 'network') {
                        field = 'ip';
                    }
                    order = Object.values(sort)[0];
                }

                let ip, port;
                if (params.network) {
                    let split = params.network.split(':');
                    if (split.length >= 2) {
                        ip = split[0];
                        port = split[1];
                    } else {
                        ip = split[0];
                    }
                }

                let queryParams = {
                    pageIndex: params.current,
                    // 排序模式加载全部资产到一页，跨页拖拽才完整
                    pageSize: sortMode ? 9999 : params.pageSize,
                    name: params.name,
                    type: params.type,
                    protocol: params.protocol,
                    active: params.active,
                    'tags': params.tags?.join(','),
                    ip: ip,
                    port: port,
                    field: field,
                    order: order
                }
                let result = await api.getPaging(queryParams);
                setItems(result['items']);
                return {
                    data: items,
                    success: true,
                    total: result['total']
                };
            }}
            rowKey="id"
            rowSelection={sortMode ? undefined : {
                // 自定义选择项参考: https://ant.design/components/table-cn/#components-table-demo-row-selection-custom
                // 注释该行则默认不显示下拉选项
                selections: [Table.SELECTION_ALL, Table.SELECTION_INVERT],
                selectedRowKeys: selectedRowKeys,
                onChange: (keys) => {
                    setSelectedRowKeys(keys);
                }
            }}
            dataSource={items}
            search={{
                labelWidth: 'auto',
            }}
            pagination={{
                defaultPageSize: 10,
                showSizeChanger: true
            }}
            dateFormatter="string"
            headerTitle="资产列表"
            toolBarRender={() => {
                return [
                    <Show menu={'asset-add'}>
                        <Button key="add" type="primary" onClick={() => {
                            setVisible(true)
                        }}>
                            新建
                        </Button>
                    </Show>,
                    <Show menu={'asset-import'}>
                        <Popover content={importExampleContent}>
                            <Upload
                                maxCount={1}
                                beforeUpload={handleImportAsset}
                                showUploadList={false}
                            >
                                <Button key='import'>导入</Button>
                            </Upload>
                        </Popover>
                    </Show>,
                    <Show menu={'asset-del'}>
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
                    <Show menu={'asset-conn-test'}>
                        <Button key="connTest"
                                type="primary"
                                disabled={selectedRowKeys.length === 0}
                                onClick={connTestInBatch}>
                            连通性测试
                        </Button>
                    </Show>,
                    // 排序模式仅桌面端提供：① HTML5 draggable 在 iOS/Android 触摸下
                    // 不触发 dragstart，移动端一行也拖不动；② 该模式会把 pageSize 设为 9999
                    // 一次性拉取全部资产，手机上一次误触就是一次全量请求。
                    !isMobile && (
                        <Button key="sort"
                                type={sortMode ? 'primary' : 'default'}
                                ghost={sortMode}
                                icon={<SortAscendingOutlined/>}
                                onClick={() => {
                                    setSortMode(!sortMode);
                                    if (sortMode) {
                                        message.destroy();
                                    } else {
                                        message.info('排序模式：拖动行调整顺序，点击完成排序退出', 3);
                                    }
                                    actionRef.current && actionRef.current.reload();
                                }}>
                            {sortMode ? '完成排序' : '排序'}
                        </Button>
                    )
                ];
            }}
        />
        </div>

        <AssetModal
            id={selectedRowKey}
            copied={copied}
            visible={visible}
            confirmLoading={confirmLoading}
            handleCancel={() => {
                setVisible(false);
                setSelectedRowKey(undefined);
                setCopied(false);
            }}
            handleOk={async (values) => {
                setConfirmLoading(true);

                try {
                    let success;
                    if (values['id']) {
                        success = await api.updateById(values['id'], values);
                    } else {
                        success = await api.create(values);
                    }
                    if (success) {
                        setVisible(false);
                    }
                    actionRef.current.reload();
                } finally {
                    setConfirmLoading(false);
                    setSelectedRowKey(undefined);
                    setCopied(false);
                }
            }}
        />

        <ChangeOwner
            lastOwner={selectedRow?.owner}
            open={changeOwnerVisible}
            handleOk={async (owner) => {
                let success = await api.changeOwner(selectedRow?.id, owner);
                if (success) {
                    setChangeOwnerVisible(false);
                    actionRef.current.reload();
                }
            }}
            handleCancel={() => {
                setChangeOwnerVisible(false);
            }}
        />

    </Content>);
}

export default Asset;
