import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi } from '../../../../../../../server/creator-api-security';
import {
  authenticateMapAgent,
  recordMapAgentAction,
} from '../../../../../../../server/agent-access';
import { dispatchCommand, liveStatus } from '../../../../../../../server/agent-live';
import { agentAuthError, resolveLiveProject } from '../../../../../../../server/agent-live-http';

/**
 * GET /api/agent/v1/live/map/<projectId>/status
 *
 * Attachment + last action + last perception snapshot. No editor action is
 * queued, so this is safe to poll while deciding what to do next.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }

  const reference = resolveLiveProject(
    Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId,
  );
  if (!reference) {
    return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: '地图不存在' });
  }
  const auth = authenticateMapAgent(reference, req.headers.authorization);
  if (!auth.ok) {
    const failure = agentAuthError(auth.code);
    return res.status(failure.status).json(failure.body);
  }

  let status = liveStatus(reference);
  if (!status.attached) {
    // The status call is also a cheap way to prove the editor is alive. It
    // does not dispatch a command, so an unattached editor simply stays null.
    await recordMapAgentAction(reference, auth.agent.id, {
      action: 'live:status',
      result: 'applied',
      detail: status.stale ? '编辑器心跳超时' : '当前没有打开的编辑器',
    });
  }
  return res.status(200).json({ ok: true, ...status });
}
