import {flushActiveEditor} from '../../../../server/local-project-publication';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getLocalProjectManager } from '../../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../../server/creator-api-security';


export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'projects.edit')) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) return res.status(400).json({ message: 'Project ID is required' });
  try {
    const manager = getLocalProjectManager();
    const members = manager.listMapGroup(id);
    await Promise.all(members.map((member) => flushActiveEditor(member.id)));
    return res.status(201).json({
      release: manager.publishMapGroup(id, req.body?.version, req.body?.notes),
    });
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
