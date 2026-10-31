import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Input, Select, Space, Table, Tag } from 'antd';

import { confirmAdminAction } from '../../components/confirm-admin-action';
import { AdminPagination } from '../../components/admin-pagination';
import { PageToolbar } from '../../components/page-toolbar';
import { dateTime } from '../../player-admin-format';

import type { IdentityBan } from '../../player-admin-types';

type Props = {
    bans:IdentityBan[];
    total:number;
    loading:boolean;
    search:string;
    kind:'all' | 'ip' | 'device';
    page:number;
    pageSize:number;
    canManage:boolean;
    refresh:() => void;
    revoke:(ban:IdentityBan) => Promise<void>;
    setSearch:(value:string) => void;
    setKind:(value:'all' | 'ip' | 'device') => void;
    setPage:(page:number) => void;
    setPageSize:(size:number) => void;
};

export function IdentityBansPage(props:Props) {
    return (
        <>
            <PageToolbar title="IP / 设备封禁">
                <Button icon={<ReloadOutlined />} onClick={props.refresh}>
                    刷新
                </Button>
            </PageToolbar>
            <Card
                className="player-admin-panel"
                title={`有效来源封禁（${props.total}）`}
                extra={
                    <Space>
                        <Input
                            prefix={<SearchOutlined />}
                            allowClear
                            placeholder="搜索 IP、设备标识、原因或玩家"
                            value={props.search}
                            onChange={(event) => {
                                props.setSearch(event.target.value);
                                props.setPage(1);
                            }}
                            style={{ width: 280 }}
                        />
                        <Select
                            value={props.kind}
                            onChange={(value) => {
                                props.setKind(value);
                                props.setPage(1);
                            }}
                            style={{ width: 120 }}
                            options={[
                                { value: 'all', label: '全部类型' },
                                { value: 'ip', label: 'IP 封禁' },
                                { value: 'device', label: '设备封禁' },
                            ]}
                        />
                    </Space>
                }
            >
                <Table<IdentityBan>
                    loading={props.loading}
                    dataSource={props.bans}
                    rowKey="id"
                    pagination={false}
                    columns={[
                        {
                            title: '类型',
                            dataIndex: 'kind',
                            render: (value) => (
                                <Tag color={value === 'ip' ? 'gold' : 'purple'}>
                                    {value === 'ip' ? 'IP 封禁' : '设备封禁'}
                                </Tag>
                            ),
                        },
                        { title: '对象', dataIndex: 'displayValue' },
                        { title: '原因', dataIndex: 'reason', render: (value) => value || '—' },
                        {
                            title: '来源玩家',
                            render: (_, row) => (
                                <>
                                    {row.sourceDisplayName}
                                    <div className="player-admin-muted">
                                        {row.sourceUsername ? `@${row.sourceUsername}` : '—'}
                                    </div>
                                </>
                            ),
                        },
                        { title: '封禁时间', dataIndex: 'bannedAt', render: dateTime },
                        {
                            title: '自动解封时间',
                            dataIndex: 'bannedUntil',
                            render: dateTime,
                        },
                        {
                            title: '操作',
                            render: (_, row) =>
                                props.canManage ? (
                                    <Button
                                        danger
                                        type="link"
                                        onClick={() =>
                                            confirmAdminAction({
                                                title: `确定解除这项${row.kind === 'ip' ? ' IP' : '设备'}封禁？`,
                                                okText: '解除封禁',
                                                okButtonProps: { danger: true },
                                                onOk: () => props.revoke(row),
                                            })
                                        }
                                    >
                                        解除
                                    </Button>
                                ) : (
                                    '只读'
                                ),
                        },
                    ]}
                />
                <AdminPagination
                    page={props.page}
                    pageSize={props.pageSize}
                    total={props.total}
                    setPage={props.setPage}
                    setPageSize={props.setPageSize}
                />
            </Card>
        </>
    );
}
