import { randomUUID } from 'node:crypto';

type Binding = { message?: (value: any) => void; close: () => void };
type Grant = { host: string; expires: number; attach: (send: (value: object) => void) => Binding };
const state = globalThis as typeof globalThis & { __boxRealtimeTickets?: Map<string, Grant> };
const grants = state.__boxRealtimeTickets ||= new Map<string, Grant>();
export function issueRealtimeTicket(host: string, attach: Grant['attach']) {
  for (const [id, grant] of grants) if (grant.expires <= Date.now()) grants.delete(id);
  if (grants.size >= 1024) throw new Error('实时连接请求过多');
  const ticket = randomUUID();
  grants.set(ticket, { host, expires: Date.now() + 30_000, attach });
  return { ticket, socketPath: '/api/realtime/socket' };
}
export function consumeRealtimeTicket(ticket: string, host: string) {
  const grant = grants.get(ticket);
  if (!grant || grant.expires <= Date.now() || grant.host !== host) throw new Error('实时连接未授权');
  grants.delete(ticket);
  return grant.attach;
}
export function handleRealtimeSocket(ws: any, req: any) {
  let binding: Binding | undefined;
  let host = 'internal';
  try { if (req.headers.origin) host = new URL(req.headers.origin).host; } catch { ws.close(1008); return; }
  const auth = setTimeout(() => ws.close(1008), 5_000); auth.unref?.();
  const expiry = setTimeout(() => ws.close(1000), 15 * 60_000); expiry.unref?.();
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false; ws.ping();
  }, 30_000); heartbeat.unref?.();
  const send = (value: object) => {
    if (ws.readyState !== 1 || ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify(value));
  };
  ws.on('message', (data: Buffer) => {
    try {
      if (data.length > 16384) throw new Error('消息过大');
      const value = JSON.parse(String(data));
      if (!binding) {
        if (value.type !== 'connect' || typeof value.ticket !== 'string') throw new Error('连接未授权');
        const attach = consumeRealtimeTicket(value.ticket, host);
        clearTimeout(auth);
        binding = attach(send);
        send({ type: 'ready' });
      } else if (binding.message) binding.message(value);
      else throw new Error('不支持客户端操作');
    } catch { ws.close(1008); }
  });
  ws.on('error', () => ws.terminate());
  ws.on('close', () => { clearTimeout(auth); clearTimeout(expiry); clearInterval(heartbeat); binding?.close(); });
}
