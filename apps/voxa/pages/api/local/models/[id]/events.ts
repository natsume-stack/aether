import type { NextApiRequest, NextApiResponse } from 'next';

import { getModel } from '../../../../../server/local-voxa-store';
import { setLocalCors } from '../../../../../server/local-cors';
import { requireVoxaModelAccess } from '../../../../../server/model-management-access';

/**
 * Server-sent revision feed. The editor keeps an EventSource open while a
 * model is loaded and reloads the project whenever a CLI bumps the revision.
 *
 * A 1s filesystem poll is used instead of an in-process emitter so several
 * Next workers (or a `next dev` restart) still observe each other's writes.
 */
const REVISION_POLL_MS = 1000;
const HEARTBEAT_MS = 15000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();
  if (!await requireVoxaModelAccess(req, res, ['projects.edit', 'models.manage', 'voxa.edit'])) return;

  const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).end();
  if (!getModel(id)) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.status(200);
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }
  if (typeof (req as any).socket?.setNoDelay === 'function') {
    (req as any).socket.setNoDelay(true);
  }

  let lastRevision = -1;
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  };

  const sendRevision = () => {
    if (closed) return;
    const model = getModel(id);
    if (!model) {
      cleanup();
      res.end();
      return;
    }
    const revision = model.revision || 0;
    if (revision === lastRevision) return;
    lastRevision = revision;
    res.write(`data: ${JSON.stringify({
      revision,
      actor: model.lastEditActor || '',
      at: model.updatedAt,
    })}\n\n`);
  };

  // The first event establishes the client baseline; the editor must not
  // reload on connect, only on later revision changes.
  sendRevision();
  pollTimer = setInterval(sendRevision, REVISION_POLL_MS);
  heartbeatTimer = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);

  if (typeof (pollTimer as any)?.unref === 'function') (pollTimer as any).unref();
  if (typeof (heartbeatTimer as any)?.unref === 'function') (heartbeatTimer as any).unref();
}
