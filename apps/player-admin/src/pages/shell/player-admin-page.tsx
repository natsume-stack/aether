// Player-admin application coordinator. Route entry lives in pages/index.tsx.
import { KeyOutlined, LogoutOutlined } from '@ant-design/icons';
import { Button, Card, Form, Layout as AntLayout, message, Space, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { roleHasPlayerAdminPermission, type PlayerAdminRequirement } from '@box/player-policy';
import {
    allowedPlayerAdminViews,
    canOpenPlayerAdminView,
    PLAYER_ADMIN_VIEWS,
    playerAdminFallbackView,
} from '@box/player-policy/navigation';

import { useAdminEvents } from '../../hooks/use-admin-events';
import { useAdminRequest } from '../../hooks/use-admin-request';
import { confirmAdminAction } from '../../components/confirm-admin-action';
import { reportAdminError } from '../../player-admin-errors';
import { playerAdminApi as api } from '../../player-admin-api';
import {
    CreatorDialog,
    type CreatorDialogController,
    type CreatorPageController,
} from '../creator/creator-management';
import { LoginPage } from '../auth/login-page';
import { SelfPasswordDialog } from '../auth/self-password-dialog';
import { AdminAccountDialog, PermissionGroupDialog } from '../access/owner-management-dialogs';
import { BanDialog, type BanDialogController } from '../players/ban-dialog';
import {
    CreatePlayerDialog,
    CreatorPickerDialog,
    PlayerProfileDrawer,
} from '../players/player-profile-dialogs';
import { useOwnerManagement } from '../access/use-owner-management';
import { useSecurityManagement } from '../security/use-security-management';
import { usePlayerDirectory } from '../players/use-player-directory';
import { playerDirectoryColumns } from '../players/player-directory-columns';
import { buildPlayerAdminMenuItems, PlayerAdminNavigationMenu } from './navigation-menu';
import { PlayerAdminContent } from './admin-content';

import type { Actor, Detail, Player, View } from '../../player-admin-types';
import type { DetailController } from '../players/player-detail-drawer';

const Layout = AntLayout;
const viewFromLocation = ():View => {
    if (typeof window === 'undefined') {
        return 'players';
    }
    const value = new URLSearchParams(window.location.search).get('view');
    return PLAYER_ADMIN_VIEWS.includes(value as View) ? (value as View) : 'players';
};
export function PlayerAdminPage() {
    const [actor, setActor] = useState<Actor>();
    const [booting, setBooting] = useState(true);
    const [view, setView] = useState<View>(viewFromLocation);
    const [totals, setTotals] = useState<Record<string, number>>({});
    const [creatorDialog, setCreatorDialog] = useState<{
        player:Player;
        detail?:Detail;
        mode:'creator-access' | 'creator-tokens';
    }>();
    const [issuedCliToken, setIssuedCliToken] = useState<{ token:string }>();
    const [creatorPickerOpen, setCreatorPickerOpen] = useState(false);
    const [creatorCandidates, setCreatorCandidates] = useState<Player[]>([]);
    const [creatorPickerForm] = Form.useForm();
    const [selfPasswordForm] = Form.useForm();
    const [selfPasswordOpen, setSelfPasswordOpen] = useState(false);
    const { loading: selfPasswordSaving, run: savePassword } = useAdminRequest();
    const { loading: overviewLoading, run: requestOverview } = useAdminRequest();
    const owner = useOwnerManagement();
    const security = useSecurityManagement();
    const isOwner = actor?.role === 'owner';
    const can = (permission:string) =>
        Boolean(
            actor &&
                roleHasPlayerAdminPermission(
                    actor.role,
                    permission as PlayerAdminRequirement,
                    actor.permissions,
                ),
        );
    const directory = usePlayerDirectory(view, can('players.export'));
    const allowedViews = useMemo(() => allowedPlayerAdminViews(actor), [actor]);
    const fallbackView = useMemo(() => playerAdminFallbackView(actor), [actor]);
    const navigate = useCallback(
        (next:View) => {
            const destination = allowedViews.includes(next) ? next : fallbackView;
            setView(destination);
            const url = new URL(window.location.href);
            url.searchParams.set('view', destination);
            window.history.pushState(
                { view: destination },
                '',
                `${url.pathname}${url.search}${url.hash}`,
            );
        },
        [allowedViews, fallbackView],
    );
    const loadOverview = useCallback(
        () =>
            requestOverview(async () => {
                const result = await api.getApiPlayAdminPlayersOverview();
                setTotals(result.totals || {});
            }),
        [requestOverview],
    );
    const load = useCallback(async () => {
        if (!actor || !canOpenPlayerAdminView(actor, view)) {
            return;
        }
        if (
            view === 'players' ||
            view === 'online-sessions' ||
            view === 'account-bans' ||
            view === 'creator-access' ||
            view === 'creator-tokens'
        ) {
            return directory.load();
        }
        if (view === 'identity-bans') {
            return security.identityBans.load();
        }
        if (view === 'security') {
            return security.activity.load();
        }
        if (view === 'admins' || view === 'permission-groups') {
            return owner.load();
        }
        if (view === 'overview') {
            return loadOverview();
        }
    }, [
        actor,
        view,
        directory.load,
        security.identityBans.load,
        security.activity.load,
        owner.load,
        loadOverview,
    ]);
    useAdminEvents(Boolean(actor), (topic) => {
        if (topic === 'authorization') {
            void api
                .getApiPlayAdminVerify()
                .then((result) => setActor(result.actor))
                .catch(() => setActor(undefined));
        } else {
            void load();
        }
    });
    useEffect(() => {
        void (async () => {
            setBooting(true);
            try {
                const r = await api.getApiPlayAdminVerify();
                setActor(r.actor);
            } catch {
                setActor(undefined);
            } finally {
                setBooting(false);
            }
        })();
    }, []);
    useEffect(() => {
        if (actor) {
            void load();
        }
    }, [actor, load]);
    useEffect(() => {
        if (actor && !canOpenPlayerAdminView(actor, view)) {
            navigate(fallbackView);
        }
    }, [actor, fallbackView, navigate, view]);
    useEffect(() => {
        const restore = () => setView(viewFromLocation());
        window.addEventListener('popstate', restore);
        return () => window.removeEventListener('popstate', restore);
    }, []);
    const openCreatorDialog = async (player:Player, mode:'creator-access' | 'creator-tokens') => {
        try {
            setCreatorDialog({ player, mode });
            const detail = (await api.getApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: player.subjectId } },
            })) as Detail;
            setCreatorDialog({ player: detail.player, detail, mode });
        } catch (error) {
            setCreatorDialog(undefined);
            reportAdminError(error);
        }
    };
    const openCreatorPicker = async () => {
        try {
            const result = await api.getApiPlayAdminPlayers({
                params: {
                    query: {
                        page: '1',
                        pageSize: '100',
                        identity: 'all',
                        online: 'all',
                        sort: 'displayName',
                    },
                },
            });
            setCreatorCandidates(result.players || []);
            creatorPickerForm.resetFields();
            setCreatorPickerOpen(true);
        } catch (error) {
            reportAdminError(error);
        }
    };
    const selectCreatorCandidate = async () => {
        try {
            const values = await creatorPickerForm.validateFields();
            const player = creatorCandidates.find(
                (candidate) => candidate.subjectId === values.subjectId,
            );
            if (!player) {
                return;
            }
            setCreatorPickerOpen(false);
            await openCreatorDialog(player, 'creator-access');
        } catch (error) {
            reportAdminError(error);
        }
    };
    const updateCreatorDialog = async (changes:{
        creatorAccess:boolean;
        creatorPermissions:string[];
    }) => {
        if (!creatorDialog?.detail) {
            return;
        }
        try {
            const result = (await api.patchApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: creatorDialog.player.subjectId } },
                body: changes,
            })) as { player:Player };
            if (result.player) {
                setCreatorDialog((current) =>
                    current?.detail
                        ? {
                              ...current,
                              player: result.player,
                              detail: { ...current.detail, player: result.player },
                          }
                        : current,
                );
            }
            message.success(changes.creatorAccess ? '创作权限已更新' : '已关闭创作端访问权限');
            await directory.load();
        } catch (error) {
            reportAdminError(error);
        }
    };
    const creatorCommand = async (commandValue:Record<string, unknown>, success:string) => {
        if (!creatorDialog) {
            return;
        }
        try {
            const result = (await api.postApiPlayAdminPlayersSubjectId({
                params: { path: { subjectId: creatorDialog.player.subjectId } },
                body: commandValue,
            })) as { token?:unknown };
            let issuedToken:string | undefined;
            if (commandValue.action === 'create-cli-token') {
                const token = typeof result?.token === 'string' ? result.token : '';
                if (!token) {
                    throw new Error('CLI Token 签发成功，但未收到可展示的 Token');
                }
                issuedToken = token;
            }
            message.success(success);
            if (issuedToken) {
                setIssuedCliToken({ token: issuedToken });
            }
            await openCreatorDialog(creatorDialog.player, creatorDialog.mode);
            await directory.load();
            return result;
        } catch (error) {
            reportAdminError(error);
        }
    };
    const confirmCreatorCommand = (
        title:string,
        commandValue:Record<string, unknown>,
        success:string,
    ) =>
        confirmAdminAction({
            title,
            content: '此操作会立即使该 CLI Token 失效，使用它的 CLI 将无法继续访问创作端。',
            okText: '确认撤销',
            cancelText: '取消',
            okButtonProps: { danger: true },
            onOk: () => creatorCommand(commandValue, success),
        });
    const logout = async () => {
        try {
            await api.postApiPlayAdminLogout({ body: {} });
        } finally {
            setActor(undefined);
        }
    };
    const changeOwnPassword = () =>
        savePassword(async () => {
            const values = await selfPasswordForm.validateFields();
            await api.postApiPlayAdminSelfPassword({
                body: {
                    currentPassword: values.currentPassword,
                    newPassword: values.newPassword,
                },
            });
            selfPasswordForm.resetFields();
            setSelfPasswordOpen(false);
            setActor(undefined);
            message.success('密码已修改，请使用新密码重新登录');
        });

    const columns = playerDirectoryColumns({
        canDelete: can('players.delete'),
        toggleBan: directory.toggleBan,
        openBanDialog: directory.openBanDialog,
        deletePlayer: directory.deletePlayer,
    });
    if (booting) {
        return (
            <main className="player-admin-login">
                <Card loading style={{ width: 420 }} />
            </main>
        );
    }
    if (!actor) {
        return (
            <LoginPage
                onSuccess={(next) => {
                    setActor(next);
                }}
            />
        );
    }
    const detailController:DetailController = {
        selected: directory.selected,
        details: directory.details,
        detailTab: directory.detailTab,
        setDetailTab: directory.setDetailTab,
        can,
        command: directory.command,
    };
    const creatorPageController:CreatorPageController = {
        loading: directory.loading,
        players: directory.players,
        total: directory.total,
        page: directory.page,
        pageSize: directory.pageSize,
        setPage: directory.setPage,
        setPageSize: (size:number) => {
            directory.setPageSize(size);
            directory.setPage(1);
        },
        loadPlayers: directory.load,
        openCreatorDialog,
        openCreatorPicker,
        can,
    };
    const creatorDialogController:CreatorDialogController = {
        state: creatorDialog,
        close: () => setCreatorDialog(undefined),
        issuedCliToken,
        dismissIssuedCliToken: () => setIssuedCliToken(undefined),
        can,
        updateCreator: updateCreatorDialog,
        command: creatorCommand,
        confirmCommand: confirmCreatorCommand,
    };
    const banDialogController:BanDialogController = {
        state: directory.banDialog.state,
        form: directory.banDialog.form,
        close: directory.banDialog.close,
        submit: directory.banDialog.submit,
    };
    const items = buildPlayerAdminMenuItems(actor);
    return (
        <Layout className="player-admin-shell">
            <Layout.Sider width={224} className="player-admin-sider">
                <div className="player-admin-brand">
                    <span className="player-admin-brand-mark">B</span>BOX3 后台管理
                </div>
                <PlayerAdminNavigationMenu
                    theme="dark"
                    mode="inline"
                    selectedKeys={[view]}
                    onClick={({ key }) => navigate(key as View)}
                    items={items}
                />
            </Layout.Sider>
            <Layout>
                <header className="player-admin-header">
                    <Space>
                        <span className="player-admin-actor-name">
                            {actor.username || actor.displayName}
                        </span>
                        {actor.credential === 'account' ? (
                            <Tooltip title="修改密码">
                                <Button
                                    type="text"
                                    icon={<KeyOutlined />}
                                    onClick={() => {
                                        selfPasswordForm.resetFields();
                                        setSelfPasswordOpen(true);
                                    }}
                                />
                            </Tooltip>
                        ) : null}
                        <Tooltip title="退出登录">
                            <Button
                                type="text"
                                icon={<LogoutOutlined />}
                                onClick={() => void logout()}
                            />
                        </Tooltip>
                    </Space>
                </header>
                <Layout.Content className="player-admin-content">
                    <PlayerAdminContent
                        actor={actor}
                        view={view}
                        directory={directory}
                        owner={owner}
                        security={security}
                        creatorPageController={creatorPageController}
                        columns={columns}
                        overviewLoading={overviewLoading}
                        totals={totals}
                        isOwner={isOwner}
                        can={can}
                        load={load}
                        navigate={navigate}
                    />
                </Layout.Content>
            </Layout>
            <SelfPasswordDialog
                form={selfPasswordForm}
                open={selfPasswordOpen}
                saving={selfPasswordSaving}
                close={() => {
                    setSelfPasswordOpen(false);
                    selfPasswordForm.resetFields();
                }}
                submit={() => void changeOwnPassword()}
            />
            <PlayerProfileDrawer
                selected={directory.selected}
                details={directory.details}
                form={directory.editForm}
                controller={detailController}
                close={directory.closeDetails}
                save={() => void directory.savePlayer()}
            />
            <CreatePlayerDialog
                form={directory.createDialog.form}
                open={directory.createDialog.open}
                close={directory.createDialog.close}
                submit={() => void directory.createDialog.submit()}
            />
            <CreatorPickerDialog
                form={creatorPickerForm}
                open={creatorPickerOpen}
                candidates={creatorCandidates}
                close={() => setCreatorPickerOpen(false)}
                submit={() => void selectCreatorCandidate()}
            />
            <AdminAccountDialog
                form={owner.adminDialog.form}
                open={owner.adminDialog.open}
                editing={owner.adminDialog.editing}
                groups={owner.groups}
                close={owner.adminDialog.close}
                submit={() => void owner.adminDialog.save()}
            />
            <PermissionGroupDialog
                form={owner.groupDialog.form}
                open={owner.groupDialog.open}
                editing={owner.groupDialog.editing}
                close={owner.groupDialog.close}
                submit={() => void owner.groupDialog.save()}
            />
            <CreatorDialog controller={creatorDialogController} />
            <BanDialog controller={banDialogController} />
        </Layout>
    );
}
