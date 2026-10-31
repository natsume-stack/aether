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

import type {components} from '@box/apis';
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
    sharedUserIds?:string[];
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
    const [runs,setRuns]=useState<components['schemas']['AiExecutionRun'][]>([]);
    const [busy, setBusy] = useState(false);
    const [policy, setPolicy] = useState({
        enabled: true,
        blockedUsers: [] as string[],
        blockedMaps: [] as string[],
    });
    const [sharing,setSharing]=useState<Provider>();
    const [sharedUsers,setSharedUsers]=useState('');
    const [editing, setEditing] = useState<Provider | null | undefined>();
    const [form] = Form.useForm<Values>();
    const load = useCallback(async () => {
        const result = await api.getApiPlayAdminAiProviders();
        setProviders(result.providers);
        setRuns((await api.getApiPlayAdminAiProvidersRuns()).runs);
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
                columns={[{title:'共享',render:(_,record)=><Button size="small" onClick={()=>{setSharing(record);setSharedUsers((record.sharedUserIds || []).join('\n'));}}>管理共享</Button>},
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
            <Card title="最近 AI 执行记录（最多 100 条）" extra={<Space><Button disabled={busy} onClick={()=>void run(load)}>刷新</Button><Button disabled={busy || !runs.length} onClick={()=>{
                const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),runs},null,2)],{type:'application/json'});
                const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`ai-execution-audit-${new Date().toISOString().slice(0,10)}.json`;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
            }}>导出当前记录</Button></Space>}>
                <p>每用户最多 3 个并发、每分钟 10 次、24 小时 200 次，累计一百万 token。超时任务显示为 interrupted；VOXA 操作记录由已登录编辑器上报。</p>
                <Table rowKey="id" dataSource={runs} size="small" pagination={{pageSize:10}} columns={[
                    {title:'用户',dataIndex:'userId'},{title:'地图 / 模型',dataIndex:'scope'},
                    {title:'模式',dataIndex:'mode'},{title:'状态',dataIndex:'status'},
                    {title:'模型',dataIndex:'model'},
                    {title:'输入 / 输出 token',render:(_,row)=>`${row.inputTokens || 0} / ${row.outputTokens || 0}`},
                    {title:'耗时（ms）',dataIndex:'durationMs'},
                    {title:'开始时间',dataIndex:'startedAt'},
                ]} expandable={{expandedRowRender:row=><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(row.events,null,2)}</pre>}}/>
            </Card>
            <Modal title={`共享渠道：${sharing?.name || ''}`} open={Boolean(sharing)} onCancel={()=>setSharing(undefined)} confirmLoading={busy} onOk={()=>void run(async()=>{
                if(!sharing) return;
                await api.postApiPlayAdminAiProvidersIdSharing({params:{path:{id:sharing.id}},body:{userIds:sharedUsers.split(/[,\s]+/).filter(Boolean)}});
                setSharing(undefined);await load();
            })}>
                <p>填写可使用此渠道的用户 ID，以空格、逗号或换行分隔。共享用户只能使用渠道，无法查看密钥或修改配置。清空列表可撤销共享；平台默认渠道仍面向全体用户。</p>
                <Input.TextArea rows={5} value={sharedUsers} onChange={e=>setSharedUsers(e.target.value)}/>
            </Modal>
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
