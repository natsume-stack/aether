import { prepareMapLaunch } from './launch-flow';
import { canUseMapResourceCache } from '../../../shared/server-address';
import { expirePlayerSession, SESSION_EXPIRED_MESSAGE } from '../player/session';

import type { PlayerAccountEventOptions } from '../player/account-events';

export function bindMapEvents({
    state,
    playerInvoke,
    remoteApi,
    selectedServer,
    refreshMapLibrary,
    render,
}:PlayerAccountEventOptions):void {
    document
        .querySelectorAll<HTMLButtonElement>('[data-action="toggle-favorite"]')
        .forEach((node) =>
            node.addEventListener('click', async (event) => {
                event.stopPropagation();
                const server = selectedServer();
                const mapId = node.dataset.mapId || '';
                if (
                    !server ||
                    !mapId ||
                    state.busy ||
                    state.libraryLoading ||
                    !state.libraryEnabled ||
                    state.pendingFavoriteMapIds.includes(mapId)
                ) {
                    return;
                }
                const playerId = state.player?.subjectId || state.player?.username || '';
                const isCurrent = () =>
                    state.selectedId === server.id &&
                    (state.player?.subjectId || state.player?.username || '') === playerId;
                const favorite = !state.favoriteMapIds.includes(mapId);
                state.pendingFavoriteMapIds.push(mapId);
                state.error = '';
                render();
                try {
                    const result = await remoteApi.updateLibrary(server.endpoint, mapId, {
                        favorite,
                    });
                    if (!isCurrent()) {
                        return;
                    }
                    if (result.response.status === 401) {
                        expirePlayerSession(state, server.id);
                        render();
                        return;
                    }
                    if (!result.response.ok) {
                        throw new Error(
                            result.response.status === 401
                                ? '登录状态已过期，请重新登录后收藏地图。'
                                : '收藏未能保存到服务器，请稍后重试。',
                        );
                    }
                    state.favoriteMapIds = favorite
                        ? [...new Set([...state.favoriteMapIds, mapId])]
                        : state.favoriteMapIds.filter((id) => id !== mapId);
                } catch (error) {
                    if (isCurrent()) {
                        state.error = String(error.message).includes('登录状态已过期')
                            ? '登录状态已过期，请重新登录后收藏地图。'
                            : String(error.message).includes('超时')
                              ? '保存收藏超时，请稍后重试。'
                              : '收藏未能保存到服务器，请稍后重试。';
                    }
                } finally {
                    if (isCurrent()) {
                        state.pendingFavoriteMapIds = state.pendingFavoriteMapIds.filter(
                            (id) => id !== mapId,
                        );
                        render();
                    }
                }
            }),
        );
    document.querySelectorAll<HTMLElement>('[data-action="prepare-map"]').forEach((node) =>
        node.addEventListener('click', async () => {
            const server = selectedServer();
            const mapId = node.dataset.mapId || '';
            if (!server || !mapId || state.busy || !state.serverBootstrap?.signingKey) {
                return;
            }
            const accessId = state.worlds.find((world) => world.id === mapId)?.publicId || mapId;
            const playerAtLaunch = state.player;
            const isCurrentLaunch = () =>
                state.selectedId === server.id &&
                state.player === playerAtLaunch &&
                state.authError !== SESSION_EXPIRED_MESSAGE;
            if (state.activeGame?.serverId === server.id && state.activeGame.mapId === accessId) {
                if (await playerInvoke('focus_game', { serverId: server.id, mapId: accessId })) {
                    return;
                }
                state.activeGame = null;
            }
            state.busy = true;
            state.preparingMapId = mapId;
            state.launchStage = '正在连接服务器…';
            state.error = '';
            state.notice = '';
            render();
            let stage = '检查服务器支持信息';
            try {
                const bootstrap = await remoteApi.readBootstrap(server.endpoint);
                if (!isCurrentLaunch()) {
                    return;
                }
                if (!bootstrap.supported || !bootstrap.signingKey) {
                    throw new Error('服务器未提供有效的地图资源签名信息。');
                }
                state.serverBootstrap = bootstrap;
                stage = '验证地图并准备启动授权';
                const { descriptor, launchTicket } = await prepareMapLaunch({
                    server,
                    mapId,
                    bootstrap,
                    remoteApi,
                    onStage: (value) => {
                        if (!isCurrentLaunch()) {
                            return;
                        }
                        stage = value;
                        state.launchStage = value;
                        render();
                    },
                });
                if (!isCurrentLaunch()) {
                    return;
                }
                stage = '检查当前账号的地图进入权限';
                const maps = await remoteApi.getMaps(server.endpoint, { includeCovers: false });
                if (!isCurrentLaunch()) {
                    return;
                }
                if (maps.response.status === 401) {
                    expirePlayerSession(state, server.id);
                    render();
                    return;
                }
                if (
                    !maps.response.ok ||
                    !maps.data?.worlds?.some(
                        (world) => world.id === mapId || world.publicId === mapId,
                    )
                ) {
                    throw new Error('当前账号暂时不能进入这张地图。');
                }
                const mapName =
                    state.worlds.find((world) => world.id === mapId || world.publicId === mapId)
                        ?.name || descriptor.accessId;
                stage = '安全启动地图窗口';
                state.launchStage = '正在打开游戏…';
                render();
                try {
                    await remoteApi.launchMap(
                        server.id,
                        descriptor,
                        bootstrap.signingKey,
                        mapName,
                        launchTicket,
                    );
                    if (!isCurrentLaunch()) {
                        return;
                    }
                } catch (error) {
                    const message =
                        typeof error === 'string' ? error : error?.message || String(error ?? '');
                    throw new Error(
                        message
                            ? `安全启动地图失败：${message}`
                            : '安全启动地图失败（本机命令未返回错误说明）',
                    );
                }
                state.notice = canUseMapResourceCache(server.endpoint)
                    ? `“${mapName}”已验证，游戏将通过本机缓存静态资源…`
                    : `“${mapName}”已验证并启动。当前连接为 HTTP，资源按需在线加载，不启用地图预下载缓存。`;
                if (state.libraryEnabled) {
                    const playerId = state.player?.subjectId || state.player?.username || '';
                    const isCurrent = () =>
                        state.selectedId === server.id &&
                        (state.player?.subjectId || state.player?.username || '') === playerId;
                    // Library synchronization is metadata-only and must not delay opening the game.
                    void remoteApi
                        .updateLibrary(server.endpoint, accessId, { played: true })
                        .then(async (result) => {
                            if (!isCurrent()) {
                                return;
                            }
                            if (result.response.status === 401) {
                                expirePlayerSession(state, server.id);
                                render();
                                return;
                            }
                            if (!result.response.ok) {
                                throw new Error(
                                    '游戏已启动，但最近游玩记录暂未同步，请稍后重新检查。',
                                );
                            }
                            await refreshMapLibrary?.(server);
                            if (isCurrent()) {
                                render();
                            }
                        })
                        .catch(() => {
                            if (!isCurrent()) {
                                return;
                            }
                            state.libraryError =
                                '游戏已启动，但最近游玩记录暂未同步，请稍后重新检查。';
                            render();
                        });
                }
            } catch (error) {
                if (!isCurrentLaunch()) {
                    return;
                }
                const message = typeof error === 'string' ? error : error?.message;
                const details = message || (error == null ? '' : String(error));
                state.error =
                    details && details !== '地图启动准备失败，请稍后重试。'
                        ? details
                        : `${stage}阶段失败（没有收到详细错误信息）。`;
            } finally {
                if (isCurrentLaunch()) {
                    state.busy = false;
                    state.preparingMapId = '';
                    state.launchStage = '';
                    render();
                }
            }
        }),
    );
}
