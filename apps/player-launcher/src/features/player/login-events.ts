import { playerLoginConnectionError, playerLoginErrorMessage } from './auth-errors';
import { expirePlayerSession } from './session';

import type { PlayerAccountEventOptions } from './account-events';

export function bindLoginEvents({
    state,
    remoteApi,
    selectedServer,
    refreshMapLibrary = async () => undefined,
    render,
}:Omit<PlayerAccountEventOptions, 'playerInvoke'>):void {
    const saveDraft = () => {
        const server = selectedServer();
        const username = document.querySelector<HTMLInputElement>('#player-username');
        const password = document.querySelector<HTMLInputElement>('#player-password');
        if (!server || !username || !password) {
            return;
        }
        state.loginDraft = {
            serverId: server.id,
            username: username.value,
            password: password.value,
            passwordVisible:
                state.loginDraft?.serverId === server.id &&
                Boolean(state.loginDraft.passwordVisible),
        };
    };
    document.querySelector('#player-username')?.addEventListener('input', saveDraft);
    document.querySelector('#player-password')?.addEventListener('input', saveDraft);
    document.querySelector('[data-toggle-password]')?.addEventListener('click', () => {
        if (state.busy) {
            return;
        }
        saveDraft();
        if (state.loginDraft) {
            state.loginDraft.passwordVisible = !state.loginDraft.passwordVisible;
        }
        render();
        document.querySelector<HTMLInputElement>('#player-password')?.focus();
    });
    document.querySelector('#player-login-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const username = String(new FormData(form as HTMLFormElement).get('username') || '').trim();
        const password = String(new FormData(form as HTMLFormElement).get('password') || '');
        const server = selectedServer();
        if (!server || state.busy) {
            return;
        }
        state.loginDraft = { serverId: server.id, username, password, passwordVisible: false };
        state.busy = true;
        state.authError = '';
        state.mapsError = '';
        render();
        try {
            let loginResult;
            try {
                loginResult = await remoteApi.login(
                    server.endpoint,
                    state.serverBootstrap,
                    username,
                    password,
                );
            } catch (error) {
                state.authError = playerLoginConnectionError(error);
                return;
            }
            const { data, error: apiError, response } = loginResult;
            if (!response.ok || !data?.player) {
                state.authError = playerLoginErrorMessage(response.status, apiError);
                return;
            }
            state.player = data.player;
            state.playerMenuOpen = false;
            const maps = await remoteApi.getMaps(server.endpoint);
            if (maps.response.status === 401) {
                expirePlayerSession(state, server.id);
                return;
            }
            if (!maps.response.ok) {
                state.mapsError =
                    maps.error?.message || '登录成功，但暂时无法读取可玩地图。请稍后重试。';
                return;
            }
            state.worlds = Array.isArray(maps.data?.worlds) ? maps.data.worlds : [];
            state.mapsError = '';
            void refreshMapLibrary(server);
            state.notice = `已登录到 ${server.name || server.endpoint}。`;
        } catch (error) {
            if (state.player) {
                state.mapsError = error.message || '登录成功，但暂时无法读取可玩地图。请稍后重试。';
            } else {
                state.authError = playerLoginConnectionError(error);
            }
        } finally {
            if (state.player) {
                state.loginDraft = undefined;
            }
            state.busy = false;
            render();
            if (state.authError) {
                document.querySelector<HTMLInputElement>('#player-password')?.focus();
            }
        }
    });
}
