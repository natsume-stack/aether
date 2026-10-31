import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthoringSession } from './authoring-session';

/** Read-only presentation stream. Slow/disconnected viewers never block writes. */
export function createAuthoringEventHandler(
  session: AuthoringSession,
  snapshot: () => Promise<Record<string, unknown>>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const peer = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer || '')) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    let data: Record<string, unknown>;
    try { data = await snapshot(); }
    catch { res.writeHead(503); res.end('State unavailable'); return; }
    if (res.destroyed) return;
    const lastId = String(req.headers['last-event-id'] || '');
    const split = lastId.lastIndexOf(':');
    const sameRuntime = split > 0 && lastId.slice(0, split) === session.runtimeId;
    const cursor = sameRuntime ? Number(lastId.slice(split + 1)) : 0;
    const history = session.events(Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      res.end();
    };
    const send = (payload: Record<string, unknown>, seq?: number) => {
      if (closed) return;
      // No unbounded per-viewer queue. EventSource resumes with Last-Event-ID.
      if (res.writableLength > 256 * 1024) { close(); return; }
      res.write(`${seq === undefined ? '' : `id: ${session.runtimeId}:${seq}\n`}data: ${JSON.stringify(payload)}\n\n`);
    };
    res.on('close', close);
    res.on('error', close);
    send({ ...data, type: 'snapshot', runtimeId: session.runtimeId, lastSeq: history.lastSeq,
      resetRequired: history.resetRequired || (!!lastId && !sameRuntime), historyLimit: 1000 });
    for (const row of history.events) send({ ...row, type: 'event', runtimeId: session.runtimeId }, row.seq);
    if (!closed) {
      unsubscribe = session.subscribe(row => send({ ...row, type: 'event', runtimeId: session.runtimeId }, row.seq));
      heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15_000);
      heartbeat.unref();
    }
  };
}
