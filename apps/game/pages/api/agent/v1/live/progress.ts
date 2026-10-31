import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi, authenticatedCreatorIdentity } from '../../../../../server/creator-api-security';
import { progressEditor } from '../../../../../server/agent-live';
import { resolveLiveProject } from '../../../../../server/agent-live-http';

/**
 * POST /api/agent/v1/live/progress
 * body: { container, sessionId, snapshot, note? }
 *
 * Heartbeat + in-flight progress. Long batches call this every few blocks so
 * the human panel can say what the AI is doing right now, not only after the
 * whole command finishes.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!await authenticatedCreatorIdentity(req, res, 'projects.edit')) return;

  const project = resolveLiveProject(req.body?.container);
  if (!project) {
    return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: '地图不存在' });
  }
  const sessionId = String(req.body?.sessionId || '');
  const snapshot = req.body?.snapshot;
  if (!sessionId || typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return res.status(400).json({ code: 'INVALID_BODY', message: 'body 必须包含 sessionId 与 snapshot 对象' });
  }
  const accepted = progressEditor(project, sessionId, snapshot, String(req.body?.note || '').slice(0, 200));
  if (!accepted) {
    return res.status(409).json({ code: 'LIVE_SESSION_INVALID', message: '活体会话已失效' });
  }
  return res.status(200).json({ ok: true });
}
