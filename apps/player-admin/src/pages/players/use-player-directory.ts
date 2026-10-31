import { Form, message } from 'antd';
import { useCallback, useState } from 'react';

import { useAdminRequest } from '../../hooks/use-admin-request';
import { reportAdminError } from '../../player-admin-errors';
import { playerAdminApi as api } from '../../player-admin-api';

import type { Detail, Player, View } from '../../player-admin-types';
import type { PlayerBatchAction } from './player-table';

/** Owns player search, profile lifecycle, bulk actions, and account bans. */
export function usePlayerDirectory(view:View, canExport:boolean) {
    const { loading, run } = useAdminRequest();
    const [players, setPlayers] = useState<Player[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(30);
    const [search, setSearch] = useState('');
    const [identity, setIdentity] = useState('all');
    const [selected, setSelected] = useState<Player>();
    const [details, setDetails] = useState<Detail>();
    const [detailTab, setDetailTab] = useState('profile');
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [createOpen, setCreateOpen] = useState(false);
    const [banDialog, setBanDialog] = useState<{ player:Player; detail?:Detail }>();
    const { loading: exporting, run: runExport } = useAdminRequest();
    const [createForm] = Form.useForm();
    const [editForm] = Form.useForm();
    const [banForm] = Form.useForm();

    const load = useCallback(
        () =>
            run(async () => {
                const result = await api.getApiPlayAdminPlayers({
                    params: {
                        query: {
                            search,
                            page: String(page),
                            pageSize: String(pageSize),
                            identity: view === 'account-bans' ? 'banned' : identity,
                            online: view === 'online-sessions' ? 'online' : 'all',
                            sort: 'lastSeen',
                        },
                    },
                });
                setPlayers(result.players || []);
                setTotal(result.total || 0);
            }),
        [run, identity, page, pageSize, search, view],
    );

    const exportPlayers = async () => {
        if (exporting || !canExport) {
            return;
        }
        return runExport(async () => {
            const result = await api.getApiPlayAdminPlayersExportRaw({
                params: { query: { search, identity, online: 'all', sort: 'lastSeen' } },
                cache: 'no-store',
                parseAs: 'blob',
            });
            if (!result.data) {
                throw new Error(result.error?.message || '导出玩家数据失败');
            }
            const file = URL.createObjectURL(result.data);
            const anchor = document.createElement('a');
            anchor.href = file;
            anchor.download = `players-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(file);
            const exported = result.response.headers.get('X-BOX-Exported-Rows') || '0';
            const totalRows = result.response.headers.get('X-BOX-Total-Rows') || exported;
            message.success(`已导出 ${exported} / ${totalRows} 条玩家记录`);
        });
    };

    const openDetails = async (player:Player, tab = 'profile') => {
        return run(async () => {
            setSelected(player);
            setDetails(undefined);
            setDetailTab(tab);
            const result = (await api.getApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: player.subjectId } },
            })) as Detail;
            setSelected(result.player);
            setDetails(result);
            editForm.setFieldsValue({
                displayName: result.player.displayName,
                boxId: result.player.boxId,
                userKey: result.player.userKey,
                adminNote: result.player.adminNote,
                tags: result.player.tags?.join(', '),
            });
        });
    };

    const closeDetails = () => {
        setSelected(undefined);
        setDetails(undefined);
    };

    const savePlayer = async () => {
        if (!selected) {
            return;
        }
        return run(async () => {
            const values = await editForm.validateFields();
            const result = (await api.patchApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: selected.subjectId } },
                body: {
                    ...values,
                    tags: values.tags
                        ? values.tags
                              .split(',')
                              .map((tag:string) => tag.trim())
                              .filter(Boolean)
                        : [],
                },
            })) as { player:Player };
            if (result.player) {
                setSelected(result.player);
                setDetails((current) =>
                    current ? { ...current, player: result.player } : current,
                );
            }
            message.success('玩家资料已保存');
            await load();
        });
    };

    const command = async (commandValue:Record<string, unknown>, success:string) => {
        if (!selected) {
            return;
        }
        return run(async () => {
            await api.postApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: selected.subjectId } },
                body: commandValue,
            });
            message.success(success);
            await openDetails(selected);
            await load();
        });
    };

    const toggleBan = async (player:Player) => {
        return run(async () => {
            const status = player.status === 'banned' ? 'active' : 'banned';
            await api.patchApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: player.subjectId } },
                body: {
                    status,
                    ...(status === 'banned' ? { banReason: '由管理后台执行' } : {}),
                },
            });
            message.success(status === 'banned' ? '账号已封禁' : '账号已解除封禁');
            await load();
        });
    };

    const openBanDialog = async (player:Player) => {
        try {
            banForm.resetFields();
            banForm.setFieldsValue({ targets: ['account'], duration: 'permanent', reason: '' });
            setBanDialog({ player });
            const detail = (await api.getApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: player.subjectId } },
            })) as Detail;
            setBanDialog({ player: detail.player, detail });
        } catch (error) {
            setBanDialog(undefined);
            reportAdminError(error);
        }
    };

    const submitBanDialog = async () => {
        if (!banDialog?.detail) {
            return;
        }
        try {
            const values = await banForm.validateFields();
            const targets = values.targets as string[];
            const bannedUntil =
                values.duration === 'temporary' ? new Date(values.bannedUntil).toISOString() : null;
            if (
                values.duration === 'temporary' &&
                new Date(bannedUntil || '').getTime() <= Date.now()
            ) {
                throw new Error('封禁到期时间必须晚于当前时间');
            }
            if (targets.includes('account')) {
                await api.patchApiPlayAdminPlayersSubjectId({
                    params: { path: { subjectId: banDialog.player.subjectId } },
                    body: { status: 'banned', banReason: values.reason, bannedUntil },
                });
            }
            for (const target of targets) {
                if (!target.startsWith('ip:') && !target.startsWith('device:')) {
                    continue;
                }
                await api.postApiPlayAdminPlayersSubjectId({
                    params: { path: { subjectId: banDialog.player.subjectId } },
                    body: {
                        action: target.startsWith('ip:') ? 'ban-ip' : 'ban-device',
                        value: target.slice(target.indexOf(':') + 1),
                        reason: values.reason,
                        bannedUntil,
                    },
                });
            }
            setBanDialog(undefined);
            message.success('封禁已生效');
            await load();
        } catch (error) {
            reportAdminError(error);
        }
    };

    const deletePlayer = async (player = selected) => {
        if (!player) {
            return;
        }
        return run(async () => {
            await api.deleteApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: player.subjectId } },
            });
            message.success('玩家身份已删除');
            closeDetails();
            await load();
        });
    };

    const batchPlayers = async (action:PlayerBatchAction, subjectIds:string[], tag?:string) => {
        return run(async () => {
            await api.postApiPlayAdminPlayersBatch({
                body: {
                    action,
                    subjectIds,
                    ...(action === 'ban' ? { reason: '由管理后台批量执行' } : {}),
                    ...(['add-tag', 'remove-tag'].includes(action) ? { tag } : {}),
                },
            });
            const notices:Record<PlayerBatchAction, string> = {
                'revoke-sessions': '已发送下线指令',
                'ban': '已批量封禁',
                'unban': '已批量解封',
                'add-tag': '已添加标签',
                'remove-tag': '已移除标签',
            };
            message.success(notices[action]);
            setSelectedIds([]);
            await load();
        });
    };

    const createPlayer = async () => {
        return run(async () => {
            await api.postApiPlayAdminPlayers({ body: await createForm.validateFields() });
            message.success('玩家账号已创建');
            setCreateOpen(false);
            createForm.resetFields();
            await load();
        });
    };

    return {
        loading,
        players,
        total,
        page,
        pageSize,
        search,
        identity,
        selectedIds,
        exporting,
        selected,
        details,
        detailTab,
        load,
        exportPlayers,
        openDetails,
        closeDetails,
        savePlayer,
        command,
        toggleBan,
        openBanDialog,
        deletePlayer,
        batchPlayers,
        setPage,
        setPageSize,
        setSearch,
        setIdentity,
        setSelectedIds,
        setDetailTab,
        createDialog: {
            form: createForm,
            open: createOpen,
            show: () => setCreateOpen(true),
            close: () => setCreateOpen(false),
            submit: createPlayer,
        },
        editForm,
        banDialog: {
            state: banDialog,
            form: banForm,
            close: () => setBanDialog(undefined),
            submit: submitBanDialog,
        },
    };
}
