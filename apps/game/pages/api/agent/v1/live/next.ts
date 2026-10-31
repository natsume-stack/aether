import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi, authenticatedCreatorIdentity } from '../../../../../server/creator-api-security';
import { pollEditor } from '../../../../../server/agent-live';
import { resolveLiveProject } from '../../../../../server/agent-live-http';

/**
 * GET /api/agent/v1/live/next?container=&sessionId=&after=
 *
 * Long poll (up to 20 s) used by the editor tab. Returns at most one command;
 * commands are executed strictly in sequence so the human can follow along.
 * Also serves as the session heartbeat.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!await authenticatedCreatorIdentity(req, res, 'projects.edit')) return;

  const project = resolveLiveProject(req.query.container);
  if (!project) {
    return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: '地图不存在' });
  }
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) {
    return res.status(400).json({ code: 'INVALID_SESSION', message: '缺少 sessionId；先 POST /live/attach' });
  }
  const after = Math.max(0, Number(req.query.after) || 0);
  const result = await pollEditor(project, sessionId, after);
  if (result.sessionInvalid) {
    return res.status(409).json({
      code: 'LIVE_SESSION_INVALID',
      message: '活体会话已失效（编辑器重载或已断开）',
      lastSeq: result.lastSeq,
    });
  }
  return res.status(200).json(result);
}
