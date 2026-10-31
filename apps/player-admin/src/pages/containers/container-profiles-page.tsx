import { ReloadOutlined } from '@ant-design/icons';
import {
    Button,
    Card,
    Col,
    Form,
    Input,
    Modal,
    Row,
    Select,
    Space,
    Table,
    Tag,
    message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { confirmAdminAction } from '../../components/confirm-admin-action';
import { MapSelect } from '../../components/map-select';
import { useAdminRequest } from '../../hooks/use-admin-request';
import { PageToolbar } from '../../components/page-toolbar';
import { playerAdminApi as api } from '../../player-admin-api';

import type { ContainerCatalog, ContainerProfile } from '../../player-admin-types';

type Props = { canManage:boolean };

/** Edits map-level capacity rules; active runtimes are listed on their own page. */
export function ContainerProfilesPage({ canManage }:Props) {
    const [catalog, setCatalog] = useState<ContainerCatalog>();
    const { loading, run } = useAdminRequest();
    const [profile, setProfile] = useState<ContainerProfile>();
    const [form] = Form.useForm<ContainerProfile>();
    const configurationScope = Form.useWatch('configurationScope', form) || 'group';

    const load = useCallback(
        () =>
            run(async () => {
                setCatalog(
                    await api.getApiPlayAdminContainers({ params: { query: { mode: 'play' } } }),
                );
            }),
        [run],
    );

    useEffect(() => {
        void load();
    }, [load]);

    const openProfile = (item?:ContainerProfile) => {
        const defaults = catalog?.defaults || {
            playerLimit: 70,
            roomLimit: 64,
            idleTimeoutMs: 900000,
        };
        const next = item || {
            permanentMapId: '',
            mode: 'play' as const,
            ...defaults,
            cpuMilli: null,
            memoryMb: null,
            configurationScope: 'group' as const,
            configurationRootId: '',
        };
        setProfile(next);
        form.setFieldsValue(next);
    };

    const saveProfile = async () => {
        return run(async () => {
            const values = await form.validateFields();
            await api.postApiPlayAdminContainers({ body: values });
            message.success('地图容器配置已保存；新启动的运行时会使用该配置');
            setProfile(undefined);
            await load();
        });
    };

    const removeProfile = (item:ContainerProfile) =>
        confirmAdminAction({
            title: '删除容器配置',
            content: '后续启动将使用全局默认容量和共享 Node 运行时。',
            okText: '删除',
            cancelText: '取消',
            okButtonProps: { danger: true },
            onOk: async () => {
                await api.deleteApiPlayAdminContainersPermanentMapId({
                    params: { path: { permanentMapId: item.permanentMapId } },
                    body: { configurationScope: item.configurationScope },
                });
                message.success('容器配置已删除');
                await load();
            },
        });

    const mapChoices =
        configurationScope === 'group' ? catalog?.availableMaps || [] : catalog?.allMaps || [];

    return (
        <>
            <PageToolbar title="地图容器配置">
                <Space>
                    <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                    {canManage ? (
                        <Button type="primary" onClick={() => openProfile()}>
                            新增配置
                        </Button>
                    ) : null}
                </Space>
            </PageToolbar>
            <Card className="player-admin-panel player-admin-container-profiles">
                <Table<ContainerProfile>
                    loading={loading}
                    rowKey={(item) => `${item.configurationScope}:${item.permanentMapId}`}
                    pagination={false}
                    dataSource={catalog?.profiles || []}
                    columns={[
                        {
                            title: '地图',
                            dataIndex: 'permanentMapId',
                            render: (value) => {
                                const map = (catalog?.allMaps || []).find(
                                    (item) => item.permanentMapId === value,
                                );
                                return (
                                    <div>
                                        <div>{map?.name || '已删除地图'}</div>
                                        <code className="player-admin-muted">{value}</code>
                                    </div>
                                );
                            },
                        },
                        {
                            title: '配置范围',
                            dataIndex: 'configurationScope',
                            render: (value) => (
                                <Tag color={value === 'group' ? 'blue' : 'default'}>
                                    {value === 'group' ? '地图组' : '单个地图'}
                                </Tag>
                            ),
                        },
                        {
                            title: '人数上限',
                            dataIndex: 'playerLimit',
                            render: (value) => `${value} 人`,
                        },
                        {
                            title: '房间上限',
                            dataIndex: 'roomLimit',
                            render: (value) => `${value} 个`,
                        },
                        {
                            title: '空闲回收',
                            dataIndex: 'idleTimeoutMs',
                            render: (value) => `${value} ms`,
                        },
                        {
                            title: '资源组',
                            render: (_, item) => {
                                const group = (catalog?.resourceGroups || []).find(
                                    (candidate) => candidate.id === item.resourceGroupId,
                                );
                                return group ? <Tag color="blue">{group.name}</Tag> : '—';
                            },
                        },
                        {
                            title: '运行方式',
                            render: (_, item) =>
                                item.resourceGroupId || item.cpuMilli || item.memoryMb ? (
                                    <Tag color="blue">独立 Docker 容器</Tag>
                                ) : (
                                    <Tag>共享 Node</Tag>
                                ),
                        },
                        {
                            title: '操作',
                            render: (_, item) =>
                                canManage ? (
                                    <Space size={4}>
                                        <Button type="link" onClick={() => openProfile(item)}>
                                            编辑
                                        </Button>
                                        <Button
                                            type="link"
                                            danger
                                            onClick={() => removeProfile(item)}
                                        >
                                            删除
                                        </Button>
                                    </Space>
                                ) : (
                                    '—'
                                ),
                        },
                    ]}
                />
            </Card>
            <Modal
                title={profile?.permanentMapId ? '地图容量配置' : '新增地图容量配置'}
                open={Boolean(profile)}
                onCancel={() => setProfile(undefined)}
                onOk={() => void saveProfile()}
                okText="保存"
            >
                <Form form={form} layout="vertical">
                    <Row gutter={16}>
                        <Col span={8}>
                            <Form.Item name="configurationScope" label="配置范围">
                                <Select
                                    disabled={Boolean(profile?.permanentMapId)}
                                    options={[
                                        { value: 'group', label: '地图组' },
                                        { value: 'map', label: '单个地图' },
                                    ]}
                                    onChange={() => form.setFieldValue('permanentMapId', undefined)}
                                />
                            </Form.Item>
                        </Col>
                        <Col span={16}>
                            <Form.Item
                                name="permanentMapId"
                                label="地图 ID"
                                rules={[
                                    {
                                        required: true,
                                        message:
                                            configurationScope === 'group'
                                                ? '请选择地图组'
                                                : '请选择地图',
                                    },
                                ]}
                            >
                                <MapSelect
                                    disabled={Boolean(profile?.permanentMapId)}
                                    placeholder={
                                        configurationScope === 'group' ? '选择地图组' : '选择地图'
                                    }
                                    maps={mapChoices.map((item) => ({
                                        value: item.permanentMapId,
                                        name: item.name,
                                        permanentMapId: item.permanentMapId,
                                        suffix:
                                            configurationScope === 'group' &&
                                            (item.memberCount || 1) > 1
                                                ? ` · ${item.memberCount} 张地图`
                                                : '',
                                    }))}
                                />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Row gutter={16}>
                        <Col span={12}>
                            <Form.Item
                                name="playerLimit"
                                label="人数上限"
                                rules={[{ required: true }]}
                            >
                                <Input type="number" min={1} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item
                                name="roomLimit"
                                label="房间上限"
                                rules={[{ required: true }]}
                            >
                                <Input type="number" min={1} />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Form.Item
                        name="idleTimeoutMs"
                        label="无用户时存活时间（ms）"
                        rules={[{ required: true }]}
                    >
                        <Input type="number" min={1000} />
                    </Form.Item>
                    <Form.Item name="resourceGroupId" label="资源组">
                        <Select
                            allowClear
                            placeholder="选择资源组；留空使用共享 Node"
                            options={(catalog?.resourceGroups || []).map((item) => ({
                                value: item.id,
                                label: `${item.name} · ${item.cpuMilli} m · ${item.memoryMb} MB`,
                            }))}
                        />
                    </Form.Item>
                </Form>
            </Modal>
        </>
    );
}
