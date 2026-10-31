import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi, authenticatedCreatorIdentity } from '../../../../../server/creator-api-security';
import { liveStatus } from '../../../../../server/agent-live';
import { resolveLiveProject } from '../../../../../server/agent-live-http';

/**
 * GET /api/agent/v1/live/status?container=
 *
 * Human panel view: attached or not, current action, last perception snapshot.
 * The join code itself lives in /live/manifest and the existing Agent state
 * route, not here.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!await authenticatedCreatorIdentity(req, res, 'projects.view')) return;

  const project = resolveLiveProject(req.query.container);
  if (!project) {
    return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: '地图不存在' });
  }
  return res.status(200).json({ ok: true, ...liveStatus(project) });
}
