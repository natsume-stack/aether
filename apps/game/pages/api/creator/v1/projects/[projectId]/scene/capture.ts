import type { NextApiRequest, NextApiResponse } from 'next';
import { allowAuthenticatedCreatorCliApi } from '../../../../../../../server/creator-api-security';
import { requestCreatorSceneCapture, type CreatorSceneCaptureView } from '../../../../../../../server/creator-scene-session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  if (!await allowAuthenticatedCreatorCliApi(req, res, 'scene.capture')) return;
  const projectId = String(Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  const requestedView = Array.isArray(req.query.view) ? req.query.view[0] : req.query.view;
  let view: CreatorSceneCaptureView | undefined;
  if (requestedView === undefined || requestedView === 'full') view = 'full';
  if (requestedView === '3d') view = '3d';
  if (requestedView === '2d') view = '2d';
  if (!view) return res.status(400).json({ code: 'INVALID_CAPTURE_VIEW', message: '截图视图只能是 3d 或 2d' });
  try {
    const capture = await requestCreatorSceneCapture(projectId, view);
    res.setHeader('Content-Type', capture.contentType);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(capture.content);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode || 409;
    return res.status(status).json({ code: 'SCENE_CAPTURE_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
}
