// Regression for the VOXA tools: they must target the VOXA live surface (not
// the map one), and the new script tools must reach the map live surface with
// the right command kinds. Both were verified against a mock HTTP server.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { AgentClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { buildTools } from '../src/tools.js';

function startMock() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      calls.push({ method: req.method, url: req.url, body });
      const json = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/api/agent/v1/join') {
        json(201, { token: 'agx_test', tokenFingerprint: 'abc123', agentId: 'agent-1', project: { id: 'p1' } });
        return;
      }
      if (req.url.startsWith('/api/agent/v1/live/voxa/status')) {
        json(200, { ok: true, attached: true, lastSeq: 0 });
        return;
      }
      if (req.url.startsWith('/api/agent/v1/live/voxa/cmd')) {
        json(200, { ok: true, result: { summary: `voxa:${body.kind}` } });
        return;
      }
      if (req.url.startsWith('/api/agent/v1/live/map/')) {
        json(200, { ok: true, result: { summary: `map:${body?.kind}` } });
        return;
      }
      json(404, { message: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('VOXA tools hit the VOXA live surface and never the map one', async () => {
  const mock = await startMock();
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    const config = loadConfig({
      BOX_VOXA_AGENT_BASE_URL: base,
      BOX_MAP_AGENT_BASE_URL: base,
      BOX_VOXA_AGENT_CODE: 'VOX-AAAA-BBBB-CCCC',
      BOX_MAP_AGENT_CODE: 'MAP-AAAA-BBBB-CCCC',
      BOX_MAP_PROJECT: 'p1',
    });
    const tools = buildTools(new AgentClient(config), config);
    const look = tools.find((tool) => tool.name === 'voxa_look');
    assert.ok(look, 'voxa_look must be registered');
    const result = await look.handler({ target: [1, 2, 3] });
    assert.equal(result.summary, 'voxa:look');
    assert.ok(mock.calls.some((call) => call.url.includes('/live/voxa/cmd')));
    assert.ok(!mock.calls.some((call) => call.url.includes('/live/map/')));
  } finally {
    await mock.close();
  }
});

test('script tools reach the map live surface with the script command kinds', async () => {
  const mock = await startMock();
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    const config = loadConfig({
      BOX_MAP_AGENT_BASE_URL: base,
      BOX_MAP_AGENT_CODE: 'MAP-AAAA-BBBB-CCCC',
      BOX_MAP_PROJECT: 'p1',
    });
    const tools = buildTools(new AgentClient(config), config);
    const names = tools.map((tool) => tool.name);
    for (const name of [
      'agent_script_files',
      'agent_script_open',
      'agent_script_read',
      'agent_script_replace',
      'agent_script_insert',
    ]) {
      assert.ok(names.includes(name), `${name} must be registered`);
    }

    const replace = tools.find((tool) => tool.name === 'agent_script_replace');
    const result = await replace.handler({ content: 'export const a = 1;' });
    assert.equal(result.summary, 'map:script_replace');

    const open = tools.find((tool) => tool.name === 'agent_script_open');
    await open.handler({ file: 'server' });
    const kinds = mock.calls
      .filter((call) => call.body && call.body.kind)
      .map((call) => call.body.kind);
    assert.deepEqual(kinds, ['script_replace', 'script_open']);
  } finally {
    await mock.close();
  }
});

test('read-only mode still blocks script writes', async () => {
  const mock = await startMock();
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    const config = loadConfig({
      BOX_MAP_AGENT_BASE_URL: base,
      BOX_MAP_AGENT_CODE: 'MAP-AAAA-BBBB-CCCC',
      BOX_MAP_PROJECT: 'p1',
      BOX_AGENT_ALLOW_WRITE: '0',
    });
    const tools = buildTools(new AgentClient(config), config);
    const replace = tools.find((tool) => tool.name === 'agent_script_replace');
    await assert.rejects(() => replace.handler({ content: 'x' }), /WRITE_DISABLED|只读/);
  } finally {
    await mock.close();
  }
});

test('a base URL with a path prefix keeps that prefix (the /edit production shape)', () => {
  // The deployed editor lives at https://box3.cdk.lat/edit and the gateway
  // strips /edit before forwarding. Dropping the prefix silently routes every
  // live call to the play upstream instead of creator.
  const prefixed = new AgentClient(
    loadConfig({
      BOX_MAP_AGENT_BASE_URL: 'https://box3.cdk.lat/edit',
      BOX_MAP_AGENT_CODE: 'MAP-AAAA-BBBB-CCCC',
    }),
  );
  assert.equal(
    prefixed.resolve('map', '/api/agent/v1/live/map/p1/cmd').href,
    'https://box3.cdk.lat/edit/api/agent/v1/live/map/p1/cmd',
  );

  const trailing = new AgentClient(
    loadConfig({
      BOX_VOXA_AGENT_BASE_URL: 'https://box3.cdk.lat/edit/',
      BOX_VOXA_AGENT_CODE: 'VOX-AAAA-BBBB-CCCC',
    }),
  );
  assert.equal(
    trailing.resolve('voxa', '/api/agent/v1/live/voxa/status').href,
    'https://box3.cdk.lat/edit/api/agent/v1/live/voxa/status',
  );

  const loopback = new AgentClient(
    loadConfig({ BOX_MAP_AGENT_BASE_URL: 'http://127.0.0.1:3127', BOX_MAP_AGENT_CODE: 'x' }),
  );
  assert.equal(
    loopback.resolve('map', '/api/agent/v1/join').href,
    'http://127.0.0.1:3127/api/agent/v1/join',
  );
});
