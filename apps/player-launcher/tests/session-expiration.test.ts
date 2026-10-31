import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiTransport } from '../electron/network/api-transport';
import { createPlayerApi } from '../src/api/player-api';
import { createInitialState } from '../src/application/state';
import { createLauncherController } from '../src/application/controller';
import { renderMapBrowser } from '../src/features/maps/browser';
import { SESSION_EXPIRED_MESSAGE } from '../src/features/player/session';

import type { RemoteApi } from '../src/types';

const server = { id: 'server', name: '本机', endpoint: 'http://127.0.0.1:3121' };

test('library 401 switches directly to login with a visible expiry message and no old map data', async () => {
    const state = createInitialState();
    Object.assign(state, {
        selectedId: server.id,
        page: 'servers',
        player: { username: 'alice', subjectId: 'alice' },
        serverBootstrap: { supported: true, loginRequired: true },
        worlds: [{ id: 'town', name: '星梦小镇' }],
        favoriteMapIds: ['town'],
        mapSearch: '没有匹配',
        mapFilter: 'favorites',
        playerSettingsOpen: true,
    });
    let renders = 0;
    const controller = createLauncherController({
        state,
        remoteApi: {
            readLibrary: async () => ({ response: { status: 401, ok: false } }),
        } as unknown as RemoteApi,
        invoke: async () => undefined,
        isDesktopLauncher: () => true,
        selectedServer: () => server,
        onLibraryChange: () => renders++,
    });
    await controller.refreshMapLibrary(server);
    assert.equal(state.player, null);
    assert.equal(state.authError, SESSION_EXPIRED_MESSAGE);
    assert.equal(state.loginDraft.username, 'alice');
    assert.equal(state.loginDraft.password, '');
    assert.deepEqual(state.worlds, []);
    assert.deepEqual(state.favoriteMapIds, []);
    assert.equal(state.libraryError, '');
    assert.equal(state.playerSettingsOpen, false);
    const html = renderMapBrowser(state, server, { icon: () => '', escapeHtml: String });
    assert.match(html, /id="player-login-form"/);
    assert.match(html, /role="alert"[^>]*>登录状态已过期，请重新登录。/);
    assert.doesNotMatch(html, /map-filter-tabs|world-card|没有找到匹配/);
    assert.equal(renders, 1);
});

test('a server failure does not expire a valid player session', async () => {
    const state = createInitialState();
    state.selectedId = server.id;
    state.player = { username: 'alice', subjectId: 'alice' };
    const controller = createLauncherController({
        state,
        remoteApi: {
            readLibrary: async () => ({ response: { status: 503, ok: false } }),
        } as unknown as RemoteApi,
        invoke: async () => undefined,
        isDesktopLauncher: () => true,
        selectedServer: () => server,
    });
    await controller.refreshMapLibrary(server);
    assert.equal(state.player.username, 'alice');
    assert.equal(state.authError, '');
    assert.match(state.libraryError, /暂时无法读取/);
});

test('protected API 401 triggers expiry while an incorrect login password does not', async () => {
    let expired = 0;
    const transport = createApiTransport({
        fetchImpl: async () => Response.json({ message: 'unauthorized' }, { status: 401 }),
    });
    const api = createPlayerApi({
        isNative: () => true,
        invoke: async (_command, payload) => transport.request(payload.request),
        onSessionExpired: () => expired++,
    });
    await api.login(
        server.endpoint,
        { loginApiUrl: `${server.endpoint}/api/auth/login` },
        'alice',
        'wrong',
    );
    assert.equal(expired, 0);
    await api.readLibrary(server.endpoint);
    assert.equal(expired, 1);
    await api.updateProfile(server.endpoint, { displayName: 'Alice' });
    assert.equal(expired, 2);
});

test('late unauthorized responses cannot expire a newly started login session', async () => {
    let finish:(response:Response) => void;
    const deferred = new Promise<Response>((resolve) => {
        finish = resolve;
    });
    let expired = 0;
    const transport = createApiTransport({
        fetchImpl: async (url) => {
            if (new URL(String(url)).pathname === '/api/play-library') {
                return deferred;
            }
            return Response.json({ player: { username: 'alice' } });
        },
    });
    const api = createPlayerApi({
        isNative: () => true,
        invoke: async (_command, payload) => transport.request(payload.request),
        onSessionExpired: () => expired++,
    });
    const oldRequest = api.readLibrary(server.endpoint);
    await api.login(
        server.endpoint,
        { loginApiUrl: `${server.endpoint}/api/auth/login` },
        'alice',
        'fixture',
    );
    finish(Response.json({ message: 'unauthorized' }, { status: 401 }));
    await oldRequest;
    assert.equal(expired, 0);
});
