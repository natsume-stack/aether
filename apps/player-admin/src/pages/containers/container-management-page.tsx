import { ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Space, Table, Tag, Tooltip, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { confirmAdminAction } from '../../components/confirm-admin-action';
import { useAdminRequest } from '../../hooks/use-admin-request';
import { PageToolbar } from '../../components/page-toolbar';
import { formatBytes } from '../../player-admin-format';
import { playerAdminApi as api } from '../../player-admin-api';

import type {
    ContainerCatalog,
    ContainerMap,
    ContainerRuntimeRow,
    RuntimeStatus,
} from '../../player-admin-types';

type Props = { mode:'play' | 'creator'; canManage:boolean };

const runtimeLabel = (status:RuntimeStatus) => {
    if (status.phase === 'ready') {
        return '运行中';
    }
    if (status.phase === 'loading' || status.phase === 'starting') {
        return '启动中';
    }
    if (status.phase === 'error') {
        return '异常退出';
    }
    return '未就绪';
};

/** Lists only active runtime containers; configuration belongs to a separate page. */
export function ContainerManagementPage({ mode, canManage }:Props) {
    const [catalog, setCatalog] = useState<ContainerCatalog>();
    const { loading, run } = useAdminRequest();
    const isPlay = mode === 'play';
    const load = useCallback(
        () =>
            run(async () => {
                setCatalog(await api.getApiPlayAdminContainers({ params: { query: { mode } } }));
            }),
        [mode, run],
    );
    useEffect(() => void load(), [load]);

    const rows = useMemo<ContainerRuntimeRow[]>(() => {
        const maps = catalog?.maps || [];
        const mainIds = new Set(maps.filter((map) => map.mapRole === 'main').map((map) => map.id));
        const children = new Map<string, ContainerMap[]>();
        maps.filter((map) => map.mapRole === 'submap' && mainIds.has(map.mainProjectId)).forEach(
            (map) => {
                children.set(map.mainProjectId, [...(children.get(map.mainProjectId) || []), map]);
            },
        );
        const roots = maps
            .filter((map) => map.mapRole === 'main')
            .map((map) => ({ ...map, children: children.get(map.id) }));
        return [
            ...roots,
            ...maps.filter((map) => map.mapRole === 'submap' && !mainIds.has(map.mainProjectId)),
        ];
    }, [catalog?.maps]);

    const runAction = (map:ContainerMap, action:'destroy' | 'restart', roomId?:string) =>
        confirmAdminAction({
            title:
                action === 'restart'
                    ? '重启地图运行时'
                    : roomId
                      ? '销毁房间运行时'
                      : '销毁地图运行时',
            content:
                action === 'restart'
                    ? `地图“${map.name}”会先停止再重新启动，当前玩家会断开连接。`
                    : roomId
                      ? `房间“${roomId}”中的玩家会断开连接。`
                      : `地图“${map.name}”当前的运行时会停止，玩家会断开连接。`,
            okText: action === 'restart' ? '确认重启' : '确认销毁',
            cancelText: '取消',
            okButtonProps: action === 'destroy' ? { danger: true } : undefined,
            onOk: async () => {
                await api.postApiPlayAdminContainers({
                    body: { action, mode, projectId: map.id, roomId },
                });
                message.success(action === 'restart' ? '运行时正在重新启动' : '运行时已销毁');
                await load();
            },
        });

    return (
        <>
            <PageToolbar title={isPlay ? '游玩端容器' : '创作端容器'}>
                <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                    刷新
                </Button>
            </PageToolbar>
            <Card className="player-admin-panel" title="已启动地图容器">
                <Table<ContainerRuntimeRow>
                    className="player-admin-map-table player-admin-container-table"
                    loading={loading}
                    rowKey="id"
                    pagination={false}
                    dataSource={rows}
                    expandable={{
                        expandRowByClick: false,
                        rowExpandable: (item) => Boolean(item.children?.length),
                    }}
                    columns={[
                        {
                            title: '地图',
                            width: '30%',
                            render: (_, item) => (
                                <div className="player-admin-map-name">
                                    <span className="player-admin-map-title" title={item.name}>
                                        {item.name}
                                    </span>
                                    {item.version ? (
                                        <span className="player-admin-map-version">
                                            v{item.version.replace(/^v/i, '')}
                                        </span>
                                    ) : null}
                                </div>
                            ),
                        },
                        {
                            title: '地图 ID',
                            dataIndex: 'permanentMapId',
                            render: (value) => <code>{value}</code>,
                        },
                        {
                            title: '运行状态',
                            width: 150,
                            render: (_, item) => (
                                <Tooltip title={item.status.message || undefined}>
                                    <Tag
                                        color={
                                            item.status.phase === 'ready'
                                                ? 'success'
                                                : item.status.phase === 'error'
                                                  ? 'error'
                                                  : 'processing'
                                        }
                                    >
                                        {runtimeLabel(item.status)}
                                    </Tag>
                                </Tooltip>
                            ),
                        },
                        {
                            title: '资源使用 / 上限',
                            render: (_, item) => {
                                const group = (catalog?.resourceGroups || []).find(
                                    (candidate) => candidate.id === item.profile?.resourceGroupId,
                                );
                                const cpu =
                                    group?.cpuMilli ??
                                    item.profile?.cpuMilli ??
                                    catalog?.defaults.cpuMilli ??
                                    4000;
                                const memory =
                                    group?.memoryMb ??
                                    item.profile?.memoryMb ??
                                    catalog?.defaults.memoryMb ??
                                    4096;
                                return (
                                    <span className="player-admin-muted">
                                        CPU{' '}
                                        {item.status.cpuPercent == null
                                            ? '—'
                                            : (item.status.cpuPercent / 100).toFixed(2)}{' '}
                                        / {(cpu / 1000).toFixed(2)} 核 · 内存{' '}
                                        {item.status.memoryBytes == null
                                            ? '—'
                                            : formatBytes(item.status.memoryBytes)}{' '}
                                        / {memory} MB
                                    </span>
                                );
                            },
                        },
                        {
                            title: '房间',
                            width: 70,
                            render: (_, item) => <span>{item.status.rooms?.length || 0}</span>,
                        },
                        {
                            title: '操作',
                            width: 140,
                            render: (_, item) =>
                                canManage ? (
                                    <Space size={4}>
                                        <Button
                                            type="link"
                                            onClick={() => runAction(item, 'restart')}
                                        >
                                            重启
                                        </Button>
                                        <Button
                                            type="link"
                                            danger
                                            onClick={() => runAction(item, 'destroy')}
                                        >
                                            销毁
                                        </Button>
                                    </Space>
                                ) : (
                                    '—'
                                ),
                        },
                    ]}
                />
            </Card>
        </>
    );
}
