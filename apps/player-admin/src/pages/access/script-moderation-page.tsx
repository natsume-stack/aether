import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Button, Card, Form, Modal, Select, Space, Table, Tag, message } from 'antd';

import { useAdminEvents } from '../../hooks/use-admin-events';
import { confirmAdminAction } from '../../components/confirm-admin-action';
import { AuthorizationFields, permissionOptions } from './map-authorization-fields';
import { MapSelect } from '../../components/map-select';
import { useAdminRequest } from '../../hooks/use-admin-request';
import { PageToolbar } from '../../components/page-toolbar';
import { playerAdminApi as api } from '../../player-admin-api';
import { dateTime } from '../../player-admin-format';

import type { AuthorizationSettings } from './map-authorization-fields';

type Catalog = Awaited<ReturnType<typeof api.getApiPlayAdminScriptModeration>>;
type AuthorizationValues = AuthorizationSettings & { map:string };
const mapValue = (map:Catalog['maps'][number]) => map.groupId;
const mapGroups = (maps:Catalog['maps']) => {
    const groups = new Map<string, Catalog['maps'][number]>();
    for (const map of maps) {
        const id = map.groupId;
        const previous = groups.get(id);
        if (
            !previous ||
            (map.mapId === map.groupId &&
                (previous.mapId !== previous.groupId || map.mode === 'edit'))
        ) {
            groups.set(id, map);
        }
    }
    return [...groups.values()];
};
const authorizationMap = (catalog:Catalog, id:string) => {
    const binding = catalog.bindings.find((item) => item.keyId === id);
    const member = catalog.maps.find(
        (map) => map.mapId === binding?.mapId || map.groupId === binding?.mapId,
    );
    return member && mapGroups(catalog.maps).find((map) => map.groupId === member.groupId);
};
const authorizationStatus = (catalog:Catalog, key:Catalog['keys'][number]) => {
    if (key.revokedAt) {
        return 'revoked';
    }
    if (new Date(key.expiresAt).getTime() <= Date.now()) {
        return 'expired';
    }
    return catalog.bindings.some((binding) => binding.keyId === key.id) ? 'active' : 'replaced';
};
const statusLabels = {
    active: { label: '授权中', color: 'green' },
    revoked: { label: '已撤销', color: 'red' },
    expired: { label: '已过期', color: 'orange' },
    replaced: { label: '已被替换', color: undefined },
};

