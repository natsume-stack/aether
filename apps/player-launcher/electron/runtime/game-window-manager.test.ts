import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
    createGameWindowManager,
    isAllowedGamePermission,
    makeGameUrl,
} from './game-window-manager';
import { createSignedPackageFixture } from '../testing/signed-package-fixture';

import type {
    GameSession,
    GameWindow,
    GameWindowManagerOptions,
    GameWindowOptions,
} from './game-window-manager';

test('uses a persistent isolated origin session so the Service Worker cache survives relaunches', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-player-window-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { descriptor } = createSignedPackageFixture(Buffer.from('resource'), {
        mapId: 'map-1',
        releaseVersion: 'v1.0.0',
    });
    let capturedOptions;
    let capturedUrl;
    let loadCount = 0;
    let focusCount = 0;
    let permissionHandlersInstalled = false;
    let cookiesSyncedTo;
    let clearedStorage;
    let closedHandler:(() => void) | undefined;
    const gameSession = {
        cookies: {},
        async clearStorageData(options) {
            clearedStorage = options;
        },
        setPermissionCheckHandler(handler) {
            permissionHandlersInstalled = typeof handler === 'function';
        },
        setPermissionRequestHandler(handler) {
            permissionHandlersInstalled &&= typeof handler === 'function';
        },
    } as unknown as GameSession;
    const sessions:GameWindowManagerOptions['sessions'] = {
        fromPartition(partition, options) {
            assert.match(partition, /^persist:box-player-/);
            assert.equal(options.cache, true);
            return gameSession;
        },
    };
    const window = {
        webContents: {
            setWindowOpenHandler() {},
            on() {},
        },
        setMenuBarVisibility() {},
        on(event, callback) {
            if (event === 'closed') {
                closedHandler = callback;
            }
        },
        async loadURL(url) {
            loadCount += 1;
            capturedUrl = new URL(url);
        },
        focus() {
            focusCount += 1;
        },
        setTitle(value) {
            this.title = value;
        },
        isDestroyed() {
            return false;
        },
        destroy() {
            closedHandler?.();
        },
    };
    const createBrowserWindow = (options:GameWindowOptions):GameWindow => {
        capturedOptions = options;
        return window as unknown as GameWindow;
    };
    const manager = createGameWindowManager({
        createBrowserWindow,
        sessions,
        async syncCookies(_endpoint, targetSession) {
            cookiesSyncedTo = targetSession;
        },
    });

    const launched = await manager.launch({
        server: { id: 'server-1', endpoint: 'https://play.example.com/base', name: 'Play' },
        descriptor,
        launchTicket: 'payload.signature',
        title: 'Town · v1.0.0',
    });
    assert.equal(permissionHandlersInstalled, true);
    assert.equal(cookiesSyncedTo, gameSession);
    assert.equal(capturedOptions.webPreferences.session, gameSession);
    assert.equal(capturedOptions.webPreferences.nodeIntegration, false);
    assert.equal(capturedOptions.webPreferences.contextIsolation, true);
    assert.equal(capturedUrl.pathname, '/base/p/town');
    assert.equal(capturedUrl.searchParams.get('box3ServiceWorkerCache'), '1');
    assert.match(capturedUrl.hash, /box3LaunchTicket=/);
    assert.equal(manager.isActiveFor('server-1'), true);
    assert.deepEqual(manager.playerSessions(), [gameSession]);
    await manager.launch({
        server: { id: 'server-1', endpoint: 'https://play.example.com/base', name: 'Play' },
        descriptor,
        launchTicket: 'new.signature',
        title: 'Town · v1.0.0',
    });
    assert.equal(loadCount, 1, 'returning to the active map must not reload its game session');
    assert.equal(focusCount, 1);
    await assert.rejects(manager.clearResources('server-1'), /请先关闭/);

    await manager.close();
    assert.equal(manager.isActiveFor('server-1'), false);
    assert.deepEqual(manager.playerSessions(), []);
    await manager.clearServerCache('server-1');
    assert.deepEqual(clearedStorage, { storages: ['cookies', 'serviceworkers', 'cachestorage'] });
});

test('grants pointer lock only to the main game page from its server origin', () => {
    const origin = 'https://play.example.com';
    assert.equal(
        isAllowedGamePermission('pointerLock', 'https://play.example.com/p/town', true, origin),
        true,
    );
    assert.equal(
        isAllowedGamePermission('fullscreen', 'https://play.example.com/p/town', true, origin),
        true,
    );
    assert.equal(
        isAllowedGamePermission('pointerLock', 'https://attacker.example/p/town', true, origin),
        false,
    );
    assert.equal(
        isAllowedGamePermission('pointerLock', 'https://play.example.com/iframe', false, origin),
        false,
    );
    assert.equal(
        isAllowedGamePermission('media', 'https://play.example.com/p/town', true, origin),
        false,
    );
    assert.equal(
        isAllowedGamePermission('notifications', 'https://play.example.com/p/town', true, origin),
        false,
    );
});

test('launches non-loopback HTTP servers directly without the Service Worker cache', () => {
    const { descriptor } = createSignedPackageFixture(Buffer.from('resource'), {
        mapId: 'map-1',
        releaseVersion: 'v1.0.0',
    });
    const url = makeGameUrl(
        { id: 'server-http', endpoint: 'http://203.0.113.9:3121/base', name: 'Online Play' },
        descriptor,
        'payload.signature',
    );

    assert.equal(url.toString(), 'http://203.0.113.9:3121/base/p/town?box3DisableResourceCache=1');
    assert.equal(url.searchParams.has('box3ServiceWorkerCache'), false);
    assert.equal(url.hash, '');
});

test('loopback HTTP maps use the signed Service Worker caching flow', () => {
    const { descriptor } = createSignedPackageFixture(Buffer.from('resource'));
    for (const endpoint of [
        'http://127.0.0.1:3121',
        'http://localhost:3121',
        'http://[::1]:3121',
    ]) {
        const url = makeGameUrl(
            { id: 'local', endpoint, name: 'Local' },
            descriptor,
            'payload.signature',
        );
        assert.equal(url.searchParams.get('box3ServiceWorkerCache'), '1');
        assert.equal(url.searchParams.has('box3DisableResourceCache'), false);
        assert.match(url.hash, /box3LaunchTicket=/);
    }
});
