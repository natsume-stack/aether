import { DeleteOutlined, EditOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import {
    Button,
    Card,
    Dropdown,
    Empty,
    Form,
    message,
    Space,
    Switch,
    Table as AntTable,
    Tag,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { confirmAdminAction } from '../../components/confirm-admin-action';
import { useAdminRequest } from '../../hooks/use-admin-request';
import { reportAdminError } from '../../player-admin-errors';
import { PageToolbar } from '../../components/page-toolbar';
import { playerAdminApi as api } from '../../player-admin-api';
import { dateTime, formatBytes } from '../../player-admin-format';
import { buildPlayMapTableRows, groupPlayMaps } from './play-map-table';
import { PlayMapDialogs } from './play-map-dialogs';

import type {
    PlayBundleReview,
    PlayMap,
    PlayMapResourceStatus,
    PlayMapTableRow,
} from '../../player-admin-types';

export function PlayMapsPage({ canManage }:{ canManage:boolean }) {
    const uploadRef = useRef<HTMLInputElement>(null);
    const [worlds, setWorlds] = useState<PlayMap[]>([]);
    const [statuses, setStatuses] = useState<Record<string, PlayMapResourceStatus>>({});
    const { loading, run } = useAdminRequest();
    const [editing, setEditing] = useState<PlayMap>();
    const [review, setReview] = useState<PlayBundleReview>();
    const [reviewFile, setReviewFile] = useState<File>();
    const [preview, setPreview] = useState<{
        resource:PlayBundleReview['resources'][number];
        content:string;
    }>();
    const [reviewWorldId, setReviewWorldId] = useState('');
    const [reviewCategory, setReviewCategory] = useState('script');
    const [form] = Form.useForm();
    const load = useCallback(
        () =>
            run(async () => {
                const [maps, resourceStatus] = await Promise.all([
                    api.getApiPlayAdminLibrarySection({
                        params: { path: { section: 'worlds' } },
                    }) as Promise<{
                        worlds:PlayMap[];
                    }>,
                    api.getApiPlayAdminLibrarySection({
                        params: { path: { section: 'world-status' } },
                    }) as Promise<{ worlds:PlayMapResourceStatus[] }>,
                ]);
                setWorlds(maps.worlds || []);
                setStatuses(
                    Object.fromEntries(
                        (resourceStatus.worlds || []).map((item) => [item.id, item]),
                    ),
                );
            }),
        [run],
    );
    useEffect(() => {
        void load();
    }, [load]);
    const groups = useMemo(() => groupPlayMaps(worlds), [worlds]);
    const tableRows = useMemo(() => buildPlayMapTableRows(groups, statuses), [groups, statuses]);
    const patchWorld = async (world:PlayMap, values:Record<string, unknown>) => {
        await api.patchApiPlayAdminLibrarySectionId({
            params: { path: { section: 'worlds', id: world.id } },
            body: values,
        });
        await load();
    };
    const saveWorld = async () => {
        if (!editing) {
            return;
        }
        try {
            const values = await form.validateFields();
            await patchWorld(editing, { publicId: String(values.publicId).toLowerCase() });
            setEditing(undefined);
            message.success('地图访问 ID 已保存');
        } catch (error) {
            reportAdminError(error);
        }
    };
    const removeWorld = (world:PlayMap) =>
        confirmAdminAction({
            title: world.mapRole === 'main' ? '删除地图组' : '删除副地图',
            content:
                world.mapRole === 'main'
                    ? '将永久删除这个主地图及其副地图，且无法恢复。'
                    : `将永久删除“${world.name}”，且无法恢复。`,
            okText: '永久删除',
            cancelText: '取消',
            okButtonProps: { danger: true },
            onOk: async () => {
                await api.deleteApiPlayAdminLibrarySectionId({
                    params: { path: { section: 'worlds', id: world.id } },
                    body: {},
                });
                message.success('地图已删除');
                await load();
            },
        });
    const inspectBundle = async (file:File) => {
        return run(async () => {
            const result = (await api.postApiPlayAdminLibraryImport({
                params: { query: { mode: 'preview' } },
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file,
                bodySerializer: (body) => body,
            })) as { review:PlayBundleReview };
            setReview(result.review);
            setReviewFile(file);
            setReviewWorldId(result.review.worlds[0]?.id || '');
            setReviewCategory('script');
            setPreview(undefined);
        });
    };
    const cancelReview = async () => {
        if (review) {
            await api
                .deleteApiPlayAdminLibraryImport({
                    params: { query: { reviewId: review.id } },
                    body: {},
                })
                .catch(() => undefined);
        }
        if (preview?.resource.kind !== 'script' && preview?.content) {
            URL.revokeObjectURL(preview.content);
        }
        setPreview(undefined);
        setReview(undefined);
        setReviewFile(undefined);
        setReviewWorldId('');
    };
    const confirmImport = async () => {
        if (!review) {
            return;
        }
        return run(async () => {
            await api.postApiPlayAdminLibraryImport({
                params: { query: { mode: 'confirm', reviewId: review.id } },
                body: {},
            });
            message.success(`已导入 ${review.mapCount} 张地图`);
            await cancelReview();
            await load();
        });
    };
    const previewResource = async (resource:PlayBundleReview['resources'][number]) => {
        if (!review || !resource.previewable) {
            return;
        }
        try {
            const options = {
                params: {
                    query: { mode: 'resource', reviewId: review.id, resourceId: resource.id },
                },
            } as const;
            if (resource.kind === 'script') {
                const content = await api.getApiPlayAdminLibraryImport({
                    ...options,
                    parseAs: 'text',
                });
                setPreview({ resource, content });
            } else {
                const content = await api.getApiPlayAdminLibraryImport({
                    ...options,
                    parseAs: 'blob',
                });
                setPreview({ resource, content: URL.createObjectURL(content) });
            }
        } catch (error) {
            reportAdminError(error);
        }
    };
    return (
        <>
            <PageToolbar title="游玩地图">
                <Space>
                    <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                    {canManage ? (
                        <Button
                            type="primary"
                            icon={<UploadOutlined />}
                            loading={loading}
                            onClick={() => uploadRef.current?.click()}
                        >
                            导入游玩包
                        </Button>
                    ) : null}
                </Space>
            </PageToolbar>
            <input
                ref={uploadRef}
                hidden
                type="file"
                accept=".boxplay,.tar.gz,.tgz,application/gzip"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = '';
                    if (file) {
                        void inspectBundle(file);
                    }
                }}
            />
            {groups.length ? (
                <Card
                    className="player-admin-panel player-admin-map-directory"
                    title="已导入地图"
                    extra={
                        <span className="player-admin-muted">
                            {groups.length} 个地图组 · {worlds.length} 张地图
                        </span>
                    }
                >
                    <AntTable
                        className="player-admin-map-table"
                        tableLayout="fixed"
                        size="middle"
                        pagination={false}
                        rowKey="key"
                        dataSource={tableRows}
                        expandable={{
                            expandRowByClick: false,
                            rowExpandable: (row) =>
                                row.kind === 'group' && Boolean(row.children?.length),
                        }}
                        columns={[
                            {
                                title: '地图',
                                width: '29%',
                                render: (_, row:PlayMapTableRow) => (
                                    <div className="player-admin-map-name">
                                        <span
                                            className="player-admin-map-title"
                                            title={row.map.name}
                                        >
                                            {row.map.name}
                                        </span>
                                        {row.map.version ? (
                                            <span className="player-admin-map-version">
                                                v{row.map.version.replace(/^v/i, '')}
                                            </span>
                                        ) : null}
                                    </div>
                                ),
                            },
                            {
                                title: '地图 ID',
                                width: '29%',
                                render: (_, row:PlayMapTableRow) => (
                                    <code title={row.map.permanentMapId}>
                                        {row.map.permanentMapId}
                                    </code>
                                ),
                            },
                            {
                                title: '地图与资源',
                                width: '16%',
                                render: (_, row:PlayMapTableRow) =>
                                    row.kind === 'group' ? (
                                        <span className="player-admin-map-summary">
                                            {row.mapCount} 张地图 · {formatBytes(row.resourceBytes)}
                                        </span>
                                    ) : (
                                        '—'
                                    ),
                            },
                            {
                                title: '导入时间',
                                width: '16%',
                                render: (_, row:PlayMapTableRow) =>
                                    dateTime(statuses[row.map.id]?.importedAt),
                            },
                            {
                                title: '状态与操作',
                                width: '10%',
                                render: (_, row:PlayMapTableRow) =>
                                    row.kind === 'submap' ? (
                                        canManage ? (
                                            <Button
                                                type="link"
                                                icon={<EditOutlined />}
                                                onClick={() => {
                                                    setEditing(row.map);
                                                    form.setFieldsValue({
                                                        publicId: row.map.publicId,
                                                    });
                                                }}
                                            >
                                                设置
                                            </Button>
                                        ) : (
                                            '—'
                                        )
                                    ) : (
                                        <Space size={8}>
                                            {canManage ? (
                                                <Switch
                                                    checked={row.map.playEnabled !== false}
                                                    checkedChildren="开放"
                                                    unCheckedChildren="关闭"
                                                    onChange={(playEnabled) =>
                                                        void patchWorld(row.map, { playEnabled })
                                                            .then(() =>
                                                                message.success(
                                                                    playEnabled
                                                                        ? '地图组已开放'
                                                                        : '地图组已关闭',
                                                                ),
                                                            )
                                                            .catch(reportAdminError)
                                                    }
                                                />
                                            ) : (
                                                <Tag
                                                    color={
                                                        row.map.playEnabled !== false
                                                            ? 'success'
                                                            : 'default'
                                                    }
                                                >
                                                    {row.map.playEnabled !== false
                                                        ? '已开放'
                                                        : '已关闭'}
                                                </Tag>
                                            )}{' '}
                                            {canManage ? (
                                                <Dropdown
                                                    menu={{
                                                        items: [
                                                            {
                                                                key: 'settings',
                                                                label: '设置访问 ID',
                                                                icon: <EditOutlined />,
                                                                onClick: () => {
                                                                    setEditing(row.map);
                                                                    form.setFieldsValue({
                                                                        publicId: row.map.publicId,
                                                                    });
                                                                },
                                                            },
                                                            { type: 'divider' },
                                                            {
                                                                key: 'delete',
                                                                label: '删除地图组',
                                                                danger: true,
                                                                icon: <DeleteOutlined />,
                                                                onClick: () => removeWorld(row.map),
                                                            },
                                                        ],
                                                    }}
                                                >
                                                    <Button type="text">更多</Button>
                                                </Dropdown>
                                            ) : null}
                                        </Space>
                                    ),
                            },
                        ]}
                    />
                </Card>
            ) : (
                <Card className="player-admin-panel">
                    <Empty description="暂无游玩地图">
                        {canManage ? (
                            <Button type="primary" onClick={() => uploadRef.current?.click()}>
                                导入游玩包
                            </Button>
                        ) : null}
                    </Empty>
                </Card>
            )}
            <PlayMapDialogs
                editing={editing}
                setEditing={setEditing}
                form={form}
                saveWorld={saveWorld}
                review={review}
                reviewFile={reviewFile}
                reviewWorldId={reviewWorldId}
                setReviewWorldId={setReviewWorldId}
                reviewCategory={reviewCategory}
                setReviewCategory={setReviewCategory}
                preview={preview}
                setPreview={setPreview}
                previewResource={previewResource}
                cancelReview={cancelReview}
                confirmImport={confirmImport}
                loading={loading}
            />
        </>
    );
}
