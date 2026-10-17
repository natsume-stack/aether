import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
    Button,
    Card,
    Checkbox,
    Empty,
    Form,
    Input,
    message,
    Modal as AntModal,
    Select,
    Space,
    Switch,
    Table,
    Tag,
} from 'antd';
import { useState } from 'react';

import { PlayerIdentity } from '../../components/player-identity';
import { adminPaginationDefaults } from '../../components/admin-pagination';
import { PageToolbar } from '../../components/page-toolbar';
import {
    CREATOR_CAPABILITIES,
    CREATOR_CAPABILITY_META,
} from '../../../../game/shared/creator-policy';
import {
    CREATOR_CLI_CAPABILITIES,
    CREATOR_CLI_CAPABILITY_META,
} from '../../../../game/shared/creator-cli-policy';
import { dateTime } from '../../player-admin-format';

import type { Detail, Player } from '../../player-admin-types';

export type CreatorPageController = {
    loading:boolean;
    players:Player[];
    total:number;
    page:number;
    pageSize:number;
    setPage:(page:number) => void;
    setPageSize:(pageSize:number) => void;
    loadPlayers:() => Promise<void>;
    openCreatorDialog:(player:Player, mode:'creator-access' | 'creator-tokens') => Promise<void>;
    openCreatorPicker:() => Promise<void>;
    can:(permission:string) => boolean;
};

type CreatorDialogState = {
    player:Player;
    detail?:Detail;
    mode:'creator-access' | 'creator-tokens';
};

async function copyText(text:string):Promise<boolean> {
    if (!text) {
        return false;
    }

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Clipboard API requires a secure context in most browsers. Try the
        // legacy document command below for local HTTP deployments.
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let copied = false;
    try {
        copied = document.execCommand('copy');
    } catch {
        copied = false;
    } finally {
        document.body.removeChild(textarea);
    }
    return copied;
}

export type CreatorDialogController = {
    state?:CreatorDialogState;
    close:() => void;
    issuedCliToken?:{ token:string };
    dismissIssuedCliToken:() => void;
    can:(permission:string) => boolean;
    updateCreator:(changes:{ creatorAccess:boolean; creatorPermissions:string[] }) => Promise<void>;
    command:(command:Record<string, unknown>, success:string) => Promise<unknown>;
    confirmCommand:(title:string, command:Record<string, unknown>, success:string) => void;
};

