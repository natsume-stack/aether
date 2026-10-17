import { validateDescriptor } from '../security/package-descriptor';

import type { GameWindowManager } from '../runtime/game-window-manager';
import type { ServerStore } from '../storage/server-store';
import type { createMapLabels } from '../storage/map-labels';
import type { ApiTransport, PublicImageTransport, ElectronCommandPayload } from '../types';

export interface PlayerCommandOptions {
    serverStore:ServerStore;
    gameWindowManager:GameWindowManager;
    apiTransport:ApiTransport;
    publicImageTransport:PublicImageTransport;
    mapLabels:ReturnType<typeof createMapLabels>;
    clearWebSessionCookies:(endpoint:string) => Promise<void>;
}

/** Application commands operate on injected desktop resources after IPC sender validation. */
export function createPlayerCommands({
    serverStore,
    gameWindowManager,
    apiTransport,
    publicImageTransport,
    mapLabels,
    clearWebSessionCookies,
}:PlayerCommandOptions) {
    const COMMANDS = new Set<string>([
        'launcher_state',
        'add_server',
        'select_server',
        'remove_server',
        'rename_server',
        'clear_player_session',
        'api_request',
        'fetch_public_image',
        'verify_map_descriptor',
        'launch_map',
        'game_status',
        'focus_game',
        'cache_status',
        'clear_resource_cache',
        'clear_map_cache',
        'clear_server_map_cache',
        'clear_browser_cache',
        'remember_maps',
    ]);

    function validateLaunchTicket(ticket:unknown):ticket is string {
        return (
            typeof ticket === 'string' &&
            ticket.length > 0 &&
            ticket.length <= 2048 &&
            /^[A-Za-z0-9_.-]+$/.test(ticket) &&
            /^[^.]+\.[^.]+$/.test(ticket)
        );
    }

    async function launchMap(payload:ElectronCommandPayload):Promise<void> {
        const serverId = requireString(payload.serverId, '这个服务器已不在列表中');
        const state = serverStore.load();
        if (state.selectedServerId !== serverId) {
            throw new Error('请先选择要启动地图的服务器');
        }
        const server = state.servers.find((item) => item.id === serverId);
        if (!server) {
            throw new Error('这个服务器已不在列表中');
        }
        if (!validateLaunchTicket(payload.launchTicket)) {
            throw new Error('服务器启动授权无效，请重新点击开始游玩。');
        }
        const descriptor = validateDescriptor(
            requireString(payload.descriptor, '地图资源描述符格式无效'),
            requireString(payload.trustedSigningKey, '服务器签名公钥格式无效'),
        );
        const releaseVersion =
            descriptor.releaseVersion.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128) ||
            '未知版本';
        const mapName =
            String(payload.mapName || '')
                .replace(/[\u0000-\u001f\u007f]/g, '')
                .trim()
                .slice(0, 80) || 'BOX3 Player';
        const title = `${mapName} · ${releaseVersion}`;
        await gameWindowManager.launch({
            server,
            descriptor,
            launchTicket: payload.launchTicket,
            title,
        });
    }

    function requireString(value:unknown, message:string):string {
        if (typeof value !== 'string' || !value) {
            throw new Error(message);
        }
        return value;
    }

    async function dispatch(command:string, payload:ElectronCommandPayload = {}):Promise<any> {
        if (!COMMANDS.has(command)) {
            throw new Error('不允许的启动器命令');
        }
        const store = serverStore;
        if (command === 'launcher_state') {
            return store.load();
        }
        if (command === 'game_status') {
            return gameWindowManager.currentGame();
        }
        if (command === 'focus_game') {
            return gameWindowManager.focusCurrent(
                requireString(payload.serverId, '服务器地址无效'),
                requireString(payload.mapId, '地图无效'),
            );
        }
        if (command === 'remember_maps') {
            const server = store.load().servers.find((item) => item.endpoint === payload.endpoint);
            if (server && Array.isArray(payload.maps)) {
                mapLabels.remember(server.id, payload.maps);
            }
            return;
        }
        if (command === 'clear_browser_cache') {
            if (gameWindowManager.currentGame()) {
                throw new Error('请先关闭游戏窗口，再清理浏览器缓存。');
            }
            await Promise.all(
                store
                    .load()
                    .servers.map((server) => gameWindowManager.clearBrowserResources(server.id)),
            );
            return;
        }
        if (
            [
                'cache_status',
                'clear_resource_cache',
                'clear_map_cache',
                'clear_server_map_cache',
            ].includes(command)
        ) {
            const server = store.load().servers.find((item) => item.id === payload.serverId);
            if (!server) {
                throw new Error('这个服务器已不在列表中');
            }
            if (command === 'clear_resource_cache') {
                await gameWindowManager.clearResources(server.id);
            }
            if (command === 'clear_server_map_cache') {
                await gameWindowManager.clearMapResources(server.id, server.endpoint);
            }
            if (command === 'clear_map_cache') {
                await gameWindowManager.clearMapResources(
                    server.id,
                    server.endpoint,
                    requireString(payload.mapId, '地图缓存无效'),
                );
            }
            const usage = await gameWindowManager.cacheStatus(server.id, server.endpoint);
            return {
                ...usage,
                maps: usage.maps.map((map) => ({
                    ...map,
                    name: mapLabels.name(server.id, map.mapId),
                })),
            };
        }
        if (command === 'add_server') {
            return store.add(requireString(payload.endpoint, '请输入有效的游玩端服务器 IP 或域名'));
        }
        if (command === 'select_server') {
            return store.select(requireString(payload.serverId, '这个服务器已不在列表中'));
        }
        if (command === 'rename_server') {
            return store.rename(
                requireString(payload.serverId, '这个服务器已不在列表中'),
                requireString(payload.name, '服务器昵称不能为空'),
            );
        }
        if (command === 'api_request') {
            if (!payload.request) {
                throw new Error('API 请求参数缺失');
            }
            return apiTransport.request(payload.request);
        }
        if (command === 'fetch_public_image') {
            return publicImageTransport.fetch(
                requireString(payload.endpoint, '服务器地址无效'),
                requireString(payload.url, '地图封面地址无效'),
            );
        }
        if (command === 'verify_map_descriptor') {
            return validateDescriptor(
                requireString(payload.descriptor, '地图资源描述符格式无效'),
                requireString(payload.trustedSigningKey, '服务器签名公钥格式无效'),
            );
        }
        if (command === 'clear_player_session') {
            const server = store.load().servers.find((item) => item.id === payload.serverId);
            if (!server) {
                throw new Error('这个服务器已不在列表中');
            }
            apiTransport.clear(server.endpoint);
            await clearWebSessionCookies(server.endpoint);
            return undefined;
        }
        if (command === 'remove_server') {
            const server = store.load().servers.find((item) => item.id === payload.serverId);
            if (!server) {
                throw new Error('这个服务器已不在列表中');
            }
            if (gameWindowManager.isActiveFor(server.id)) {
                await gameWindowManager.close();
            }
            await gameWindowManager.clearServerCache(server.id);
            apiTransport.forget(server.endpoint);
            await clearWebSessionCookies(server.endpoint);
            const next = await store.remove(server.id);
            return next;
        }
        if (command === 'launch_map') {
            return launchMap(payload);
        }
        throw new Error(`Electron 迁移尚未接入 ${command}，请勿用此构建进行地图或账号操作。`);
    }
    return dispatch;
}
