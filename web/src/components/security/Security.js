import React, {useState} from 'react';

import {Button, Layout, Popconfirm, Tag, message} from "antd";
import {ProTable} from "@ant-design/pro-components";
import {useIsMobile} from "../../hook/use-breakpoint";
import SecurityModal from "./SecurityModal";
import securityApi from "../../api/security";
import ColumnState, {useColumnState} from "../../hook/column-state";
import Show from "../../dd/fi/show";

const api = securityApi;

const {Content} = Layout;

const Security = () => {
    const actionRef = React.useRef(null);
    const isMobile = useIsMobile();
    let [visible, setVisible] = useState(false);
    let [confirmLoading, setConfirmLoading] = useState(false);
    let [selectedRowKey, setSelectedRowKey] = useState(undefined);

    const [columnsStateMap, setColumnsStateMap] = useColumnState(ColumnState.ACCESS_SECURITY);

    const columns = [
        {
            dataIndex: 'index',
            valueType: 'indexBorder',
            width: 48,
        },
        {
            title: 'IP',
            dataIndex: 'ip',
            key: 'ip',
            sorter: true,
        }, {
            title: '规则',
            dataIndex: 'rule',
            key: 'rule',
            hideInSearch: true,
            render: (rule) => {
                if (rule === 'allow') {
                    return <Tag color={'green'}>允许</Tag>
                } else {
                    return <Tag color={'red'}>禁止</Tag>
                }
            }
        }, {
            title: '优先级',
            dataIndex: 'priority',
            key: 'priority',
            sorter: true,
            hideInSearch: true,
        }, {
            title: '来源',
            dataIndex: 'source',
            key: 'source',
            hideInSearch: true,
        },
        {
            title: '操作',
            valueType: 'option',
            key: 'option',
            render: (text, record, _, action) => [
                <Show menu={'access-security-edit'} key={'access-security-edit'}>
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
                <Show menu={'access-security-del'} key={'access-security-del'}>
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
                    headerTitle="访问规则列表"
                    toolBarRender={() => [
                        <Show menu={'access-security-add'}>
                            <Button key="button" type="primary" onClick={() => {
                                setVisible(true)
                            }}>
                                新建
                            </Button>
                        </Show>,
                    ]}
                />

                <SecurityModal
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
            </Content>
        </div>
    );
}

export default Security;
