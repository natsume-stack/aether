import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refreshStorage } from '../src/features/storage/events';

import type { PlayerInvoke, PlayerLauncherState } from '../src/types';

test('storage displays completed servers while another server is still being inspected', async () => {
    const state = { servers: [{ id: 'fast' }, { id: 'slow' }] } as PlayerLauncherState;
    let release:() => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const refresh = refreshStorage({
        state,
        playerInvoke: (async (_command, { serverId }) => {
            if (serverId === 'slow') {
                await waiting;
                throw new Error('slow cache unavailable');
            }
            return { staticBytes: 1, httpBytes: 0, inUse: false, maps: [{ mapId: 'map' }] };
        }) as PlayerInvoke,
        render: () => {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.storage?.loading, true);
    assert.equal(state.storage?.rows[0]?.serverId, 'fast');
    release!();
    await refresh;
    assert.equal(state.storage?.loading, false);
    assert.equal(state.storage?.rows[0]?.serverId, 'fast');
    assert.equal(state.storage?.error, 'slow cache unavailable');
});
