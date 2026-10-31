import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
// @ts-ignore Native Node test runner requires explicit extensions.
import { AuthoringSession } from './authoring-session.ts';
// @ts-ignore Native Node test runner requires explicit extensions.
import { createAuthoringEventHandler } from './authoring-events.ts';

test('SSE sends snapshot, replays after cursor, and streams new operations', async () => {
  const session = new AuthoringSession(async () => ({ success: true }));
  await session.perform('terrainApply', {}, 'first');
  const handler = createAuthoringEventHandler(session, async () => ({ entityCount: 5 }));
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { 'Last-Event-ID': `${session.runtimeId}:2` }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(`id: ${session.runtimeId}:3`)) text += decoder.decode((await reader.read()).value);
    assert.match(text, /"entityCount":5/);
    assert.match(text, /"type":"snapshot"/);
    assert.equal(text.includes(`id: ${session.runtimeId}:1\n`), false);
    await session.perform('terrainApply', {}, 'second');
    while (!text.includes(`id: ${session.runtimeId}:6`)) text += decoder.decode((await reader.read()).value);
    assert.match(text, /"operationId":"second"/);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
