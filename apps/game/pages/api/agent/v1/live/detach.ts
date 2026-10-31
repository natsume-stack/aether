import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi } from '../../../../../server/creator-api-security';
import { detachEditor } from '../../../../../server/agent-live';
import { resolveLiveProject } from '../../../../../server/agent-live-http';

/**
 * POST /api/agent/v1/live/detach  body: { container, sessionId }
 *
 * Best-effort teardown from the editor tab. The same session is also dropped
 * implicitly when the tab stops polling or a new tab attaches.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const project = resolveLiveProject(req.body?.container);
  const sessionId = String(req.body?.sessionId || '');
  if (!project || !sessionId) {
    return res.status(400).json({ code: 'INVALID_BODY', message: 'body 必须包含 container 与 sessionId' });
  }
  const detached = detachEditor(project, sessionId);
  return res.status(200).json({ ok: true, detached });
}
