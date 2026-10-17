import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { clearResourceCache, readResourceCache } from './resource-cache';

import type { Session } from 'electron';

test('reports only resource caches and preserves account cookies when clearing', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'box-cache-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const cache = path.join(root, 'Service Worker', 'CacheStorage');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'resource'), '12345');
    await fs.writeFile(path.join(root, 'Cookies'), 'account-data');
    const cleared:string[] = [];
    const session = {
        getStoragePath: () => root,
        getCacheSize: async () => 10,
        clearStorageData: async ({ storages }) => {
            cleared.push(...storages);
        },
        clearCache: async () => {
            cleared.push('http-cache');
        },
    } as unknown as Session;
    assert.deepEqual(await readResourceCache(session), { staticBytes: 5, httpBytes: 10 });
    await clearResourceCache(session);
    assert.deepEqual(cleared, ['serviceworkers', 'cachestorage', 'http-cache']);
    assert.equal(await fs.readFile(path.join(root, 'Cookies'), 'utf8'), 'account-data');
});
