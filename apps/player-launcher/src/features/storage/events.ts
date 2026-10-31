import { cacheClearedMessage } from './copy';

import type { PlayerAccountEventOptions } from '../player/account-events';

type StorageOptions = Pick<PlayerAccountEventOptions, 'state' | 'playerInvoke' | 'render'>;

export async function refreshStorage({ state, playerInvoke, render }:StorageOptions):Promise<void> {
    state.storage = {
        loading: true,
        error: '',
        rows: state.storage?.rows || [],
        selectedServerId: state.storage?.selectedServerId || '',
        confirmServerId: '',
        confirmMapId: '',
        confirmBrowser: false,
    };
    const storage = state.storage;
    render();
    try {
        const results = await Promise.allSettled(
            state.servers.map(async (server) => {
                const row = {
                    serverId: server.id,
                    ...(await playerInvoke('cache_status', { serverId: server.id })),
                };
                if (state.storage === storage) {
                    storage.rows = [
                        ...storage.rows.filter((item) => item.serverId !== server.id),
                        row,
                    ].sort(
                        (left, right) =>
                            state.servers.findIndex((item) => item.id === left.serverId) -
                            state.servers.findIndex((item) => item.id === right.serverId),
                    );
                    render();
                }
            }),
        );
        if (state.storage !== storage) {
            return;
        }
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
            storage.error = failure.reason?.message || '部分服务器的缓存暂时无法统计。';
        }
        if (
            !state.storage.rows.some(
                (row) => row.serverId === state.storage.selectedServerId && row.maps?.length,
            )
        ) {
            state.storage.selectedServerId = '';
        }
    } catch (error) {
        if (state.storage === storage) {
            storage.error = error.message || '暂时无法统计本机缓存。';
        }
    } finally {
        if (state.storage === storage) {
            storage.loading = false;
            render();
        }
    }
}

export function bindStorageEvents(options:StorageOptions):void {
    const { state, playerInvoke, render } = options;
    document.querySelectorAll<HTMLElement>('[data-open-storage-server]').forEach((node) =>
        node.addEventListener('click', () => {
            if (!state.storage) {
                return;
            }
            state.storage.selectedServerId = node.dataset.openStorageServer || '';
            render();
        }),
    );
    document.querySelector('[data-storage-back]')?.addEventListener('click', () => {
        if (state.storage) {
            state.storage.selectedServerId = '';
            state.storage.confirmServerId = '';
            state.storage.confirmMapId = '';
            state.storage.confirmBrowser = false;
        }
        render();
    });
    document.querySelectorAll<HTMLElement>('[data-clear-map-cache]').forEach((node) =>
        node.addEventListener('click', () => {
            if (state.storage && !state.busy) {
                state.storage.confirmMapId = node.dataset.clearMapCache || '';
                state.storage.confirmServerId = '';
            }
            render();
        }),
    );
    document.querySelectorAll<HTMLElement>('[data-clear-cache]').forEach((node) =>
        node.addEventListener('click', () => {
            if (state.storage && !state.busy) {
                state.storage.confirmServerId = node.dataset.clearCache || '';
                state.storage.confirmMapId = '';
            }
            render();
        }),
    );
    document.querySelector('[data-cancel-cache]')?.addEventListener('click', () => {
        if (state.storage) {
            state.storage.confirmServerId = '';
            state.storage.confirmMapId = '';
        }
        render();
    });
    document.querySelectorAll<HTMLElement>('[data-confirm-cache]').forEach((node) =>
        node.addEventListener('click', async () => {
            if (state.busy) {
                return;
            }
            state.busy = true;
            render();
            try {
                await playerInvoke('clear_server_map_cache', {
                    serverId: node.dataset.confirmCache,
                });
                state.notice = cacheClearedMessage();
            } catch (error) {
                state.error = error.message || '清理缓存失败，请稍后重试。';
            } finally {
                state.busy = false;
                await refreshStorage(options);
            }
        }),
    );
    document.querySelectorAll<HTMLElement>('[data-confirm-map-cache]').forEach((node) =>
        node.addEventListener('click', async () => {
            const serverId = state.storage?.selectedServerId;
            if (!serverId || state.busy) {
                return;
            }
            const mapId = node.dataset.confirmMapCache;
            state.busy = true;
            render();
            try {
                await playerInvoke('clear_map_cache', { serverId, mapId });
                state.notice = '这张地图的缓存已清理，下次进入时会重新准备资源。';
            } catch (error) {
                state.error = error.message || '清理地图缓存失败，请稍后重试。';
            } finally {
                state.busy = false;
                await refreshStorage(options);
            }
        }),
    );
    document.querySelector('[data-clear-browser-cache]')?.addEventListener('click', () => {
        if (state.storage && !state.busy) {
            state.storage.confirmBrowser = true;
        }
        render();
    });
    document.querySelector('[data-confirm-browser-cache]')?.addEventListener('click', async () => {
        if (state.busy) {
            return;
        }
        state.busy = true;
        render();
        try {
            await playerInvoke('clear_browser_cache');
            state.notice = '浏览器缓存已清理，地图缓存和账号已保留。';
        } catch (error) {
            state.error = error.message || '清理浏览器缓存失败，请稍后重试。';
        } finally {
            state.busy = false;
            await refreshStorage(options);
        }
    });
}
