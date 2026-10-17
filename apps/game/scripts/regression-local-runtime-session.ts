import assert from 'node:assert/strict';

import { prepareLocalRuntimeSession } from '../server/local-runtime-session';

async function main() {
  const calls: string[] = [];
  const pending = await prepareLocalRuntimeSession(
    'http://127.0.0.1:9967/large-imported-map',
    {
      post: async (url: string) => {
        calls.push(`POST ${url}`);
        return { status: 202, data: { phase: 'starting' } };
      },
      get: async (url: string) => {
        calls.push(`GET ${url}`);
        return {
          status: 200,
          data: {
            phase: 'loading',
            percent: 58,
            message: '地图仍在迁移和预烘焙，运行时会继续加载',
          },
        };
      },
    },
  );

  assert.equal(pending.ready, false);
  assert.equal(pending.status.phase, 'loading');
  assert.deepEqual(calls, [
    'POST http://127.0.0.1:9967/large-imported-map/__local_runtime/start',
    'GET http://127.0.0.1:9967/large-imported-map/__local_runtime/status',
  ]);

  const ready = await prepareLocalRuntimeSession(
    'http://127.0.0.1:9967/large-imported-map',
    {
      post: async () => ({ status: 202, data: { phase: 'starting' } }),
      get: async () => ({
        status: 200,
        data: { phase: 'ready', percent: 100, message: '运行时已就绪' },
      }),
    },
  );
  assert.equal(ready.ready, true);

  await assert.rejects(
    prepareLocalRuntimeSession('http://127.0.0.1:9967/broken-map', {
      post: async () => ({ status: 202, data: { phase: 'starting' } }),
      get: async () => ({
        status: 200,
        data: { phase: 'error', percent: 0, message: '资源不完整' },
      }),
    }),
    /资源不完整/,
  );

  console.log('local runtime session startup regression passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
