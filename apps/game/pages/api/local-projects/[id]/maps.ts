import type { NextApiRequest, NextApiResponse } from 'next';
import { getLocalProjectManager } from '../../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../../server/creator-api-security';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, req.method === 'POST' ? 'projects.create' : 'projects.view')) return;
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) return res.status(400).json({ message: 'Project ID is required' });
  try {
    const manager = getLocalProjectManager();
    if (req.method === 'GET') return res.status(200).json({ maps: manager.listMapGroup(id) });
    if (req.method === 'POST') {
      return res.status(201).json({ map: manager.createSubmap(id, req.body || {}) });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
