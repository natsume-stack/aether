import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi, authenticatedCreatorIdentity } from '../../../../../server/creator-api-security';
import { attachEditor } from '../../../../../server/agent-live';
import { resolveLiveProject } from '../../../../../server/agent-live-http';

/**
 * POST /api/agent/v1/live/attach  body: { container, snapshot? }
 *
 * Called by the editor tab when it is ready to be driven. One editor session
 * per map; a new attach replaces the previous tab and fails its pending
 * commands with EDITOR_REATTACHED.
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
  const snapshot = req.body?.snapshot;
  if (snapshot !== undefined && (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot))) {
    return res.status(400).json({ code: 'INVALID_SNAPSHOT', message: 'snapshot 必须是对象' });
  }
  const attached = attachEditor(project, { snapshot });
  return res.status(200).json({
    ok: true,
    projectId: project,
    sessionId: attached.sessionId,
    lastSeq: attached.lastSeq,
    attachedAt: attached.attachedAt,
    replacedSessionId: attached.replacedSessionId,
  });
}
