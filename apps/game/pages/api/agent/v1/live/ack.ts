import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi, authenticatedCreatorIdentity } from '../../../../../server/creator-api-security';
import type { LiveAck } from '../../../../../server/agent-live';
import { acknowledgeCommand } from '../../../../../server/agent-live';
import { resolveLiveProject } from '../../../../../server/agent-live-http';

/**
 * POST /api/agent/v1/live/ack
 * body: { container, sessionId, id, ok, result?, error?, snapshot? }
 *
 * The editor calls this after executing (or refusing) one command. Every ack
 * carries a fresh perception snapshot, which is what the agent reads next.
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
  const id = String(req.body?.id || '');
  if (!sessionId || !id) {
    return res.status(400).json({ code: 'INVALID_ACK', message: 'body 必须包含 sessionId 与 id' });
  }
  const ack: LiveAck = {
    id,
    ok: req.body?.ok !== false,
    result: req.body?.result,
    error: req.body?.error,
    snapshot: req.body?.snapshot,
    at: String(req.body?.at || new Date().toISOString()),
  };
  const accepted = acknowledgeCommand(project, sessionId, ack);
  if (!accepted) {
    return res.status(409).json({ code: 'LIVE_SESSION_INVALID', message: '活体会话已失效' });
  }
  return res.status(200).json({ ok: true });
}
