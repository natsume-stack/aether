import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Space, Table, Tag } from 'antd';

import { adminPaginationDefaults } from '../../components/admin-pagination';
import { confirmAdminAction } from '../../components/confirm-admin-action';
import { PageToolbar } from '../../components/page-toolbar';
import { dateTime } from '../../player-admin-format';

import type { Admin } from '../../player-admin-types';

type Props = {
    admins:Admin[];
    loading:boolean;
    refresh:() => Promise<void>;
    edit:(admin?:Admin) => void;
    remove:(admin:Admin) => Promise<void>;
    toggleStatus:(admin:Admin) => Promise<void>;
};

export function AdminAccountsPage({ admins, loading, refresh, edit, remove, toggleStatus }:Props) {
    const toggle = (admin:Admin) =>
        confirmAdminAction({
            title:
                admin.status === 'active'
                    ? `停用 ${admin.displayName}？`
                    : `启用 ${admin.displayName}？`,
            content:
                admin.status === 'active' ? '停用后该账号的全部后台会话会立即失效。' : undefined,
            okText: admin.status === 'active' ? '停用' : '启用',
            okButtonProps: admin.status === 'active' ? { danger: true } : undefined,
            onOk: () => toggleStatus(admin),
        });
    return (
        <>
            <PageToolbar title="管理账号">
                <Space>
                    <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
                        刷新
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>
                        新增管理账号
                    </Button>
                </Space>
            </PageToolbar>
            <Card className="player-admin-panel">
                <Table<Admin>
                    loading={loading}
                    dataSource={admins}
                    rowKey="id"
                    pagination={{
                        ...adminPaginationDefaults,
                        showTotal: (count) => `共 ${count} 个管理账号`,
                    }}
                    columns={[
                        {
                            title: '账号',
                            render: (_, row) => (
                                <>
                                    <div className="player-admin-player-name">
                                        {row.displayName}
                                    </div>
                                    <div className="player-admin-muted">@{row.username}</div>
                                </>
                            ),
                        },
                        {
                            title: '权限组',
                            dataIndex: 'permissionGroupName',
                            render: (value) => value || '未分配权限组',
                        },
                        {
                            title: '状态',
                            dataIndex: 'status',
                            render: (value) => (
                                <Tag color={value === 'active' ? 'success' : 'default'}>
                                    {value === 'active' ? '启用' : '停用'}
                                </Tag>
                            ),
                        },
                        { title: '最近登录', dataIndex: 'lastLoginAt', render: dateTime },
                        {
                            title: '操作',
                            render: (_, row) => (
                                <Space>
                                    <Button type="link" onClick={() => edit(row)}>
                                        编辑
                                    </Button>
                                    <Button type="link" onClick={() => toggle(row)}>
                                        {row.status === 'active' ? '停用' : '启用'}
                                    </Button>
                                    <Button
                                        danger
                                        type="link"
                                        onClick={() =>
                                            confirmAdminAction({
                                                title: `删除 ${row.displayName}？`,
                                                content: '删除后无法恢复。',
                                                okText: '删除',
                                                okButtonProps: { danger: true },
                                                onOk: () => remove(row),
                                            })
                                        }
                                    >
                                        删除
                                    </Button>
                                </Space>
                            ),
                        },
                    ]}
                />
            </Card>
        </>
    );
}
