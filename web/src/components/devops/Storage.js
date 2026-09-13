import React, {useState} from 'react';
import {Button, Drawer, Layout, message, Popconfirm, Tag} from "antd";
import {ProTable} from "@ant-design/pro-components";
import {useIsMobile} from "../../hook/use-breakpoint";
import storageApi from "../../api/storage";
import StorageModal from "./StorageModal";
import {renderSize} from "../../utils/utils";
import FileSystem from "./FileSystem";
import ColumnState, {useColumnState} from "../../hook/column-state";
import Show from "../../dd/fi/show";

const api = storageApi;

const {Content} = Layout;

const Storage = () => {
    const actionRef = React.useRef(null);
    const isMobile = useIsMobile();
    let [visible, setVisible] = useState(false);
    let [confirmLoading, setConfirmLoading] = useState(false);
    let [selectedRowKey, setSelectedRowKey] = useState(undefined);

    let [fileSystemVisible, setFileSystemVisible] = useState(false);
    const [columnsStateMap, setColumnsStateMap] = useColumnState(ColumnState.STORAGE);

    const columns = [
        {
            dataIndex: 'index',
            valueType: 'indexBorder',
            width: 48,
        },
        {
            title: '名称',
            dataIndex: 'name',
            key: 'name',
        }, {
            title: '是否共享',
            dataIndex: 'isShare',
            key: 'isShare',
            hideInSearch: true,
            render: (isShare) => {
                if (isShare) {
                    return <Tag color={'green'}>是</Tag>
                } else {
                    return <Tag color={'red'}>否</Tag>
                }
            }
        }, {
            title: '是否默认',
            dataIndex: 'isDefault',
            key: 'isDefault',
            hideInSearch: true,
            render: (isDefault) => {
                if (isDefault) {
                    return <Tag color={'green'}>是</Tag>
                } else {
                    return <Tag color={'red'}>否</Tag>
                }
            }
        }, {
            title: '大小限制',
            dataIndex: 'limitSize',
            key: 'limitSize',
            hideInSearch: true,
            render: (text => {
                return text < 0 ? '无限制' : renderSize(text);
            })
        }, {
            title: '已用大小',
            dataIndex: 'usedSize',
            key: 'usedSize',
            hideInSearch: true,
            render: (text => {
                return renderSize(text);
            })
        }, {
            title: '所属用户',
            dataIndex: 'ownerName',
            key: 'ownerName',
            hideInSearch: true,
        },
        {
            title: '操作',
            valueType: 'option',
            key: 'option',
            render: (text, record, _, action) => [
                <Show menu={'storage-browse'} key={'storage-browse'}>
                    <a
                        key="edit"
                        onClick={() => {
                            setFileSystemVisible(true);
                            setSelectedRowKey(record['id']);
                        }}
                    >
                        浏览
                    </a>
                </Show>,
                <Show menu={'storage-edit'} key={'storage-edit'}>
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
                <Show menu={'storage-del'} key={'storage-del'}>
                    {/* 同 Role.js：<a disabled> 无禁用效果，默认存储空间必须条件渲染 */}
                    {record['isDefault'] ? (
                        <a key='delete' className='danger-disabled' title='默认存储空间不可删除'>删除</a>
                    ) : (
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
                    )}
                </Show>,
            ],
        },
    ];

    return (
        <div>
            <Content className="page-container">
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
                            name: params.name,
                            field: field,
                            order: order
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
                        pageSizeOptions: [10, 20, 50, 100],
                        showSizeChanger: true,
                        }}
                    dateFormatter="string"
                    headerTitle="磁盘空间列表"
                    toolBarRender={() => [
                        <Show menu={'storage-add'}>
                            <Button key="button" type="primary" onClick={() => {
                                setVisible(true)
                            }}>
                                新建
                            </Button>
                        </Show>,
                    ]}
                />

                <StorageModal
                    id={selectedRowKey}
                    visible={visible}
                    confirmLoading={confirmLoading}
                    handleCancel={() => {
                        setVisible(false);
                        setSelectedRowKey(undefined);
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
                        }
                    }}
                />

                <Drawer
                    title={'文件管理'}
                    placement="right"
                    width={window.innerWidth * 0.8}
                    closable={true}
                    maskClosable={true}
                    onClose={() => {
                        setFileSystemVisible(false);
                        setSelectedRowKey(undefined);
                        actionRef.current.reload();
                    }}
                    visible={fileSystemVisible}
                >
                    {fileSystemVisible ?
                        <FileSystem
                            storageId={selectedRowKey}
                            storageType={'storages'}
                            upload={true}
                            download={true}
                            delete={true}
                            rename={true}
                            edit={true}
                            minHeight={window.innerHeight - 103}/>
                        : undefined
                    }

                </Drawer>
            </Content>
        </div>
    );
}

export default Storage;