/** Owner-only workflow: choose a map group and permissions; script changes retain the group authorization. */
export function ScriptModerationPage() {
    const [catalog, setCatalog] = useState<Catalog>({ keys: [], bindings: [], bans: [], maps: [] });
    const { loading: busy, run: request } = useAdminRequest();
    const [open, setOpen] = useState(false);
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'revoked'>('all');
    const [form] = Form.useForm<AuthorizationValues>();
    const [renewing, setRenewing] = useState<Catalog['keys'][number]>();
    const [renewalForm] = Form.useForm<AuthorizationSettings>();
    const load = async () => setCatalog(await api.getApiPlayAdminScriptModeration());
    const run = (operation?:() => Promise<unknown>) =>
        request(async () => {
            await operation?.();
            await load();
        });
    useEffect(() => {
        void run();
    }, []);
    useAdminEvents(true, (topic) => {
        if (topic === 'map-authorization' || topic === 'resync') {
            void run();
        }
    });
    const create = async () => {
        const values = await form.validateFields();
        const map = mapGroups(catalog.maps).find((m) => mapValue(m) === values.map);
        if (!map) {
            message.warning('请刷新地图列表');
            return;
        }
        await run(async () => {
            await api.postApiPlayAdminScriptModeration({
                body: {
                    action: 'create',
                    values: {
                        mapId: map.groupId,
                        permissions: values.permissions,
                        maximumBanSeconds:
                            values.banLimit === 'permanent' ? 0 : values.minutes * 60,
                        expiresAt: new Date(Date.now() + values.days * 86400000).toISOString(),
                    },
                },
            });
            setOpen(false);
            form.resetFields();
        });
    };
    const update = (key:Catalog['keys'][number]) => {
        const map = authorizationMap(catalog, key.id);
        if (!map) {
            message.info('请刷新地图列表');
            return;
        }
        renewalForm.setFieldsValue({
            permissions: (key.permissions || []) as AuthorizationValues['permissions'],
            days: 7,
            minutes: key.maximumBanSeconds ? key.maximumBanSeconds / 60 : 60,
            banLimit: key.maximumBanSeconds === 0 ? 'permanent' : 'limited',
        });
        setRenewing(key);
    };
    const renew = async () => {
        if (!renewing) {
            return;
        }
        const { days, minutes, banLimit, permissions } = await renewalForm.validateFields();
        const map = authorizationMap(catalog, renewing.id);
        if (!map) {
            message.info('请刷新地图列表');
            return;
        }
        await run(async () => {
            await api.postApiPlayAdminScriptModeration({
                body: {
                    action: 'update',
                    values: {
                        keyId: renewing.id,
                        mapId: map.groupId,
                        days,
                        maximumBanSeconds: banLimit === 'permanent' ? 0 : minutes * 60,
                        permissions,
                    },
                },
            });
            setRenewing(undefined);
        });
    };

    return (
        <>
            <PageToolbar title="地图授权">
                <Space>
                    <Button icon={<ReloadOutlined />} loading={busy} onClick={() => void run()}>
                        刷新
                    </Button>
                    <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        disabled={busy}
                        onClick={() => setOpen(true)}
                    >
                        创建授权
                    </Button>
                </Space>
            </PageToolbar>
            <Card
                className="player-admin-panel"
                title="授权列表"
                extra={
                    <Select
                        aria-label="筛选授权状态"
                        value={statusFilter}
                        onChange={setStatusFilter}
                        style={{ width: 130 }}
                        options={[
                            { value: 'all', label: '全部状态' },
                            { value: 'active', label: statusLabels.active.label },
                            { value: 'revoked', label: statusLabels.revoked.label },
                        ]}
                    />
                }
            >
                <Table
                    size="middle"
                    rowKey="id"
                    loading={busy}
                    dataSource={catalog.keys.filter(
                        (key) =>
                            statusFilter === 'all' ||
                            authorizationStatus(catalog, key) === statusFilter,
                    )}
                    pagination={{ pageSize: 10 }}
                    columns={[
                        {
                            title: '授权地图组',
                            render: (_, key) => authorizationMap(catalog, key.id)?.name || key.name,
                        },
                        {
                            title: '地图 ID',
                            render: (_, key) => {
                                const binding = catalog.bindings.find((b) => b.keyId === key.id);
                                const map = authorizationMap(catalog, key.id);
                                return <code>{map?.groupId || binding?.mapId || '已被替换'}</code>;
                            },
                        },
                        {
                            title: '权限',
                            render: (_, key) => (
                                <Space wrap>
                                    {key.adminId ? (
                                        <Tag>旧版账号授权</Tag>
                                    ) : (
                                        (key.permissions || []).map((p) => (
                                            <Tag key={p}>
                                                {permissionOptions.find((o) => o.value === p)
                                                    ?.label || p}
                                            </Tag>
                                        ))
                                    )}
                                </Space>
                            ),
                        },
                        {
                            title: '授权状态',
                            width: 110,
                            render: (_, key) => {
                                const status = statusLabels[authorizationStatus(catalog, key)];
                                return <Tag color={status.color}>{status.label}</Tag>;
                            },
                        },
                        {
                            title: '单次封禁上限',
                            render: (_, key) =>
                                key.maximumBanSeconds === 0
                                    ? '永久'
                                    : `${key.maximumBanSeconds / 60} 分钟`,
                        },
                        { title: '有效期至', render: (_, key) => dateTime(key.expiresAt) },
                        {
                            title: '操作',
                            render: (_, key) =>
                                !key.revokedAt && (
                                    <Space>
                                        {!key.adminId && (
                                            <Button
                                                type="link"
                                                disabled={busy}
                                                onClick={() => update(key)}
                                            >
                                                编辑授权 / 续期
                                            </Button>
                                        )}
                                        <Button
                                            type="link"
                                            danger
                                            disabled={busy}
                                            onClick={() =>
                                                confirmAdminAction({
                                                    title: `撤销「${key.name}」？`,
                                                    content: '停止后续调用，不会自动解除已有处罚。',
                                                    onOk: () =>
                                                        run(() =>
                                                            api.postApiPlayAdminScriptModeration({
                                                                body: {
                                                                    action: 'revoke',
                                                                    keyId: key.id,
                                                                },
                                                            }),
                                                        ),
                                                })
                                            }
                                        >
                                            撤销
                                        </Button>
                                    </Space>
                                ),
                        },
                    ]}
                />
            </Card>
            <Modal
                title="创建地图授权"
                centered
                bodyStyle={{ maxHeight: 'calc(100vh - 180px)', overflowY: 'auto' }}
                open={open}
                onCancel={() => {
                    setOpen(false);
                    form.resetFields();
                }}
                onOk={() => void create().catch(() => {})}
                confirmLoading={busy}
                okText="创建授权"
                cancelText="取消"
                width={680}
                destroyOnClose
            >
                <Form
                    form={form}
                    layout="vertical"
                    initialValues={{
                        permissions: ['players.view', 'players.ban'],
                        days: 7,
                        minutes: 60,
                        banLimit: 'limited',
                    }}
                >
                    <Form.Item
                        name="map"
                        label="地图组"
                        rules={[{ required: true, message: '请选择地图组' }]}
                    >
                        <MapSelect
                            placeholder="请选择地图组"
                            maps={mapGroups(catalog.maps).map((map) => ({
                                value: mapValue(map),
                                name: map.name,
                                permanentMapId: map.groupId,
                            }))}
                        />
                    </Form.Item>
                    {!catalog.maps.length && <p>暂无地图组。请先创建或导入地图，再刷新。</p>}
                    <AuthorizationFields />
                </Form>
            </Modal>
            <Modal
                title="编辑地图授权 / 续期"
                width={680}
                centered
                bodyStyle={{ maxHeight: 'calc(100vh - 180px)', overflowY: 'auto' }}
                open={Boolean(renewing)}
                onCancel={() => setRenewing(undefined)}
                onOk={() => void renew().catch(() => {})}
                confirmLoading={busy}
                okText="更新授权"
                cancelText="取消"
                destroyOnClose
            >
                <Form form={renewalForm} layout="vertical">
                    <AuthorizationFields />
                </Form>
            </Modal>
        </>
    );
}
