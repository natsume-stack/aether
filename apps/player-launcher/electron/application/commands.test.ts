import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPlayerCommands } from './commands';

import type { PlayerCommandOptions } from './commands';

test('desktop commands reject unknown operations and preserve account cleanup order', async () => {
    const calls:string[] = [];
    const state = {
        servers: [{ id: 'server', endpoint: 'http://engine.test/abc' }],
        selectedServerId: 'server',
    };
    const dispatch = createPlayerCommands({
        serverStore: {
            load: () => state,
            remove: async () => {
                calls.push('remove');
                return { servers: [], selectedServerId: '' };
            },
        },
        gameWindowManager: {
            isActiveFor: () => true,
            close: async () => {
                calls.push('close');
            },
            clearServerCache: async () => {
                calls.push('cache');
            },
        },
        apiTransport: {
            forget: () => {
                calls.push('session');
            },
        },
        clearWebSessionCookies: async () => {
            calls.push('cookies');
        },
    } as unknown as PlayerCommandOptions);
    await assert.rejects(dispatch('unknown'), /不允许/);
    assert.equal(await dispatch('launcher_state'), state);
    assert.deepEqual(await dispatch('remove_server', { serverId: 'server' }), {
        servers: [],
        selectedServerId: '',
    });
    assert.deepEqual(calls, ['close', 'cache', 'session', 'cookies', 'remove']);
});

test('failed cache cleanup does not remove the saved server', async () => {
    let removed = false;
    const dispatch = createPlayerCommands({
        serverStore: {
            load: () => ({ servers: [{ id: 'server', endpoint: 'http://engine.test' }] }),
            remove: async () => {
                removed = true;
            },
        },
        gameWindowManager: {
            isActiveFor: () => false,
            clearServerCache: async () => {
                throw new Error('Cache unavailable');
            },
        },
    } as unknown as PlayerCommandOptions);
    await assert.rejects(dispatch('remove_server', { serverId: 'server' }), /Cache unavailable/);
    assert.equal(removed, false);
});
