import type { NextApiRequest, NextApiResponse } from 'next';
import { allowAuthenticatedCreatorCliApi } from '../../../../../../server/creator-api-security';
import { getLocalProjectManager } from '../../../../../../server/local-project-manager';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  if (!await allowAuthenticatedCreatorCliApi(req, res, 'resources.list')) return;
  try {
    const projectId = String(Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId || '');
    return res.status(200).json(getLocalProjectManager().getProjectResources(projectId));
  } catch (error) {
    return res.status(404).json({ code: 'RESOURCE_MANIFEST_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
}
