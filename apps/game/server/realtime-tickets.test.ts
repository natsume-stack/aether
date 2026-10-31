import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { once } from 'node:events';
import { createCreatorSceneWebSocketServer } from './creator-scene-websocket';
import { issueRealtimeTicket, consumeRealtimeTicket } from './realtime-tickets';
import { connectPlayPresence, getPlayPresenceCounts } from './play-presence';
const WebSocket = require('ws');
let server: Awaited<ReturnType<typeof createCreatorSceneWebSocketServer>>;
beforeAll(async () => { server = await createCreatorSceneWebSocketServer(0); });
afterAll(async () => { await server.close(); });
async function connect(ticket: string, origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/realtime/socket`, origin ? { origin } : {});
  await once(ws, 'open');
  const result = new Promise<any>(resolve => {
    ws.once('message', data => resolve(JSON.parse(String(data))));
    ws.once('close', code => resolve({ closed: code }));
  });
  ws.send(JSON.stringify({ type: 'connect', ticket }));
  return { ws, result };
}
test('tickets are host-bound, one-use and expire in 30 seconds', () => {
  const grant = issueRealtimeTicket('host:123', () => ({ close() {} }));
  expect(() => consumeRealtimeTicket(grant.ticket, 'other')).toThrow();
  expect(consumeRealtimeTicket(grant.ticket, 'host:123')).toBeInstanceOf(Function);
  expect(() => consumeRealtimeTicket(grant.ticket, 'host:123')).toThrow();
  const oldNow = Date.now;
  const expiring = issueRealtimeTicket('host', () => ({ close() {} }));
  try { Date.now = () => oldNow() + 31_000; expect(() => consumeRealtimeTicket(expiring.ticket, 'host')).toThrow(); }
  finally { Date.now = oldNow; }
});
test('real WS rejects cross-origin and replay, disconnect releases subscription', async () => {
  let attached = 0, released = 0;
  const grant = issueRealtimeTicket('host:123', () => { attached++; return { close() { released++; } }; });
  const bad = await connect(grant.ticket, 'http://other');
  expect(await bad.result).toEqual({ closed: 1008 }); expect(attached).toBe(0);
  const good = await connect(grant.ticket, 'http://host:123');
  expect(await good.result).toEqual({ type: 'ready' });
  const replay = await connect(grant.ticket, 'http://host:123');
  expect(await replay.result).toEqual({ closed: 1008 });
  const closed = once(good.ws, 'close'); good.ws.close(); await closed;
  for (let i = 0; i < 50 && !released; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(attached).toBe(1); expect(released).toBe(1);
});
test('originless internal tickets cannot attach from a browser', async () => {
  const grant = issueRealtimeTicket('internal', () => ({ close() {} }));
  const browser = await connect(grant.ticket, 'http://host:123');
  expect(await browser.result).toEqual({ closed: 1008 });
  const internal = await connect(grant.ticket);
  expect(await internal.result).toEqual({ type: 'ready' });
  const closed = once(internal.ws, 'close'); internal.ws.close(); await closed;
});
test('presence deduplicates accounts, tabs and map groups', () => {
  const a = connectPlayPresence('map-ws-a', 'player', 'tab-a');
  const b = connectPlayPresence('map-ws-a', 'player', 'tab-b');
  const c = connectPlayPresence('map-ws-b', 'player', 'tab-c');
  const d = connectPlayPresence('map-ws-b', 'other', 'tab-d');
  const groups = { 'map-ws-a': 'group', 'map-ws-b': 'group' };
  const count = () => getPlayPresenceCounts(['map-ws-a', 'map-ws-b'], groups);
  try {
    expect(count()['map-ws-a'].onlineCount).toBe(2);
    a(); expect(count()['map-ws-a'].onlineCount).toBe(2);
    b(); c(); expect(count()['map-ws-a'].onlineCount).toBe(1);
    d(); expect(count()['map-ws-a'].onlineCount).toBe(0);
  } finally { a(); b(); c(); d(); }
});
