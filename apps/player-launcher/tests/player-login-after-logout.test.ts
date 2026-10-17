import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiTransport } from '../electron/network/api-transport';
import { createPlayerApi } from '../src/api/player-api';
import { playerLoginConnectionError } from '../src/features/player/auth-errors';

test('a player can log in again after logout clears the local session', async () => {
    const endpoint = 'https://play.example.test';
    const loginApiUrl = 'https://accounts.example.test/api/auth/login';
    let loginAttempts = 0;
    const transport = createApiTransport({
        fetchImpl: async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/api/player-launcher/bootstrap') {
                return Response.json({ loginApiUrl, loginRequired: true });
            }
            if (url.pathname === '/api/auth/login') {
                loginAttempts += 1;
                return Response.json(
                    { player: { username: 'test-player' } },
                    {
                        headers: {
                            'set-cookie': 'box_local_player_session=test-session; Path=/; HttpOnly',
                        },
                    },
                );
            }
            if (url.pathname === '/api/auth/logout') {
                return new Response('{}', {
                    status: 200,
                    headers: { 'set-cookie': 'box_local_player_session=; Path=/; Max-Age=0' },
                });
            }
            return new Response('{}', { status: 404 });
        },
    });
    const playerApi = createPlayerApi({
        isNative: () => true,
        invoke: async (_command, payload) => transport.request(payload.request),
    });

    const bootstrap = await playerApi.readBootstrap(endpoint);
    assert.equal(bootstrap.supported, true);
    assert.equal(
        (await playerApi.login(endpoint, bootstrap, 'test-player', 'fixture-password')).response.ok,
        true,
    );
    assert.equal((await playerApi.logout(endpoint, bootstrap)).response.ok, true);
    transport.clear(endpoint);

    let secondLoginError = '';
    try {
        const result = await playerApi.login(
            endpoint,
            bootstrap,
            'test-player',
            'fixture-password',
        );
        assert.equal(result.response.ok, true);
    } catch (error) {
        secondLoginError = playerLoginConnectionError(error);
    }

    assert.equal(secondLoginError, '');
    assert.equal(loginAttempts, 2);
});

test('native bootstrap, login and logout preserve a shared-domain portal prefix', async () => {
    const endpoint = 'https://example.test/play';
    const loginApiUrl = 'https://example.test/accounts/api/auth/login';
    const requests:string[] = [];
    const transport = createApiTransport({
        fetchImpl: async (input) => {
            const url = String(input);
            requests.push(url);
            if (url.endsWith('/api/player-launcher/bootstrap')) {
                return Response.json({ loginApiUrl, loginRequired: true });
            }
            return Response.json({ player: { username: 'test-player' } });
        },
    });
    const api = createPlayerApi({
        isNative: () => true,
        invoke: async (_command, payload) => transport.request(payload.request),
    });
    const bootstrap = await api.readBootstrap(endpoint);
    await api.login(endpoint, bootstrap, 'test-player', 'fixture-password');
    await api.logout(endpoint, bootstrap);
    assert.deepEqual(requests, [
        `${endpoint}/api/player-launcher/bootstrap`,
        loginApiUrl,
        'https://example.test/accounts/api/auth/logout',
    ]);
});
