import { Button, Card, Descriptions, Drawer, Table, Tabs } from 'antd';

import { confirmText } from './confirm-text';
import { dateTime } from '../../player-admin-format';

import type { DrawerProps } from 'antd';
import type { Detail, Player } from '../../player-admin-types';

export type DetailController = {
    selected?:Player;
    details?:Detail;
    detailTab:string;
    setDetailTab:(tab:string) => void;
    can:(permission:string) => boolean;
    command:(command:Record<string, unknown>, success:string) => Promise<unknown>;
};

export function PlayerDetailDrawer({
    controller: c,
    ...props
}:{ controller:DetailController } & DrawerProps) {
    const detail = c.details;
    const player = c.selected;
    if (!detail || !player) {
        return (
            <Drawer {...props}>
                <Card loading bordered={false} />
            </Drawer>
        );
    }
    const command = (value:Record<string, unknown>, ok:string) => c.command(value, ok);
    const items = [
        { key: 'profile', label: '账号资料', children: props.children },
        {
            key: 'identity',
            label: '身份档案',
            children: (
                <Descriptions column={1} size="small" bordered>
                    <Descriptions.Item label="身份 ID">{player.subjectId}</Descriptions.Item>
                    <Descriptions.Item label="用户 Key">{player.userKey || '—'}</Descriptions.Item>
                    <Descriptions.Item label="本地账号 ID">
                        {player.userId || '未注册'}
                    </Descriptions.Item>
                    <Descriptions.Item label="登录用户名">
                        {player.username || '未设置'}
                    </Descriptions.Item>
                    <Descriptions.Item label="注册时间">
                        {dateTime(player.registeredAt || player.createdAt)}
                    </Descriptions.Item>
                    <Descriptions.Item label="最后登录">
                        {dateTime(player.lastLoginAt)}
                    </Descriptions.Item>
                    <Descriptions.Item label="最后在线">
                        {dateTime(player.lastSeenAt)}
                    </Descriptions.Item>
                    <Descriptions.Item label="登录 IP">
                        {player.lastLoginIp || '—'}
                    </Descriptions.Item>
                </Descriptions>
            ),
        },
        {
            key: 'password',
            label: '密码重置',
            children: (
                <Card size="small">
                    <p>重置后，该玩家所有设备会立即退出。</p>
                    {c.can('passwords.reset') && !player.guest ? (
                        <Button
                            onClick={() =>
                                confirmText('重置登录密码', '输入 10–128 位新密码', (password) =>
                                    command(
                                        { action: 'reset-password', password },
                                        '密码已重置，所有会话已撤销',
                                    ),
                                )
                            }
                        >
                            重置密码
                        </Button>
                    ) : (
                        <span>当前账号没有重置密码权限。</span>
                    )}
                </Card>
            ),
        },
        {
            key: 'related',
            label: `关联线索 · ${detail.relatedAccounts.length}`,
            children: (
                <Table
                    size="small"
                    rowKey={(row:Detail['relatedAccounts'][number]) =>
                        `${row.subjectId}-${row.sharedIp}`
                    }
                    pagination={false}
                    dataSource={detail.relatedAccounts}
                    columns={[
                        {
                            title: '玩家',
                            render: (_:unknown, row:Detail['relatedAccounts'][number]) =>
                                row.displayName || row.username,
                        },
                        { title: '用户名', dataIndex: 'username' },
                        { title: '共享 IP', dataIndex: 'sharedIp' },
                        { title: '最近在线', dataIndex: 'lastSeenAt', render: dateTime },
                    ]}
                />
            ),
        },
        {
            key: 'history',
            label: `管理记录 · ${detail.adminHistory.length}`,
            children: (
                <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={detail.adminHistory}
                    columns={[
                        { title: '时间', dataIndex: 'createdAt', render: dateTime },
                        { title: '操作', dataIndex: 'action' },
                        {
                            title: '操作者',
                            render: (_:unknown, row:Detail['adminHistory'][number]) =>
                                row.actorDisplayName || row.actor,
                        },
                    ]}
                />
            ),
        },
    ];
    return (
        <Drawer {...props} width={860} className="player-admin-detail">
            <Tabs
                tabPosition="left"
                activeKey={c.detailTab}
                onChange={c.setDetailTab}
                items={items}
            />
        </Drawer>
    );
}
