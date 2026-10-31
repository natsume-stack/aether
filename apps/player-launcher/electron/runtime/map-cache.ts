import { BrowserWindow } from 'electron';

import { measureCachedResources } from './cache-measurement';

import type { Session } from 'electron';
import type { CachedMap } from '../../shared/cache-types';

interface CacheInfo {
    cacheId:string;
    cacheName:string;
}
const prefix = 'box-play-static:';

/** Uses Chromium's CacheStorage API so caches stay manageable even offline. */
export async function inspectMapCaches(
    target:Session,
    endpoint:string,
    removeMapId?:string,
    removeAll = false,
):Promise<CachedMap[]> {
    const window = new BrowserWindow({
        show: false,
        webPreferences: {
            session: target,
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    const debuggerClient = window.webContents.debugger;
    try {
        await window.loadURL('about:blank');
        debuggerClient.attach('1.3');
        // CacheStorage requires a frame with the matching storage origin. Fulfill
        // this inspector's blank document locally; never load the server's page.
        debuggerClient.on('message', (_event, method, params) => {
            if (method !== 'Fetch.requestPaused') {
                return;
            }
            void debuggerClient
                .sendCommand('Fetch.fulfillRequest', {
                    requestId: params.requestId,
                    responseCode: 200,
                    responseHeaders: [
                        { name: 'Content-Type', value: 'text/html' },
                        { name: 'Cache-Control', value: 'no-store' },
                    ],
                    body: Buffer.from(
                        '<!doctype html><title>Local cache inspection</title>',
                    ).toString('base64'),
                })
                .catch(() => window.webContents.stop());
        });
        await debuggerClient.sendCommand('Fetch.enable', {
            patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        });
        await window.loadURL(`${new URL(endpoint).origin}/__box_launcher_cache_inspection__`);
        const { caches } = (await debuggerClient.sendCommand('CacheStorage.requestCacheNames', {
            securityOrigin: new URL(endpoint).origin,
        })) as { caches:CacheInfo[] };
        const maps = new Map<string, CachedMap>();
        for (const cache of caches) {
            if (!cache.cacheName.startsWith(prefix)) {
                continue;
            }
            const suffix = cache.cacheName.slice(prefix.length);
            const separator = suffix.indexOf(':');
            if (separator < 1) {
                continue;
            }
            const mapId = suffix.slice(0, separator);
            const version = suffix.slice(separator + 1);
            if (removeMapId || removeAll) {
                if (removeAll || mapId === removeMapId) {
                    await debuggerClient.sendCommand('CacheStorage.deleteCache', {
                        cacheId: cache.cacheId,
                    });
                }
                continue;
            }
            const map = maps.get(mapId) || {
                mapId,
                name: '',
                versions: [],
                bytes: 0,
                resources: 0,
            };
            const measured = (await window.webContents.executeJavaScript(
                `(${measureCachedResources.toString()})(${JSON.stringify(cache.cacheName)})`,
            )) as { bytes:number; resources:number };
            map.bytes += measured.bytes;
            map.resources += measured.resources;
            if (map.resources && map.bytes > 0) {
                map.versions.push(version);
                maps.set(mapId, map);
            }
        }
        return [...maps.values()];
    } finally {
        if (debuggerClient.isAttached()) {
            debuggerClient.detach();
        }
        window.destroy();
    }
}
