import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';

import { measureCachedResources } from './cache-measurement';

test('cache statistics use metadata without transferring cached response bodies', async () => {
    const result = await vm.runInNewContext(`(${measureCachedResources.toString()})('map')`, {
        caches: {
            open: async () => ({
                keys: async () => ['large', 'empty'],
                match: async (key:string) => ({
                    headers: new Headers({
                        'content-length': key === 'large' ? '1073741824' : '0',
                    }),
                    blob: async () => assert.fail('metadata must not read the body'),
                }),
            }),
        },
    });
    assert.equal(result.bytes, 1024 ** 3);
    assert.equal(result.resources, 2);
});

test('legacy and compressed responses are measured locally with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const result = await vm.runInNewContext(
        `(${measureCachedResources.toString()})('legacy-map')`,
        {
            caches: {
                open: async () => ({
                    keys: async () => Array.from({ length: 65 }, (_, index) => index),
                    match: async (key:number) =>
                        key === 64
                            ? undefined
                            : {
                                  headers: new Headers(
                                      key % 2
                                          ? { 'content-length': '1', 'content-encoding': 'gzip' }
                                          : {},
                                  ),
                                  blob: async () => {
                                      active += 1;
                                      peak = Math.max(peak, active);
                                      await new Promise((resolve) => setTimeout(resolve, 1));
                                      active -= 1;
                                      return { size: 1024 };
                                  },
                              },
                }),
            },
        },
    );
    assert.equal(result.bytes, 64 * 1024);
    assert.equal(result.resources, 64);
    assert.ok(peak > 1 && peak <= 8);
});
