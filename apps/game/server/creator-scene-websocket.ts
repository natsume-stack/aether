import { createServer } from 'node:http';
import { attachCreatorSceneSocket } from './creator-scene-session';
import { handleRealtimeSocket } from './realtime-tickets';

const WebSocket = require('ws');
const PATH = '/api/creator/v1/scene/socket';

/** Loopback-only transport. Next's same-origin upgrade proxy is the public entry. */
export async function createCreatorSceneWebSocketServer(port: number) {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocket.Server({ noServer: true, maxPayload: 9 * 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (![PATH, '/api/realtime/socket'].includes(req.url || '') || sockets.clients.size >= 128) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
  });
  sockets.on('connection', (ws, req) => {
    if (req.url === '/api/realtime/socket') { handleRealtimeSocket(ws, req); return; }
    let originHost = '';
    try { originHost = new URL(req.headers.origin || '').host; } catch { ws.close(1008); return; }
    let binding: ReturnType<typeof attachCreatorSceneSocket> | undefined;
    const authTimeout = setTimeout(() => ws.close(1008), 5_000);
    authTimeout.unref?.();
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 30_000);
    heartbeat.unref?.();
    const send = (value: object) => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1024 * 1024) throw new Error('场景控制连接不可用');
      ws.send(JSON.stringify(value));
    };
    ws.on('message', (bytes, binary) => {
      try {
        if (binary || (!binding && bytes.length > 1024)) throw new Error('无效控制消息');
        const message = JSON.parse(String(bytes));
        if (!binding) {
          if (message.type !== 'connect' || !['projectId', 'sessionId', 'socketToken'].every(key => typeof message[key] === 'string')) {
            throw new Error('未授权连接');
          }
          binding = attachCreatorSceneSocket(message.projectId, message.sessionId, message.socketToken, originHost,
            action => send(action), () => ws.close(1000));
          clearTimeout(authTimeout);
          send({ type: 'ready' });
        } else if (message.type === 'capture-result' && typeof message.id === 'string' && typeof message.contentBase64 === 'string') {
          binding.complete(message.id, message.contentBase64);
        } else if (message.type === 'capture-error' && typeof message.id === 'string') {
          binding.fail(message.id);
        } else throw new Error('无效控制消息');
      } catch { ws.close(1008); }
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(authTimeout);
      clearInterval(heartbeat);
      binding?.detach();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.unref();
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve, reject) => {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close(() => server.close(error => error ? reject(error) : resolve()));
    }),
  };
}

const registry = globalThis as typeof globalThis & {
  __boxCreatorSceneSocket?: ReturnType<typeof createCreatorSceneWebSocketServer>;
};
export function ensureCreatorSceneWebSocketServer() {
  if (!registry.__boxCreatorSceneSocket) {
    registry.__boxCreatorSceneSocket = createCreatorSceneWebSocketServer(Number(process.env.BOX_CREATOR_SCENE_SOCKET_PORT || 9968))
      .catch(error => { registry.__boxCreatorSceneSocket = undefined; throw error; });
  }
  return registry.__boxCreatorSceneSocket;
}
