import { app, BrowserWindow, session } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

import { readResourceCache, clearResourceCache } from '../runtime/resource-cache';
import { inspectMapCaches } from '../runtime/map-cache';

const temp =
    process.env.BOX_LAUNCHER_TEST_USER_DATA ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'box-real-cache-'));
app.setPath('userData', temp);
const worker = `self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open('box-play-static:cache-test:v1');await cache.add('/resource');await self.skipWaiting()})()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));`;
const fixture = http.createServer((request, response) => {
    if (request.url === '/worker.js') {
        response.writeHead(200, {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'no-store',
        });
        response.end(worker);
    } else if (request.url === '/resource') {
        response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'public, max-age=3600',
        });
        response.end(Buffer.alloc(128 * 1024, 7));
    } else {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><title>Isolated cache check</title>');
    }
});

app.whenReady()
    .then(async () => {
        await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
        const address = fixture.address();
        if (!address || typeof address === 'string') {
            throw new Error('Fixture did not start');
        }
        const origin = `http://127.0.0.1:${address.port}`;
        const target = session.fromPartition('persist:cache-check', { cache: true });
        const window = new BrowserWindow({
            show: false,
            webPreferences: {
                session: target,
                sandbox: true,
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        await window.loadURL(origin);
        const written = await window.webContents.executeJavaScript(`(async()=>{
    if (!window.isSecureContext || !('serviceWorker' in navigator)) throw new Error('Loopback is not a secure context');
    await navigator.serviceWorker.register('/worker.js');
    await navigator.serviceWorker.ready;
    return (await caches.keys()).includes('box-play-static:cache-test:v1');
  })()`);
        if (!written) {
            throw new Error('Service Worker did not populate CacheStorage');
        }
        const before = await readResourceCache(target);
        if (before.staticBytes < 128 * 1024) {
            throw new Error(
                `CacheStorage measurement missed the resource: ${JSON.stringify(before)}`,
            );
        }
        await window.webContents.executeJavaScript(`(async()=>{
      await caches.open('box-play-static:empty:v1');
      const second=await caches.open('box-play-static:second-map:v2');
      await second.put('/second-resource',new Response(new Uint8Array(64)));
    })()`);
        const maps = await inspectMapCaches(target, origin);
        if (
            maps.length !== 2 ||
            maps.find((map) => map.mapId === 'cache-test')?.bytes !== 128 * 1024 ||
            maps.find((map) => map.mapId === 'second-map')?.bytes !== 64
        ) {
            throw new Error(`Incorrect per-map cache statistics: ${JSON.stringify(maps)}`);
        }
        await window.webContents.executeJavaScript(`(async()=>{
            const cache=await caches.open('box-play-static:large-map:v1');
            const body=new Uint8Array(512*1024);
            for(let index=0;index<256;index++) await cache.put('/large-'+index,new Response(body));
        })()`);
        const measureStarted = performance.now();
        const largeMaps = await inspectMapCaches(target, origin);
        const largeMap = largeMaps.find((map) => map.mapId === 'large-map');
        if (largeMap?.bytes !== 128 * 1024 * 1024 || largeMap.resources !== 256) {
            throw new Error(`Large map statistics are incorrect: ${JSON.stringify(largeMap)}`);
        }
        console.log(
            `Large cache inspection (256 resources, 128 MiB): ${Math.round(performance.now() - measureStarted)} ms`,
        );
        await inspectMapCaches(target, origin, 'large-map');
        await target.clearCache();
        const afterBrowser = await readResourceCache(target);
        const mapsAfterBrowser = await inspectMapCaches(target, origin);
        if (afterBrowser.httpBytes !== 0 || mapsAfterBrowser.length !== 2) {
            throw new Error('Browser cache clearing affected map caches');
        }
        await inspectMapCaches(target, origin, 'cache-test');
        const retained = await inspectMapCaches(target, origin);
        if (retained.length !== 1 || retained[0].mapId !== 'second-map') {
            throw new Error('Clearing one map affected other maps');
        }
        await target.cookies.set({ url: origin, name: 'cache-check-account', value: 'fixture' });
        await window.webContents.executeJavaScript(
            "fetch('/resource', { cache: 'reload' }).then(response => response.arrayBuffer()).then(() => true)",
        );
        await inspectMapCaches(target, origin, undefined, true);
        const browserResponseSurvivedMapClear = await window.webContents.executeJavaScript(
            "fetch('/resource', { cache: 'only-if-cached', mode: 'same-origin' }).then(response => response.ok && response.arrayBuffer()).then(body => body instanceof ArrayBuffer && body.byteLength === 128 * 1024).catch(() => false)",
        );
        if ((await inspectMapCaches(target, origin)).length || !browserResponseSurvivedMapClear) {
            throw new Error('Server map clearing affected browser cache');
        }
        await clearResourceCache(target);
        const remaining = await window.webContents.executeJavaScript('caches.keys()');
        const after = await readResourceCache(target);
        if (remaining.length || after.staticBytes !== 0 || after.httpBytes !== 0) {
            throw new Error(
                `Caches remain after clearing: ${JSON.stringify({ remaining, after })}`,
            );
        }
        if (!(await target.cookies.get({ name: 'cache-check-account' })).length) {
            throw new Error('Account cookie was removed');
        }
        console.log(
            JSON.stringify({
                loopbackSecure: true,
                before,
                maps,
                afterBrowser,
                retained,
                after,
                accountRetained: true,
            }),
        );
        window.destroy();
        fixture.close();
        app.exit(0);
    })
    .catch((error) => {
        console.error(error);
        fixture.close();
        app.exit(1);
    });

// Cleanup belongs to the parent runner, after Chromium has released profile files.
process.on('uncaughtException', (error) => {
    console.error(error);
    app.exit(1);
});
