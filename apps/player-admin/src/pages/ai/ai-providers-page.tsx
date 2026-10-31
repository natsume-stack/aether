import { useCallback, useEffect, useState } from 'react';
import {
    Alert,
    Button,
    Card,
    Form,
    Input,
    Modal,
    Popconfirm,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    message,
} from 'antd';

import { playerAdminApi as api } from '../../player-admin-api';

type Provider = {
    id:string;
    name:string;
    protocol:'chat-completions' | 'responses' | 'anthropic-messages';
    baseUrl:string;
    keyHint:string;
    defaultModel:string;
    models:Array<{ id:string }>;
    enabled:boolean;
    isDefault:boolean;
    lastTestStatus:string;
};
type Values = {
    name:string;
    protocol:Provider['protocol'];
    baseUrl:string;
    apiKey?:string;
    defaultModel:string;
    models?:string;
    enabled:boolean;
};

export function AiProvidersPage() {
    const [providers, setProviders] = useState<Provider[]>([]);
    const [busy, setBusy] = useState(false);
    const [policy, setPolicy] = useState({
        enabled: true,
        blockedUsers: [] as string[],
        blockedMaps: [] as string[],
    });
    const [editing, setEditing] = useState<Provider | null | undefined>();
    const [form] = Form.useForm<Values>();
    const load = useCallback(async () => {
        const result = await api.getApiPlayAdminAiProviders();
        setProviders(result.providers);
        setPolicy(await api.getApiPlayAdminAiProvidersControl());
    }, []);
    const run = async (action:() => Promise<void>) => {
        setBusy(true);
        try {
            await action();
        } catch (error) {
            void message.error(error instanceof Error ? error.message : '操作失败');
        } finally {
            setBusy(false);
        }
    };
    useEffect(() => {
        void run(load);
    }, [load]);
    const open = (provider:Provider | null) => {
        form.resetFields();
        form.setFieldsValue(
            provider
                ? { ...provider, models: provider.models.map((m) => m.id).join('\n'), apiKey: '' }
                : { protocol: 'chat-completions', enabled: true },
        );
        setEditing(provider);
    };
    const save = async () => {
        const values = await form.validateFields();
        await run(async () => {
            const body = {
                ...values,
                models: (values.models || '')
                    .split(/[,\n]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
            };
            if (editing) {
                await api.patchApiPlayAdminAiProvidersId({
                    params: { path: { id: editing.id } },
                    body,
                });
            } else {
                await api.postApiPlayAdminAiProviders({ body });
            }
            setEditing(undefined);
            form.resetFields();
            await load();
            void message.success('已保存');
        });
    };
    const action = (provider:Provider, kind:'default' | 'test' | 'models') =>
        run(async () => {
            const params = { path: { id: provider.id } };
            const result:{
                success:boolean;
                result?:{ ok:boolean; message:string; latencyMs:number };
            } =
                kind === 'test'
                    ? await api.postApiPlayAdminAiProvidersIdTest({ params, body: {} })
                    : kind === 'models'
                      ? await api.postApiPlayAdminAiProvidersIdModels({ params, body: {} })
                      : await api.postApiPlayAdminAiProvidersIdDefault({ params, body: {} });
            if (result.result) {
                if (!result.result.ok) {
                    throw new Error(result.result.message);
                }
                void message.success(`连接成功，${result.result.latencyMs}ms`);
            }
            await load();
        });
    return (
        <Card
            title="AI 渠道"
            extra={
                <Space>
                    <Button loading={busy} onClick={() => void run(load)}>
                        刷新
                    </Button>
                    <Button type="primary" disabled={busy} onClick={() => open(null)}>
                        新增渠道
                    </Button>
                </Space>
            }
        >
            <Card size="small" title="AI 自动执行控制" style={{ marginBottom: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Space>
                        允许 AI 自动写入
                        <Switch
                            checked={policy.enabled}
                            disabled={busy}
                            onChange={(enabled) => setPolicy({ ...policy, enabled })}
                        />
                    </Space>
                    <Input.TextArea
                        aria-label="禁止自动执行的用户 ID"
                        placeholder="禁止自动执行的用户 ID，每行一个"
                        value={policy.blockedUsers.join('\n')}
                        onChange={(e) =>
                            setPolicy({
                                ...policy,
                                blockedUsers: e.target.value
                                    .split(/[,\n]/)
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                            })
                        }
                    />
                    <Input.TextArea
                        aria-label="禁止自动执行的地图 ID"
                        placeholder="禁止自动执行的地图 ID，每行一个"
                        value={policy.blockedMaps.join('\n')}
                        onChange={(e) =>
                            setPolicy({
                                ...policy,
                                blockedMaps: e.target.value
                                    .split(/[,\n]/)
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                            })
                        }
                    />
                    <Button
                        disabled={busy}
                        onClick={() =>
                            void run(async () => {
                                await api.patchApiPlayAdminAiProvidersControl({ body: policy });
                                await load();
                                void message.success('执行控制已保存');
                            })
                        }
                    >
                        保存执行控制
                    </Button>
                </Space>
            </Card>
            <Alert
                type="info"
                showIcon
                message="默认渠道供用户在未配置个人渠道时使用；密钥只保存在服务端，编辑时留空保留原密钥。"
                style={{ marginBottom: 16 }}
            />
            <Table
                rowKey="id"
                loading={busy}
                dataSource={providers}
                scroll={{ x: 1000 }}
                columns={[
                    {
                        title: '渠道',
                        dataIndex: 'name',
                        render: (name, p) => (
                            <Space>
                                {name}
                                {p.isDefault && <Tag color="blue">默认</Tag>}
                                {!p.enabled && <Tag>已停用</Tag>}
                            </Space>
                        ),
                    },
                    { title: '协议', dataIndex: 'protocol' },
                    { title: '地址', dataIndex: 'baseUrl' },
                    { title: '模型', dataIndex: 'defaultModel' },
                    { title: '密钥', dataIndex: 'keyHint' },
                    { title: '最近连接', dataIndex: 'lastTestStatus' },
                    {
                        title: '操作',
                        render: (_, p) => (
                            <Space wrap>
                                <Button size="small" disabled={busy} onClick={() => open(p)}>
                                    编辑
                                </Button>
                                <Button
                                    size="small"
                                    disabled={busy || !p.enabled || p.isDefault}
                                    onClick={() => void action(p, 'default')}
                                >
                                    设为默认
                                </Button>
                                <Button
                                    size="small"
                                    disabled={busy}
                                    onClick={() => void action(p, 'test')}
                                >
                                    测试连接
                                </Button>
                                <Button
                                    size="small"
                                    disabled={busy}
                                    onClick={() => void action(p, 'models')}
                                >
                                    拉取模型
                                </Button>
                                <Popconfirm
                                    title="删除此渠道？引用它的偏好将失效。"
                                    onConfirm={() =>
                                        run(async () => {
                                            await api.deleteApiPlayAdminAiProvidersId({
                                                params: { path: { id: p.id } },
                                            });
                                            await load();
                                        })
                                    }
                                >
                                    <Button size="small" danger disabled={busy}>
                                        删除
                                    </Button>
                                </Popconfirm>
                            </Space>
                        ),
                    },
                ]}
            />
            <Modal
                title={editing ? '编辑 AI 渠道' : '新增 AI 渠道'}
                open={editing !== undefined}
                confirmLoading={busy}
                onOk={() => void save().catch(() => undefined)}
                onCancel={() => {
                    if (!busy) {
                        setEditing(undefined);
                        form.resetFields();
                    }
                }}
            >
                <Form form={form} layout="vertical" preserve={false}>
                    <Form.Item
                        name="name"
                        label="渠道名称"
                        rules={[{ required: true }, { max: 64 }]}
                    >
                        <Input />
                    </Form.Item>
                    <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
                        <Select
                            options={['chat-completions', 'responses', 'anthropic-messages'].map(
                                (value) => ({ value, label: value }),
                            )}
                        />
                    </Form.Item>
                    <Form.Item
                        name="baseUrl"
                        label="Base URL"
                        rules={[{ required: true }, { type: 'url' }]}
                    >
                        <Input placeholder="https://api.example.com/v1" />
                    </Form.Item>
                    <Form.Item name="apiKey" label="API Key" rules={[{ required: !editing }]}>
                        <Input.Password autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item
                        name="defaultModel"
                        label="默认模型"
                        rules={[{ required: true }, { max: 200 }]}
                    >
                        <Input />
                    </Form.Item>
                    <Form.Item name="models" label="模型列表（每行一个，可手动填写）">
                        <Input.TextArea rows={5} />
                    </Form.Item>
                    <Form.Item name="enabled" label="启用" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                </Form>
            </Modal>
        </Card>
    );
}
