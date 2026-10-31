import type { NextApiRequest, NextApiResponse } from 'next';
import { getLocalProjectManager } from '../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';

// Two 3 MiB images expand to roughly 8 MiB after base64 encoding in JSON.
export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    responseLimit: '10mb',
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (
    !(await allowAuthenticatedCreatorApi(
      req,
      res,
      req.method === 'DELETE'
        ? 'projects.delete'
        : req.method === 'PATCH'
          ? 'projects.edit'
          : 'projects.view',
    ))
  )
    return;
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) return res.status(400).json({ message: 'Project ID is required' });
  try {
    const manager = getLocalProjectManager();
    if (req.method === 'PATCH')
      return res.status(200).json({ project: manager.updateProject(id, req.body || {}) });
    if (req.method === 'DELETE') {
      manager.deleteProject(id);
      return res.status(204).end();
    }
    res.setHeader('Allow', 'PATCH, DELETE');
    return res.status(405).end();
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
