import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticatedCreatorIdentity } from '../../../../../../../../server/creator-api-security';
import { completeCreatorSceneCapture } from '../../../../../../../../server/creator-scene-session';

// A 6 MiB PNG expands to exactly 8 MiB as Base64, plus JSON framing.
export const config = { api: { bodyParser: { sizeLimit: '9mb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const identity = await authenticatedCreatorIdentity(req, res, 'projects.edit');
  if (!identity) return;
  const projectId = String(Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId || '').trim();
  const requestId = String(Array.isArray(req.query.requestId) ? req.query.requestId[0] : req.query.requestId || '').trim();
  const sessionId = String(req.headers['x-box-creator-scene-session'] || '');
  try {
    completeCreatorSceneCapture(projectId, sessionId, requestId, identity.subjectId, String(req.body?.contentBase64 || ''));
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(409).json({ code: 'SCENE_CAPTURE_REJECTED', message: error instanceof Error ? error.message : String(error) });
  }
}
