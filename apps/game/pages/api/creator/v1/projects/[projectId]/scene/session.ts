import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticatedCreatorIdentity } from '../../../../../../../server/creator-api-security';
import { ensureCreatorSceneWebSocketServer } from '../../../../../../../server/creator-scene-websocket';
import {
  creatorSceneSessionStatus,
  disableCreatorSceneSession,
  enableCreatorSceneSession,
} from '../../../../../../../server/creator-scene-session';

function projectId(value: string | string[] | undefined) {
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const identity = await authenticatedCreatorIdentity(req, res, 'projects.edit');
  if (!identity) return;
  const id = projectId(req.query.projectId);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  if (req.method === 'POST') {
    try {
      await ensureCreatorSceneWebSocketServer();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        ...enableCreatorSceneSession(id, identity.subjectId, req.headers.host),
        socketPath: '/api/creator/v1/scene/socket',
      });
    } catch {
      return res.status(503).json({ code: 'SCENE_SOCKET_UNAVAILABLE', message: '场景控制连接不可用' });
    }
  }
  const sessionId = String(req.headers['x-box-creator-scene-session'] || '');
  if (req.method === 'GET') return res.status(200).json({ active: creatorSceneSessionStatus(id, sessionId, identity.subjectId) });
  if (req.method === 'DELETE') return res.status(disableCreatorSceneSession(id, sessionId, identity.subjectId) ? 200 : 409).json({ closed: true });
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).end();
}
