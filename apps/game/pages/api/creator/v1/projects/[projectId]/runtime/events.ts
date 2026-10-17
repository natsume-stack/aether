import type { NextApiRequest, NextApiResponse } from 'next';
import { allowAuthenticatedCreatorCliApi } from '../../../../../../../server/creator-api-security';
import { pipeCreatorPreviewRuntimeEvents } from '../../../../../../../server/creator-preview-runtime';

export const config = { api: { bodyParser: false, responseLimit: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  if (!await allowAuthenticatedCreatorCliApi(req, res, 'runtime.view')) return;
  const raw = Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId;
  const projectId = String(raw || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  pipeCreatorPreviewRuntimeEvents(projectId, res);
}
