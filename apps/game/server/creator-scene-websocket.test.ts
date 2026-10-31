import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { once } from 'node:events';
import { createCreatorSceneWebSocketServer } from './creator-scene-websocket';
import { enableCreatorSceneSession, requestCreatorSceneCapture, creatorSceneSessionStatus } from './creator-scene-session';
const WebSocket = require('ws');
let server: Awaited<ReturnType<typeof createCreatorSceneWebSocketServer>>;
const host = '127.0.0.1:3127';
let counter = 0;
async function connect(projectId: string, session: ReturnType<typeof enableCreatorSceneSession>, origin = `http://${host}`) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/creator/v1/scene/socket`, { origin });
  await once(ws, 'open');
  const response = new Promise<any>(resolve => {
    ws.once('message', data => resolve(JSON.parse(String(data))));
    ws.once('close', code => resolve({ closed: code }));
  });
  ws.send(JSON.stringify({ type: 'connect', projectId, sessionId: session.sessionId, socketToken: session.socketToken }));
  return { ws, response };
}
beforeAll(async () => { server = await createCreatorSceneWebSocketServer(0); });
afterAll(async () => { await server.close(); });
describe('Creator scene WebSocket', () => {
  test('pushes capture on demand and accepts the result over the same socket', async () => {
    const project = `ws-capture-${counter++}`;
    const session = enableCreatorSceneSession(project, 'owner', host);
    const { ws, response } = await connect(project, session);
    expect(await response).toEqual({ type: 'ready' });
    const received = once(ws, 'message');
    const pending = requestCreatorSceneCapture(project, '3d');
    const action = JSON.parse(String((await received)[0]));
    expect(action).toMatchObject({ type: 'capture', view: '3d' });
    const content = Buffer.alloc(2 * 1024 * 1024, 1);
    ws.send(JSON.stringify({ type: 'capture-result', id: action.id, contentBase64: content.toString('base64') }));
    const capture = await pending;
    expect(Object.keys(capture).sort()).toEqual(['content', 'contentType']);
    expect(capture.contentType).toBe('image/png');
    expect(capture.content.equals(content)).toBe(true);
    const closed = once(ws, 'close'); ws.close(); await closed;
    // The peer's close callback may run after the client's close event.
    for (let i = 0; i < 100 && creatorSceneSessionStatus(project, session.sessionId, 'owner'); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(creatorSceneSessionStatus(project, session.sessionId, 'owner')).toBe(false);
  });
  test('rejects a cross-origin attachment without consuming the credential', async () => {
    const project = `ws-origin-${counter++}`;
    const session = enableCreatorSceneSession(project, 'owner', host);
    const bad = await connect(project, session, 'http://other-host');
    expect(await bad.response).toEqual({ closed: 1008 });
    const good = await connect(project, session);
    expect(await good.response).toEqual({ type: 'ready' });
    const closed = once(good.ws, 'close'); good.ws.close(); await closed;
  });
  test('rejects replayed credentials and requests belonging to another project', async () => {
    const project = `ws-token-${counter++}`;
    const session = enableCreatorSceneSession(project, 'owner', host);
    const wrong = await connect('another-project', session);
    expect(await wrong.response).toEqual({ closed: 1008 });
    const first = await connect(project, session);
    expect(await first.response).toEqual({ type: 'ready' });
    const replay = await connect(project, session);
    expect(await replay.response).toEqual({ closed: 1008 });
    const closed = once(first.ws, 'close'); first.ws.close(); await closed;
  });
  test('rejects pending captures immediately when the editor disconnects', async () => {
    const project = `ws-disconnect-${counter++}`;
    const session = enableCreatorSceneSession(project, 'owner', host);
    const { ws, response } = await connect(project, session);
    await response;
    const pending = requestCreatorSceneCapture(project);
    const assertion = expect(pending).rejects.toThrow('已关闭');
    ws.close();
    await assertion;
  });
  test('reports capture failure without waiting for the timeout', async () => {
    const project = `ws-failure-${counter++}`;
    const session = enableCreatorSceneSession(project, 'owner', host);
    const { ws, response } = await connect(project, session); await response;
    const received = once(ws, 'message');
    const pending = requestCreatorSceneCapture(project, '2d');
    const assertion = expect(pending).rejects.toThrow('截图失败');
    const action = JSON.parse(String((await received)[0]));
    ws.send(JSON.stringify({ type: 'capture-error', id: action.id }));
    await assertion;
    const closed = once(ws, 'close'); ws.close(); await closed;
  });
  test('delivers a capture queued before socket authentication', async () => {
    const project = `ws-queued-${counter++}`;
    const session = enableCreatorSceneSession(project, 'owner', host);
    const pending = requestCreatorSceneCapture(project);
    const { ws, response } = await connect(project, session);
    const action = await response;
    expect(action.type).toBe('capture');
    ws.send(JSON.stringify({ type: 'capture-result', id: action.id, contentBase64: Buffer.from('queued').toString('base64') }));
    await expect(pending).resolves.toMatchObject({ content: Buffer.from('queued') });
    const closed = once(ws, 'close'); ws.close(); await closed;
  });
});

test('Next WebSocket proxy forwards same-origin authentication, commands and capture output', async () => {
  const { createServer } = await import('node:http');
  const { parse } = await import('node:url');
  const { proxyRequest } = require('next/dist/server/lib/router-utils/proxy-request');
  const frontend = createServer();
  frontend.on('upgrade', (req, socket, head) => {
    void proxyRequest(req, socket,
      parse(`http://127.0.0.1:${server.port}/api/creator/v1/scene/socket`, true), head)
      .catch(() => socket.destroy());
  });
  await new Promise<void>(resolve => frontend.listen(0, '127.0.0.1', resolve));
  const publicHost = `127.0.0.1:${(frontend.address() as any).port}`;
  const project = `ws-proxy-${counter++}`;
  const session = enableCreatorSceneSession(project, 'owner', publicHost);
  const ws = new WebSocket(`ws://${publicHost}/api/creator/v1/scene/socket`, { origin: `http://${publicHost}` });
  try {
    await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'connect', projectId: project, sessionId: session.sessionId, socketToken: session.socketToken }));
    expect(JSON.parse(String((await ready)[0]))).toEqual({ type: 'ready' });
    const received = once(ws, 'message');
    const pending = requestCreatorSceneCapture(project, 'full');
    const action = JSON.parse(String((await received)[0]));
    ws.send(JSON.stringify({ type: 'capture-result', id: action.id, contentBase64: Buffer.from('proxy').toString('base64') }));
    await expect(pending).resolves.toMatchObject({ content: Buffer.from('proxy') });
  } finally {
    const closed = once(ws, 'close'); ws.close(); await closed;
    await new Promise<void>(resolve => frontend.close(() => resolve()));
  }
});