export function CreatorManagementPage({
    mode,
    controller: c,
}:{
    mode:'creator-access' | 'creator-tokens';
    controller:CreatorPageController;
}) {
    const [tokenFilter, setTokenFilter] = useState<'all' | 'assigned' | 'unassigned'>('all');
    const hasTokens = (player:Player) => Boolean(player.creatorAccess);
    const creatorPlayers = (c?.players || []).filter((player:Player) => hasTokens(player));
    const rows =
        mode === 'creator-tokens'
            ? creatorPlayers.filter((player:Player) =>
                  tokenFilter === 'all'
                      ? true
                      : tokenFilter === 'assigned'
                        ? (player.activeCreatorTokenCount || 0) > 0
                        : (player.activeCreatorTokenCount || 0) === 0,
              )
            : creatorPlayers;
    const title = mode === 'creator-access' ? '玩家创作权限' : 'CLI Token';
    return (
        <>
            <PageToolbar title={title}>
                <Space>
                    <Button
                        icon={<ReloadOutlined />}
                        loading={c.loading}
                        onClick={() => c?.loadPlayers()}
                    >
                        刷新
                    </Button>
                    {mode === 'creator-access' && c?.can('creator-access.manage') ? (
                        <Button
                            type="primary"
                            icon={<PlusOutlined />}
                            onClick={() => c?.openCreatorPicker()}
                        >
                            新增
                        </Button>
                    ) : null}
                    {mode === 'creator-tokens' ? (
                        <Select
                            value={tokenFilter}
                            onChange={setTokenFilter}
                            style={{ width: 120 }}
                            options={[
                                { value: 'all', label: '全部' },
                                { value: 'assigned', label: '已分配' },
                                { value: 'unassigned', label: '未分配' },
                            ]}
                        />
                    ) : null}
                </Space>
            </PageToolbar>
            <Card className="player-admin-panel">
                <Table
                    loading={c.loading}
                    dataSource={rows}
                    rowKey="subjectId"
                    pagination={{
                        current: c?.page,
                        total: mode === 'creator-tokens' ? rows.length : c?.total,
                        pageSize: c?.pageSize,
                        ...adminPaginationDefaults,
                        onChange: (next) => c?.setPage(next),
                        onShowSizeChange: (_, size) => c?.setPageSize(size),
                    }}
                    onRow={(player:Player) => ({
                        onClick: () => c?.openCreatorDialog(player, mode),
                    })}
                    columns={[
                        {
                            title: '玩家',
                            render: (_:unknown, player:Player) => (
                                <PlayerIdentity player={player} />
                            ),
                        },
                        {
                            title: '创作端访问',
                            render: (_:unknown, player:Player) =>
                                player.creatorAccess ? (
                                    <Tag color="success">已开启</Tag>
                                ) : (
                                    <Tag>未开启</Tag>
                                ),
                        },
                        {
                            title: mode === 'creator-tokens' ? '已授权 Token 数' : '已授予能力',
                            render: (_:unknown, player:Player) =>
                                mode === 'creator-tokens'
                                    ? `${player.activeCreatorTokenCount || 0} 个`
                                    : player.creatorAccess
                                      ? `${player.creatorPermissions?.length || 0} 项`
                                      : '—',
                        },
                        {
                            title: '操作',
                            render: (_:unknown, player:Player) => (
                                <Button
                                    type="link"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        c?.openCreatorDialog(player, mode);
                                    }}
                                >
                                    管理
                                </Button>
                            ),
                        },
                    ]}
                    locale={{
                        emptyText: (
                            <Empty
                                description={
                                    mode === 'creator-tokens'
                                        ? '暂无已开启创作端的玩家'
                                        : '暂无玩家'
                                }
                            />
                        ),
                    }}
                />
            </Card>
        </>
    );
}
export function CreatorDialog({ controller: c }:{ controller:CreatorDialogController }) {
    const state = c?.state;
    const player:Player | undefined = state?.player;
    const detail:Detail | undefined = state?.detail;
    if (!state || !player) {
        return null;
    }
    const isAccess = state.mode === 'creator-access';
    return (
        <AntModal
            title={`${isAccess ? '创作权限' : 'CLI Token'} · ${player.displayName || player.username}`}
            open
            onCancel={c.close}
            footer={null}
            width={620}
            destroyOnClose
        >
            {!detail ? (
                <Card loading bordered={false} />
            ) : isAccess ? (
                <div className="player-admin-creator-access">
                    <div className="player-admin-creator-access-header">
                        <strong>启用创作端</strong>
                        <Switch
                            checked={Boolean(detail.player.creatorAccess)}
                            disabled={!c.can('creator-access.manage') || detail.player.guest}
                            onChange={(enabled) =>
                                c.updateCreator({
                                    creatorAccess: enabled,
                                    creatorPermissions: enabled
                                        ? detail.player.creatorPermissions?.length
                                            ? detail.player.creatorPermissions
                                            : CREATOR_CAPABILITIES.filter(
                                                  (capability) => capability !== 'projects.view',
                                              )
                                        : [],
                                })
                            }
                        />
                    </div>
                    {detail.player.creatorAccess ? (
                        <div className="player-admin-creator-permissions-section">
                            <span>创作能力</span>
                            <Checkbox.Group
                                className="player-admin-creator-permissions"
                                value={detail.player.creatorPermissions || []}
                                disabled={!c.can('creator-access.manage')}
                                options={CREATOR_CAPABILITIES.filter(
                                    (capability) => capability !== 'projects.view',
                                ).map((capability) => ({
                                    value: capability,
                                    label: (
                                        <strong>{CREATOR_CAPABILITY_META[capability].label}</strong>
                                    ),
                                }))}
                                onChange={(values) =>
                                    c.updateCreator({
                                        creatorAccess: true,
                                        creatorPermissions: values as string[],
                                    })
                                }
                            />
                        </div>
                    ) : (
                        <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="尚未授予创作端访问权限"
                        />
                    )}
                </div>
            ) : (
                <CliTokenPanel controller={c} detail={detail} />
            )}
            <AntModal
                title="CLI Token 已签发"
                open={Boolean(c.issuedCliToken)}
                closable={false}
                maskClosable={false}
                footer={
                    <Button type="primary" onClick={c.dismissIssuedCliToken}>
                        我已保存
                    </Button>
                }
            >
                <p>此 Token 仅显示一次，请立即复制并妥善保存。</p>
                <Input.TextArea
                    className="player-admin-issued-token"
                    readOnly
                    value={c.issuedCliToken?.token || ''}
                    autoSize={{ minRows: 3, maxRows: 6 }}
                />
                <Button
                    style={{ marginTop: 12 }}
                    onClick={async () => {
                        const copied = await copyText(c.issuedCliToken?.token || '');
                        if (copied) {
                            message.success('Token 已复制');
                        } else {
                            message.error(
                                '浏览器禁止自动复制，请在上方文本框中手动选择并复制 Token',
                            );
                        }
                    }}
                >
                    复制 Token
                </Button>
            </AntModal>
        </AntModal>
    );
}
function CliTokenPanel({
    controller: c,
    detail,
}:{
    controller:CreatorDialogController;
    detail:Detail;
}) {
    const [editor, setEditor] = useState<{ id?:string; name?:string; scopes?:string[] }>();
    const [form] = Form.useForm();
    const editable = c.can('creator-tokens.manage') && detail.player.creatorAccess;
    const openEditor = (token?:Detail['cliTokens'][number]) => {
        form.setFieldsValue({ name: token?.name || '', scopes: token?.scopes || [] });
        setEditor(token || {});
    };
    const submit = async () => {
        const values = await form.validateFields();
        await c.command(
            editor?.id
                ? { action: 'update-cli-token', tokenId: editor.id, scopes: values.scopes || [] }
                : { action: 'create-cli-token', name: values.name, scopes: values.scopes || [] },
            editor?.id ? 'CLI Token 权限已更新' : 'CLI Token 已签发',
        );
        setEditor(undefined);
    };
    return (
        <>
            <div className="player-admin-token-toolbar">
                <strong>CLI Token</strong>
                {editable ? (
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
                        新增 Token
                    </Button>
                ) : null}
            </div>
            <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={detail.cliTokens.filter((token) => !token.revokedAt)}
                columns={[
                    { title: '名称', dataIndex: 'name' },
                    {
                        title: '权限数',
                        dataIndex: 'scopes',
                        render: (v:string[]) => `${v.length} 项`,
                    },
                    {
                        title: '状态',
                        render: (_:unknown, r:Detail['cliTokens'][number]) =>
                            r.revokedAt ? <Tag>已撤销</Tag> : <Tag color="success">有效</Tag>,
                    },
                    { title: '最近使用', dataIndex: 'lastUsedAt', render: dateTime },
                    {
                        title: '操作',
                        render: (_:unknown, r:Detail['cliTokens'][number]) =>
                            editable && !r.revokedAt ? (
                                <Space>
                                    <Button type="link" onClick={() => openEditor(r)}>
                                        编辑
                                    </Button>
                                    <Button
                                        danger
                                        type="link"
                                        onClick={() =>
                                            c.confirmCommand(
                                                '确定撤销这个 CLI Token？',
                                                { action: 'revoke-cli-token', tokenId: r.id },
                                                'CLI Token 已撤销',
                                            )
                                        }
                                    >
                                        撤销
                                    </Button>
                                </Space>
                            ) : (
                                '—'
                            ),
                    },
                ]}
            />
            <AntModal
                title={editor?.id ? '编辑 CLI Token' : '新增 CLI Token'}
                open={Boolean(editor)}
                onCancel={() => setEditor(undefined)}
                onOk={() => void submit()}
            >
                <Form form={form} layout="vertical">
                    <Form.Item name="name" label="名称" rules={[{ required: true }]}>
                        <Input disabled={Boolean(editor?.id)} />
                    </Form.Item>
                    <Form.Item name="scopes" label="权限">
                        <CliTokenScopes />
                    </Form.Item>
                </Form>
            </AntModal>
        </>
    );
}
function CliTokenScopes({
    value = [],
    onChange,
}:{
    value?:string[];
    onChange?:(value:string[]) => void;
}) {
    const groups = CREATOR_CLI_CAPABILITIES.reduce<
        Record<string, (typeof CREATOR_CLI_CAPABILITIES)[number][]>
    >((result, capability) => {
        const group = CREATOR_CLI_CAPABILITY_META[capability].group;
        (result[group] ||= []).push(capability);
        return result;
    }, {});
    return (
        <div className="player-admin-token-scope-groups">
            {Object.entries(groups).map(([group, capabilities]) => (
                <section key={group}>
                    <strong>{group}</strong>
                    <Checkbox.Group
                        value={value.filter((item) =>
                            capabilities.includes(item as (typeof capabilities)[number]),
                        )}
                        onChange={(next) =>
                            onChange?.([
                                ...value.filter(
                                    (item) =>
                                        !capabilities.includes(
                                            item as (typeof capabilities)[number],
                                        ),
                                ),
                                ...(next as string[]),
                            ])
                        }
                        options={capabilities.map((capability) => ({
                            value: capability,
                            label: CREATOR_CLI_CAPABILITY_META[capability].label,
                        }))}
                    />
                </section>
            ))}
        </div>
    );
}
