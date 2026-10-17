import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Input, Select, Table, Tag } from 'antd';
import { useState } from 'react';

import { AdminPagination } from '../../components/admin-pagination';
import { PageToolbar } from '../../components/page-toolbar';
import {
    activityActionName,
    activityTarget,
    ActivityResult,
    isScriptActivity,
    SecurityActivityDetails,
} from './security-activity-details';
import { dateTime } from '../../player-admin-format';

import type { Activity } from '../../player-admin-types';

type Props = {
    events:Activity[];
    total:number;
    loading:boolean;
    page:number;
    pageSize:number;
    kind:string;
    search:string;
    refresh:() => void;
    setPage:(page:number) => void;
    setPageSize:(size:number) => void;
    setKind:(kind:string) => void;
    setSearch:(search:string) => void;
};

export function SecurityActivityPage(props:Props) {
    const [selected, setSelected] = useState<Activity>();
    const resetSearch = (value:string) => {
        props.setSearch(value);
        props.setPage(1);
    };
    const resetKind = (value:string) => {
        props.setKind(value);
        props.setPage(1);
    };
    return (
        <>
            <PageToolbar title="安全记录">
                <Button icon={<ReloadOutlined />} onClick={props.refresh}>
                    刷新
                </Button>
            </PageToolbar>
            <Card className="player-admin-panel" title={`操作与登录记录（${props.total}）`}>
                <div className="player-admin-filterbar">
                    <Input
                        prefix={<SearchOutlined />}
                        allowClear
                        placeholder="搜索操作、账号、地图、IP 或请求 ID"
                        value={props.search}
                        onChange={(event) => resetSearch(event.target.value)}
                    />
                    <Select
                        value={props.kind}
                        style={{ width: 140 }}
                        onChange={resetKind}
                        options={[
                            { value: 'all', label: '全部记录' },
                            { value: 'admin', label: '管理操作' },
                            { value: 'login', label: '登录记录' },
                        ]}
                    />
                </div>
                <Table<Activity>
                    loading={props.loading}
                    dataSource={props.events}
                    rowKey="id"
                    pagination={false}
                    columns={[
                        { title: '时间', dataIndex: 'createdAt', render: dateTime },
                        {
                            title: '类型',
                            dataIndex: 'kind',
                            render: (value, row) => (
                                <Tag
                                    color={
                                        isScriptActivity(row)
                                            ? 'purple'
                                            : value === 'admin'
                                              ? 'blue'
                                              : 'default'
                                    }
                                >
                                    {isScriptActivity(row)
                                        ? '地图脚本'
                                        : value === 'admin'
                                          ? '管理操作'
                                          : '登录'}
                                </Tag>
                            ),
                        },
                        {
                            title: '操作',
                            render: (_, row) => (
                                <>
                                    <div>{activityActionName(row.action)}</div>
                                    <small className="player-admin-muted">{row.action}</small>
                                </>
                            ),
                        },
                        {
                            title: '结果',
                            width: 90,
                            render: (_, row) => <ActivityResult row={row} />,
                        },
                        { title: '操作人', render: (_, row) => row.actorDisplayName || row.actor },
                        {
                            title: '对象',
                            render: (_, row) => {
                                const target = activityTarget(row);
                                return (
                                    <>
                                        <div>{target.name}</div>
                                        {target.id && (
                                            <small
                                                className="player-admin-muted"
                                                style={{ overflowWrap: 'anywhere' }}
                                            >
                                                {target.kind}：{target.id}
                                            </small>
                                        )}
                                    </>
                                );
                            },
                        },
                        { title: 'IP 地址', dataIndex: 'ip', render: (value) => value || '—' },
                        {
                            title: '详情',
                            render: (_, row) => (
                                <Button type="link" onClick={() => setSelected(row)}>
                                    查看
                                </Button>
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
            <SecurityActivityDetails event={selected} onClose={() => setSelected(undefined)} />
        </>
    );
}
