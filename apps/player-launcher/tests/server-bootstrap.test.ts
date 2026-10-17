import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPlayerApi } from '../src/api/player-api';

test('retries a transient missing launcher bootstrap before marking the server unsupported', async () => {
    const responses = [
        { status: 404, body: '{}' },
        { status: 200, body: JSON.stringify({ serverName: '本机', loginRequired: true }) },
    ];
    let requestCount = 0;
    const playerApi = createPlayerApi({
        isNative: () => true,
        invoke: async (_command, payload) => {
            requestCount += 1;
            const next = responses.shift() || { status: 500, body: '{}' };
            return {
                status: next.status,
                headers: [['content-type', 'application/json']],
                body: next.body,
            };
        },
    });

    const bootstrap = await playerApi.readBootstrap('http://127.0.0.1:3121');

    assert.equal(bootstrap.supported, true);
    assert.equal(bootstrap.serverName, '本机');
    assert.equal(requestCount, 2);
});

test('only marks a server unsupported after the bootstrap route stays missing on retry', async () => {
    let requestCount = 0;
    const playerApi = createPlayerApi({
        isNative: () => true,
        invoke: async () => {
            requestCount += 1;
            return { status: 404, headers: [['content-type', 'application/json']], body: '{}' };
        },
    });

    const bootstrap = await playerApi.readBootstrap('http://127.0.0.1:3121');

    assert.equal(bootstrap.supported, false);
    assert.equal(requestCount, 2);
});
