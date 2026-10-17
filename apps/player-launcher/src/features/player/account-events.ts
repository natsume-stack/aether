import { expirePlayerSession } from './session';

import type { PlayerInvoke, PlayerLauncherState, PlayerServer, RemoteApi } from '../../types';

export interface PlayerAccountEventOptions {
    state:PlayerLauncherState;
    playerInvoke:PlayerInvoke;
    remoteApi:RemoteApi;
    selectedServer:() => PlayerServer | null;
    refreshMapLibrary?:(server:PlayerServer) => Promise<void>;
    render:() => void;
}

export function bindPlayerAccountEvents({
    state,
    playerInvoke,
    remoteApi,
    selectedServer,
    render,
}:PlayerAccountEventOptions):void {
    document.querySelector('[data-action="toggle-player-menu"]')?.addEventListener('click', () => {
        state.playerMenuOpen = !state.playerMenuOpen;
        render();
    });

    document
        .querySelector('[data-action="open-player-settings"]')
        ?.addEventListener('click', () => {
            if (!state.player || state.busy) {
                return;
            }
            state.playerMenuOpen = false;
            state.playerSettingsOpen = true;
            state.playerProfileName = state.player.displayName || state.player.username || '';
            state.playerProfileSkinId = state.player.avatarSkinId || 'explorer';
            state.playerProfileError = '';
            render();
            document.querySelector<HTMLInputElement>('#player-profile-name')?.focus();
            document.querySelector<HTMLInputElement>('#player-profile-name')?.select();
        });

    const closeProfile = () => {
        if (state.busy) {
            return;
        }
        state.playerSettingsOpen = false;
        state.playerProfileError = '';
        render();
    };
    document.querySelectorAll<HTMLElement>('[data-close-player-settings]').forEach((node) => {
        node.addEventListener('click', closeProfile);
    });
    document.querySelector('[data-player-profile-backdrop]')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
            closeProfile();
        }
    });
    document
        .querySelector('.player-profile-dialog')
        ?.addEventListener('keydown', (event:KeyboardEvent) => {
            if (event.key === 'Escape') {
                closeProfile();
            }
        });
    document.querySelectorAll<HTMLElement>('[data-player-skin]').forEach((node) => {
        node.addEventListener('click', () => {
            state.playerProfileSkinId = node.dataset.playerSkin || 'explorer';
            render();
        });
    });
    document.querySelector('#player-profile-name')?.addEventListener('input', (event) => {
        state.playerProfileName = (event.currentTarget as HTMLInputElement).value;
    });
    document.querySelector('#player-profile-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const server = selectedServer();
        const displayName = String(
            new FormData(event.currentTarget as HTMLFormElement).get('displayName') || '',
        ).trim();
        if (!server || !state.player || state.busy) {
            return;
        }
        if (!displayName || [...displayName].length > 32) {
            state.playerProfileError = '显示昵称需要为 1 到 32 个字符。';
            render();
            return;
        }

        state.busy = true;
        state.playerProfileError = '';
        const playerAtStart = state.player;
        let ownedPlayer = playerAtStart;
        render();
        try {
            const result = await remoteApi.updateProfile(server.endpoint, {
                displayName,
                avatarSkinId: state.playerProfileSkinId,
            });
            if (state.selectedId !== server.id || state.player !== playerAtStart) {
                return;
            }
            if (result.response.status === 401) {
                expirePlayerSession(state, server.id);
                return;
            }
            if (!result.response.ok || !result.data?.player) {
                throw new Error(result.error?.message || '保存账号设置失败，请稍后重试。');
            }
            state.player = result.data.player;
            ownedPlayer = state.player;
            state.playerProfileName = state.player.displayName || displayName;
            state.playerProfileSkinId = state.player.avatarSkinId || state.playerProfileSkinId;
            state.playerSettingsOpen = false;
            state.notice = '账号设置已保存。';
        } catch (error) {
            if (state.selectedId !== server.id || state.player !== playerAtStart) {
                return;
            }
            state.playerProfileError = error.message || '保存账号设置失败，请稍后重试。';
        } finally {
            if (state.selectedId === server.id && (state.player === ownedPlayer || !state.player)) {
                state.busy = false;
                render();
            }
        }
    });

    document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
        const server = selectedServer();
        if (!server || state.busy) {
            return;
        }
        state.busy = true;
        render();
        try {
            const result = await remoteApi.logout(server.endpoint, state.serverBootstrap);
            if (!result.response.ok) {
                throw new Error(result.error?.message || '退出登录失败，请稍后重试。');
            }
            state.notice = '已退出当前服务器账号。';
        } catch (error) {
            state.error = error.message || '已清除此设备上的登录状态；服务器暂时无法确认退出。';
        } finally {
            try {
                await playerInvoke('clear_player_session', { serverId: server.id });
            } catch {
                /* Always clear the UI session. */
            }
            state.player = null;
            state.loginDraft = undefined;
            state.worlds = [];
            state.recentWorlds = [];
            state.favoriteMapIds = [];
            state.libraryEnabled = false;
            state.libraryLoading = false;
            state.libraryError = '';
            state.pendingFavoriteMapIds = [];
            state.playerMenuOpen = false;
            state.playerSettingsOpen = false;
            state.playerProfileError = '';
            state.busy = false;
            render();
        }
    });
}
