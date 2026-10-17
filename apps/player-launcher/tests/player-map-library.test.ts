import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiTransport } from '../electron/network/api-transport';
import { createPlayerApi } from '../src/api/player-api';
import { createLauncherController } from '../src/application/controller';
import { createInitialState } from '../src/application/state';
import { mapLibraryCollections } from '../src/features/maps/library';

import type { RemoteApi } from '../src/types';

test('launcher uses the webpage library API and the current player session for favorites and recent play', async () => {
    const endpoint = 'http://127.0.0.1:3121';
    const libraries = new Map([
        ['alice', [{ mapId: 'town', favorite: true, lastPlayedAt: null as string | null }]],
        ['bob', [{ mapId: 'arena', favorite: true, lastPlayedAt: null as string | null }]],
    ]);
    const transport = createApiTransport({
        fetchImpl: async (url, request) => {
            const path = new URL(String(url)).pathname;
            if (path === '/api/auth/login') {
                const { username } = JSON.parse(String(request.body));
                return Response.json(
                    { player: { username } },
                    {
                        headers: {
                            'set-cookie': `box_local_player_session=${username}; Path=/; HttpOnly`,
                        },
                    },
                );
            }
            assert.equal(path, '/api/play-library');
            const cookie = new Headers(request.headers).get('cookie') || '';
            const username = cookie.match(/box_local_player_session=(\w+)/)?.[1];
            const entries = libraries.get(username);
            if (!entries) {
                return Response.json({ message: 'AUTH_REQUIRED' }, { status: 401 });
            }
            if (request.method === 'PATCH') {
                const changes = JSON.parse(String(request.body));
                assert.ok(
                    ['town', 'arena'].includes(changes.mapId),
                    'use Play public IDs, not cache IDs',
                );
                let entry = entries.find((item) => item.mapId === changes.mapId);
                if (!entry) {
                    entry = { mapId: changes.mapId, favorite: false, lastPlayedAt: null };
                    entries.push(entry);
                }
                if (typeof changes.favorite === 'boolean') {
                    entry.favorite = changes.favorite;
                }
                if (changes.played) {
                    entry.lastPlayedAt = '2026-10-01T02:00:00.000Z';
                }
                return new Response(null, { status: 204 });
            }
            return Response.json({ player: { username }, libraryEnabled: true, entries });
        },
    });
    const api = createPlayerApi({
        isNative: () => true,
        invoke: async (command, payload) => {
            assert.equal(
                command,
                'api_request',
                'library must not use separate local collection IPC',
            );
            return transport.request(payload.request);
        },
    });
    const bootstrap = { loginApiUrl: `${endpoint}/api/auth/login` };
    await api.login(endpoint, bootstrap, 'alice', 'fixture');
    assert.equal((await api.readLibrary(endpoint)).data.entries[0].favorite, true);
    assert.equal(
        (await api.updateLibrary(endpoint, 'town', { favorite: false })).response.status,
        204,
    );
    assert.equal(
        libraries.get('alice')[0].favorite,
        false,
        'the webpage now reads the same updated record',
    );
    libraries.get('alice')[0].favorite = true; // a change made by the webpage
    assert.equal((await api.readLibrary(endpoint)).data.entries[0].favorite, true);
    await api.updateLibrary(endpoint, 'town', { played: true });
    assert.equal(libraries.get('alice')[0].lastPlayedAt, '2026-10-01T02:00:00.000Z');
    await api.login(endpoint, bootstrap, 'bob', 'fixture');
    assert.deepEqual(
        (await api.readLibrary(endpoint)).data.entries.map((entry) => entry.mapId),
        ['arena'],
    );
});

test('recent collections match public IDs, sort by play time and hide maps no longer available', () => {
    const worlds = [
        { id: 'internal-town', publicId: 'town', permanentMapId: 'cache-town', name: '星梦小镇' },
        { id: 'internal-arena', publicId: 'arena', permanentMapId: 'cache-arena', name: '竞技场' },
    ];
    const library = mapLibraryCollections(worlds, [
        { mapId: 'town', favorite: true, lastPlayedAt: '2026-10-01T00:00:00Z' },
        { mapId: 'removed-map', favorite: false, lastPlayedAt: '2026-10-01T03:00:00Z' },
        { mapId: 'arena', favorite: false, lastPlayedAt: '2026-10-01T02:00:00Z' },
    ]);
    assert.deepEqual(library.favoriteMapIds, ['town']);
    assert.deepEqual(
        library.recentWorlds.map((world) => world.publicId),
        ['arena', 'town'],
    );
});

test('a library request from an old account cannot overwrite the newly selected account', async () => {
    const state = createInitialState();
    state.selectedId = 'server';
    state.player = { username: 'alice', subjectId: 'alice' };
    let finish:(result:unknown) => void;
    const pending = new Promise((resolve) => {
        finish = resolve;
    });
    const server = { id: 'server', name: '本机', endpoint: 'http://127.0.0.1:3121' };
    const controller = createLauncherController({
        state,
        remoteApi: { readLibrary: () => pending } as unknown as RemoteApi,
        invoke: async () => {
            throw new Error('No local library IPC allowed');
        },
        isDesktopLauncher: () => true,
        selectedServer: () => server,
    });
    const request = controller.refreshMapLibrary(server);
    state.player = { username: 'bob', subjectId: 'bob' };
    state.favoriteMapIds = ['bob-map'];
    state.libraryLoading = false;
    finish({
        response: { ok: true },
        data: {
            libraryEnabled: true,
            entries: [{ mapId: 'alice-map', favorite: true, lastPlayedAt: null }],
        },
    });
    await request;
    assert.deepEqual(state.favoriteMapIds, ['bob-map']);
    assert.equal(state.libraryLoading, false);
});
