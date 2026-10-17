import type { NextApiRequest, NextApiResponse } from 'next';
import { getLocalProjectManager } from '../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';
import { prewarmLocalRuntimes } from '../../../server/runtime-prewarm';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, req.method === 'POST' ? 'projects.create' : 'projects.view')) return;
  try {
    const manager = getLocalProjectManager();
    if (req.method === 'GET') return res.status(200).json({ projects: manager.listProjects() });
    if (req.method === 'POST') {
      const project = manager.createProject(req.body || {});
      void prewarmLocalRuntimes([project.id], ['edit', 'play']);
      return res.status(201).json({ project });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
