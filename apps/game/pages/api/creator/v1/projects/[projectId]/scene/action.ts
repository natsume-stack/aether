import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticatedCreatorIdentity } from '../../../../../../../server/creator-api-security';
import { nextCreatorSceneAction } from '../../../../../../../server/creator-scene-session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  const identity = await authenticatedCreatorIdentity(req, res, 'projects.edit');
  if (!identity) return;
  const id = String(Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId || '').trim();
  const sessionId = String(req.headers['x-box-creator-scene-session'] || '');
  try {
    const action = nextCreatorSceneAction(id, sessionId, identity.subjectId);
    return action ? res.status(200).json(action) : res.status(204).end();
  } catch (error) {
    return res.status(409).json({ code: 'SCENE_SESSION_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) });
  }
}
