import type { NextApiRequest, NextApiResponse } from 'next';
import { allowAuthenticatedCreatorCliApi } from '../../../../../server/creator-api-security';
import { getLocalProjectManager } from '../../../../../server/local-project-manager';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!await allowAuthenticatedCreatorCliApi(req, res, 'projects.list')) return;
  try {
    const projects = getLocalProjectManager().listProjects().map((project: Record<string, unknown>) => ({
      permanentMapId: project.permanentMapId,
      name: project.name,
      description: project.description,
      status: project.status,
      updatedAt: project.updatedAtISO,
      mapRole: project.mapRole,
      mainProjectId: project.mainProjectId,
    }));
    return res.status(200).json({ projects });
  } catch (error) {
    return res.status(500).json({ code: 'PROJECT_LIST_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
}
