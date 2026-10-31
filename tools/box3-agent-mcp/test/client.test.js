import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { AgentClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { buildTools } from '../src/tools.js';

async function withMock(run) {
  const calls = [];
  let joins = 0;
  let tokens = ['agx_one', 'agx_two'];
  let commandResponse = {
    ok: true,
    commandId: 'c1',
    result: { summary: '观察完成' },
    snapshot: { cursor: { voxel: [1, 2, 3] } },
  };
  let commandStatus = 200;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : null;
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/api/agent/v1/join') {
        const token = tokens[Math.min(joins, tokens.length - 1)];
        joins += 1;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          token,
          agentId: 'agent-1',
          tokenFingerprint: 'fp-1',
          project: { id: 'p1' },
        }));
        return;
      }
      if (req.url.startsWith('/api/agent/v1/live/map/p1/')) {
        res.writeHead(commandStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(commandResponse));
        return;
      }
      if (req.url === '/api/agent/v1/live/voxa/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ attached: true, modelId: 7 }));
        return;
      }
      res.writeHead(404).end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = loadConfig({
    BOX_MAP_AGENT_BASE_URL: `http://127.0.0.1:${port}`,
    BOX_VOXA_AGENT_BASE_URL: `http://127.0.0.1:${port}`,
    BOX_MAP_AGENT_CODE: 'MAP-TEST-TEST-TEST',
    BOX_MAP_PROJECT: 'p1',
    BOX_AGENT_MIN_ACTION_MS: '0',
    BOX_AGENT_WAIT_MS: '5000',
  });
  const client = new AgentClient(config);
  const tools = buildTools(client, config);
  const tool = (name) => tools.find((candidate) => candidate.name === name);
  try {
    await run({ calls, client, config, tools, tool, setCommand: (response, status = 200) => {
      commandResponse = response;
      commandStatus = status;
    }, getJoins: () => joins });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('observe redeems the join code, sends it to the live command route, and returns the snapshot', async () => {
  await withMock(async ({ calls, tool, getJoins }) => {
    const output = await tool('agent_observe').handler({});
    assert.equal(getJoins(), 1);
    assert.equal(output.summary, '观察完成');
    assert.deepEqual(output.data.cursor.voxel, [1, 2, 3]);

    const join = calls.find((call) => call.url === '/api/agent/v1/join');
    assert.deepEqual(join.body, { code: 'MAP-TEST-TEST-TEST', name: 'zcode' });

    const command = calls.find((call) => call.url === '/api/agent/v1/live/map/p1/observe');
    assert.equal(command.method, 'POST');
    assert.equal(command.headers.authorization, 'Bearer agx_one');
    assert.equal(command.body.includeTerrain, false);
  });
});

test('address + code is enough: the map id comes from the join response', async () => {
  await withMock(async ({ config, calls, tool }) => {
    // No BOX_MAP_PROJECT at all — the panel handoff is just URL + code.
    const auto = new AgentClient({ ...config, mapProject: '' });
    const autoTools = buildTools(auto, { ...config, mapProject: '' });
    const status = await autoTools.find((candidate) => candidate.name === 'agent_status').handler({});
    assert.ok(status.data, 'status must reach the map route resolved from join');
    assert.equal(auto.projectId(), 'p1');
    assert.ok(calls.some((call) => call.url === '/api/agent/v1/live/map/p1/status'));
    assert.equal(auto.joins.map.editorUrl, undefined, 'mock join has no editor url');

    const observe = await autoTools.find((candidate) => candidate.name === 'agent_observe').handler({});
    assert.equal(observe.summary, '观察完成');
    assert.ok(calls.some((call) => call.url === '/api/agent/v1/live/map/p1/observe'));
    assert.ok(tool('agent_status'), 'baseline tools still build');
  });
});

test('CROSS_MAP_TOKEN is reported with a re-join hint instead of a generic 401', async () => {
  await withMock(async ({ tool, setCommand }) => {
    setCommand({ code: 'CROSS_MAP_TOKEN', message: '该令牌属于另一张地图' }, 401);
    await assert.rejects(() => tool('agent_observe').handler({}), (error) => {
      assert.equal(error.code, 'CROSS_MAP_TOKEN');
      assert.match(error.hint, /另一张地图|重新 join/);
      return true;
    });
  });
});

test('a 401 from a stale token re-joins once and retries the command', async () => {
  let calls = 0;
  await withMock(async ({ calls: recorded, tool, getJoins, setCommand }) => {
    // First join succeeds, then the command rejects the token; the client must
    // redeem the code again and succeed with the second token.
    const originalRequest = tool('agent_observe').handler;
    setCommand({ code: 'AGENT_AUTH_REQUIRED', message: 'stale' }, 401);
    await assert.rejects(() => originalRequest({}), (error) => error.code === 'AGENT_AUTH_REQUIRED');
    calls += getJoins();
    assert.equal(calls, 2, 'join must happen twice (initial + after 401)');
    const commands = recorded.filter((call) => call.url === '/api/agent/v1/live/map/p1/observe');
    assert.equal(commands.length, 2);
    assert.equal(commands[1].headers.authorization, 'Bearer agx_two');
  });
});

test('EDITOR_NOT_ATTACHED is surfaced as retryable with the attach hint', async () => {
  await withMock(async ({ tool, setCommand }) => {
    setCommand({ code: 'EDITOR_NOT_ATTACHED', message: '该地图当前没有打开的编辑器' }, 409);
    await assert.rejects(() => tool('agent_observe').handler({}), (error) => {
      assert.equal(error.code, 'EDITOR_NOT_ATTACHED');
      assert.equal(error.retryable, true);
      assert.match(error.hint, /打开/);
      return true;
    });
  });
});

test('read-only mode blocks writers but keeps observers working', async () => {
  await withMock(async ({ client, config }) => {
    const readOnlyTools = buildTools(client, { ...config, allowWrite: false });
    const place = readOnlyTools.find((candidate) => candidate.name === 'agent_place');
    await assert.rejects(() => place.handler({ at: [1, 2, 3], block: 'stone' }), (error) => {
      assert.equal(error.code, 'WRITE_DISABLED');
      return true;
    });
    const observe = readOnlyTools.find((candidate) => candidate.name === 'agent_observe');
    const output = await observe.handler({});
    assert.equal(output.summary, '观察完成');
  });
});

test('a timed-out write blocks further writes until observe, and operationId is surfaced', async () => {
  await withMock(async ({ tool, setCommand, calls }) => {
    setCommand(
      { ok: false, commandId: 'c-timeout', error: { code: 'EDITOR_TIMEOUT', message: 'no ack' } },
      504,
    );
    await assert.rejects(
      () => tool('agent_place').handler({ at: [1, 2, 3], block: 'stone' }),
      (error) => error.code === 'EDITOR_TIMEOUT',
    );

    const before = calls.filter((call) => call.url.endsWith('/cmd')).length;
    await assert.rejects(
      () => tool('agent_place').handler({ at: [1, 2, 3], block: 'stone' }),
      (error) => error.code === 'OBSERVE_REQUIRED',
    );
    assert.equal(
      calls.filter((call) => call.url.endsWith('/cmd')).length,
      before,
      'the gated write must not reach the engine',
    );

    setCommand({
      ok: true,
      commandId: 'c-observe',
      result: { summary: '观察完成' },
      snapshot: { cursor: { voxel: [1, 2, 3] } },
    });
    await tool('agent_observe').handler({});

    setCommand({
      ok: true,
      commandId: 'c-place',
      result: { summary: '放置 stone 于 [1, 2, 3]' },
      snapshot: { cursor: { voxel: [1, 2, 3] } },
    });
    const placed = await tool('agent_place').handler({ at: [1, 2, 3], block: 'stone' });
    assert.equal(placed.data.operationId, 'c-place');
  });
});
