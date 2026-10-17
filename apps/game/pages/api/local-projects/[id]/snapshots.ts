import type { NextApiRequest, NextApiResponse } from 'next';
import { getLocalProjectManager } from '../../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../../server/creator-api-security';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, req.method === 'POST' ? 'projects.edit' : 'projects.view')) return;
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) return res.status(400).json({ message: 'Project ID is required' });

  try {
    const manager = getLocalProjectManager();
    if (req.method === 'GET') {
      return res.status(200).json({ snapshots: manager.listProjectSnapshots(id) });
    }
    if (req.method === 'POST') {
      const snapshot = typeof req.body?.snapshot === 'string' ? req.body.snapshot : '';
      if (!snapshot) return res.status(400).json({ message: 'Snapshot is required' });
      const recovery = manager.restoreProjectSnapshot(id, snapshot);
      if (!recovery.restored) return res.status(409).json({ message: '工程快照无法恢复' });
      return res.status(200).json({ recovery, project: manager.getProject(id) });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
