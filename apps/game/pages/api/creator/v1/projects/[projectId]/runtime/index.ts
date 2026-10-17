import type { NextApiRequest, NextApiResponse } from 'next';
import { allowAuthenticatedCreatorCliApi } from '../../../../../../../server/creator-api-security';
import { requestCreatorPreviewRuntime } from '../../../../../../../server/creator-preview-runtime';

function projectId(value: string | string[] | undefined) {
  const id = Array.isArray(value) ? value[0] : value;
  return String(id || '').trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }
  const capability = req.method === 'POST' ? 'runtime.control' : 'runtime.view';
  if (!await allowAuthenticatedCreatorCliApi(req, res, capability)) return;
  const id = projectId(req.query.projectId);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  try {
    const data = await requestCreatorPreviewRuntime(id, req.method === 'POST'
      ? { method: 'POST', body: req.body }
      : undefined);
    return res.status(200).json(data);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode || 502;
    return res.status(statusCode).json({ code: 'RUNTIME_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
}
