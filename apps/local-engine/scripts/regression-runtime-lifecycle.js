'use strict';

const assert = require('node:assert/strict');
const { createRuntimeLifecycle } = require('../src/runtime-lifecycle');

async function main() {
    const runtimes = new Map();
    const starts = new Map();
    const stopped = [];
    const statuses = new Map();
    const lifecycle = createRuntimeLifecycle({
        runtimes,
        starts,
        maxRuntimes: 2,
        idleTimeoutMs: 1000,
        setStatus: (id, value) => statuses.set(id, value),
        stopRuntime: async (id) => {
            stopped.push(id);
            runtimes.delete(id);
        },
    });

    runtimes.set('old', { lastAccessAt: 1000, activeConnections: 0 });
    runtimes.set('new', { lastAccessAt: 2000, activeConnections: 0 });
    await lifecycle.ensureCapacity('third');
    assert.deepEqual(
        stopped,
        ['old'],
        'capacity must recycle the least recently used idle runtime',
    );

    const release = lifecycle.acquire(runtimes.get('new'));
    release();
    release();
    assert.equal(runtimes.get('new').activeConnections, 0, 'connection release must be idempotent');

    const maintenance = { lastAccessAt: 1000, activeConnections: 0 };
    runtimes.set('maintenance', maintenance);
    const releaseMaintenance = lifecycle.acquire(maintenance, { touchAccess: false });
    releaseMaintenance();
    assert.equal(
        maintenance.lastAccessAt,
        1000,
        'maintenance requests must not renew an idle runtime lease',
    );
    assert.deepEqual(
        await lifecycle.collectIdle(2000),
        ['maintenance'],
        'an idle runtime must be recycled even after an automatic maintenance request',
    );

    runtimes.set('busy-a', { lastAccessAt: 1000, activeConnections: 1 });
    starts.set('starting-b', Promise.resolve());
    runtimes.get('new').activeConnections = 1;
    await assert.rejects(
        lifecycle.ensureCapacity('blocked'),
        (error) => error.statusCode === 503,
        'capacity must reject when every allocated runtime is busy or starting',
    );
    starts.clear();
    runtimes.delete('busy-a');

    runtimes.get('new').activeConnections = 0;
    runtimes.get('new').lastAccessAt = 1000;
    starts.set('new', Promise.resolve());
    assert.deepEqual(
        await lifecycle.collectIdle(2000),
        [],
        'idle recycling must not stop a runtime whose startup is still in progress',
    );
    starts.clear();
    const expired = await lifecycle.collectIdle(2000);
    assert.deepEqual(expired, ['new']);
    assert.equal(statuses.get('new').phase, 'idle');
    console.log('runtime lifecycle regression passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
