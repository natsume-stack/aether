import { Button, Dropdown, Tag } from 'antd';

import { PlayerIdentity } from '../../components/player-identity';
import { confirmAdminAction } from '../../components/confirm-admin-action';
import { dateTime } from '../../player-admin-format';

import type { ColumnsType } from 'antd/es/table';
import type { Player } from '../../player-admin-types';

type Options = {
    canDelete:boolean;
    toggleBan:(player:Player) => Promise<void>;
    openBanDialog:(player:Player) => Promise<void>;
    deletePlayer:(player:Player) => Promise<void>;
};

/** The player table's row-level actions and identity presentation. */
export function playerDirectoryColumns(options:Options):ColumnsType<Player> {
    return [
        {
            title: '玩家',
            render: (_, player) => <PlayerIdentity player={player} />,
        },
        {
            title: '账号标识',
            render: (_, player) => (
                <>
                    <div>#{player.userId}</div>
                    <div className="player-admin-muted">
                        {player.boxId ? `神岛 ID：${player.boxId}` : '未绑定神岛 ID'}
                    </div>
                </>
            ),
        },
        {
            title: '最近在线',
            render: (_, player) => (
                <>
                    {dateTime(player.lastSeenAt)}
                    <div className="player-admin-muted">
                        登录 {player.loginCount || 0} 次 · 会话 {player.activeSessionCount || 0}
                    </div>
                </>
            ),
        },
        {
            title: '状态',
            render: (_, player) => (
                <Tag color={player.status === 'banned' ? 'error' : 'success'}>
                    {player.status === 'banned' ? '已封禁' : '正常'}
                </Tag>
            ),
        },
        {
            title: '自动解封时间',
            render: (_, player) =>
                dateTime(player.status === 'banned' ? player.bannedUntil : undefined),
        },
        {
            title: '操作',
            width: 100,
            render: (_, player) => (
                <Dropdown
                    menu={{
                        items: [
                            {
                                key: 'ban',
                                label: player.status === 'banned' ? '解除封禁' : '封禁账号',
                                danger: player.status !== 'banned',
                                onClick: () =>
                                    void (player.status === 'banned'
                                        ? options.toggleBan(player)
                                        : options.openBanDialog(player)),
                            },
                            ...(options.canDelete
                                ? [
                                      {
                                          key: 'delete',
                                          label: '删除身份',
                                          danger: true,
                                          onClick: () =>
                                              confirmAdminAction({
                                                  title: `删除身份 · ${player.displayName || player.username}`,
                                                  content:
                                                      '将永久删除该玩家的资料、角色、处罚记录和全部会话，且无法恢复。',
                                                  okText: '永久删除',
                                                  cancelText: '取消',
                                                  okButtonProps: { danger: true },
                                                  onOk: () => options.deletePlayer(player),
                                              }),
                                      },
                                  ]
                                : []),
                        ],
                    }}
                >
                    <Button type="link" size="small">
                        更多
                    </Button>
                </Dropdown>
            ),
        },
    ];
}
