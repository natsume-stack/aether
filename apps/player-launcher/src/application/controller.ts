import { normalizeServerAddress } from '../../shared/server-address';
import { mapLibraryCollections } from '../features/maps/library';
import {
    beginServerLoad,
    currentServerLoad,
    expirePlayerSession,
} from '../features/player/session';

import type { PlayerLauncherState, PlayerServer, RemoteApi, PlayerInvoke } from '../types';

interface ControllerOptions {
    state:PlayerLauncherState;
    remoteApi:RemoteApi;
    invoke:PlayerInvoke;
    isDesktopLauncher:() => boolean;
    selectedServer:() => PlayerServer | null;
    onLibraryChange?:() => void;
}

export function createLauncherController({
    state,
    remoteApi,
    invoke,
    isDesktopLauncher,
    selectedServer,
    onLibraryChange,
}:ControllerOptions) {
    const previewServers:PlayerServer[] = [];
    let sessionRequest = 0;
    let libraryRequest = 0;
    let selectionWrites = Promise.resolve();
    async function refreshPlayerSession(
        server:PlayerServer | null = selectedServer(),
    ):Promise<void> {
        if (!server || state.selectedId !== server.id) {
            return;
        }
        const loadCurrent = currentServerLoad(state);
        const request = ++sessionRequest;
        const isCurrent = () => loadCurrent() && request === sessionRequest;
        const bootstrap = state.serverBootstrap;
        const previousPlayer = state.player;
        state.player = null;
        state.worlds = [];
        state.recentWorlds = [];
        state.favoriteMapIds = [];
        state.libraryEnabled = false;
        state.libraryLoading = false;
        state.libraryError = '';
        state.pendingFavoriteMapIds = [];
        state.authError = '';
        state.mapsError = '';
        if (!server || !state.serverBootstrap?.supported) {
            return;
        }
        if (state.serverBootstrap.loginRequired) {
            let result;
            try {
                result = await remoteApi.readSession(server.endpoint, bootstrap);
            } catch (error) {
                if (!isCurrent()) {
                    return;
                }
                state.authError = error.message || '无法连接玩家账号服务。';
                return;
            }
            if (!isCurrent()) {
                return;
            }
            if (!result.response.ok) {
                if (result.response.status === 401) {
                    state.player = previousPlayer;
                    expirePlayerSession(state, server.id);
                    return;
                }
                state.authError = '无法检查当前服务器的登录状态，请稍后重试。';
                return;
            }
            state.player = result.data?.player || null;
            if (!state.player) {
                if (previousPlayer) {
                    state.player = previousPlayer;
                    expirePlayerSession(state, server.id);
                }
                return;
            }
            state.loginDraft = undefined;
        }
        try {
            const { data, response, error: apiError } = await remoteApi.getMaps(server.endpoint);
            if (!isCurrent()) {
                return;
            }
            if (response.status === 401) {
                expirePlayerSession(state, server.id);
                return;
            }
            if (response.status === 403) {
                state.mapsError = '服务器拒绝了地图列表请求，请检查当前账号权限。';
                return;
            }
            if (!response.ok) {
                throw new Error(apiError?.message || `读取可玩地图失败（HTTP ${response.status}）`);
            }
            state.worlds = Array.isArray(data?.worlds) ? data.worlds : [];
            state.mapsError = '';
            void refreshMapLibrary(server);
        } catch (error) {
            if (!isCurrent()) {
                return;
            }
            state.mapsError = error.message || '读取可玩地图失败。';
        }
    }

    async function refreshMapLibrary(server:PlayerServer):Promise<void> {
        if (state.selectedId !== server.id) {
            return;
        }
        const request = ++libraryRequest;
        const loadCurrent = currentServerLoad(state);
        const playerId = state.player?.subjectId || state.player?.username || '';
        const isCurrent = () =>
            loadCurrent() &&
            request === libraryRequest &&
            state.selectedId === server.id &&
            (state.player?.subjectId || state.player?.username || '') === playerId;
        state.libraryLoading = true;
        try {
            const result = await remoteApi.readLibrary(server.endpoint);
            if (!isCurrent()) {
                return;
            }
            if (result.response.status === 401) {
                expirePlayerSession(state, server.id);
                onLibraryChange?.();
                return;
            }
            if (!result.response.ok || !result.data) {
                state.libraryEnabled = false;
                state.libraryError =
                    result.response.status === 404
                        ? '服务器暂未提供收藏和最近游玩，请联系服主更新服务。'
                        : '暂时无法读取收藏和最近游玩，请稍后重新检查。';
                return;
            }
            if (!Array.isArray(result.data.entries)) {
                throw new Error('服务器返回的收藏和最近游玩记录无效。');
            }
            Object.assign(state, mapLibraryCollections(state.worlds, result.data.entries));
            state.libraryEnabled = result.data.libraryEnabled === true;
            state.libraryError = '';
        } catch (error) {
            if (!isCurrent()) {
                return;
            }
            state.libraryEnabled = false;
            state.libraryError = String(error.message).includes('超时')
                ? '同步收藏和最近游玩超时，请稍后重新检查。'
                : '暂时无法读取收藏和最近游玩，请稍后重新检查。';
        } finally {
            if (isCurrent()) {
                state.libraryLoading = false;
                onLibraryChange?.();
            }
        }
    }

    async function playerInvoke(command:string, payload:Record<string, any> = {}):Promise<any> {
        if (command === 'get_server_bootstrap') {
            try {
                return await remoteApi.readBootstrap(String(payload.endpoint || ''));
            } catch (error) {
                throw new Error(
                    error.message || '无法读取服务器启动器支持信息（浏览器预览可能受跨域限制）',
                );
            }
        }
        if (command === 'add_server') {
            const endpoint = normalizeServerAddress(String(payload.endpoint || ''));
            const parsed = new URL(endpoint);
            try {
                await remoteApi.verifyServer(endpoint);
            } catch (error) {
                throw new Error(
                    error.message || '无法连接到游玩端服务器，请检查 IP/域名、端口和网络后重试',
                );
            }
            if (isDesktopLauncher()) {
                return invoke(command, { endpoint });
            }
            const host = parsed.host;
            const server = { id: endpoint.toLowerCase(), endpoint, name: host };
            const index = previewServers.findIndex((item) => item.id === server.id);
            if (index >= 0) {
                previewServers.splice(index, 1);
            }
            previewServers.unshift(server);
            return server;
        }
        if (command === 'clear_player_session' && !isDesktopLauncher()) {
            return undefined;
        }
        if (isDesktopLauncher()) {
            if (command === 'select_server') {
                // Preserve click order on disk even when previous requests are still loading.
                const pending = selectionWrites.then(() => invoke(command, payload));
                selectionWrites = pending.then(
                    () => undefined,
                    () => undefined,
                );
                return pending;
            }
            return invoke(command, payload);
        }
        if (command === 'launcher_state') {
            return { servers: previewServers, selectedServerId: previewServers[0]?.id || null };
        }
        if (command === 'select_server') {
            return { servers: previewServers, selectedServerId: payload.serverId };
        }
        if (command === 'rename_server') {
            const name = String(payload.name || '').trim();
            if (!name) {
                throw new Error('服务器昵称不能为空');
            }
            if ([...name].length > 40) {
                throw new Error('服务器昵称不能超过 40 个字符');
            }
            const server = previewServers.find((item) => item.id === payload.serverId);
            if (!server) {
                throw new Error('这个服务器已不在列表中');
            }
            server.name = name;
            return { ...server };
        }
        if (command === 'remove_server') {
            const index = previewServers.findIndex((server) => server.id === payload.serverId);
            if (index >= 0) {
                previewServers.splice(index, 1);
            }
            return { servers: previewServers, selectedServerId: previewServers[0]?.id || null };
        }
        throw new Error('此操作只能在 BOX3 玩家启动器中执行');
    }

    async function restoreSelectedServer():Promise<void> {
        const server = selectedServer();
        if (!server) {
            return;
        }
        const isCurrent = beginServerLoad(state);
        state.page = 'servers';
        state.serverBootstrap = { loading: true };
        onLibraryChange?.();
        try {
            const bootstrap = await remoteApi.readBootstrap(server.endpoint);
            if (!isCurrent()) {
                return;
            }
            state.serverBootstrap = bootstrap;
            await refreshPlayerSession(server);
        } catch (error) {
            if (isCurrent()) {
                state.serverBootstrap = { error: error.message || '无法读取服务器状态。' };
            }
        } finally {
            if (isCurrent()) {
                onLibraryChange?.();
            }
        }
    }

    return { refreshPlayerSession, refreshMapLibrary, playerInvoke, restoreSelectedServer };
}
