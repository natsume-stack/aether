import type { NextApiRequest, NextApiResponse } from 'next';
import { isInternalIdentityRequest, playerMapLibrary, updatePlayerMapLibrary } from '../../../server/local-player-identity';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (!isInternalIdentityRequest(req)) return res.status(401).json({ message: '玩家身份服务内部鉴权失败' });
  try {
    if (req.method === 'GET') return res.status(200).json(await playerMapLibrary(req, res));
    if (req.method === 'PATCH') {
      const { mapId, favorite, played } = req.body || {};
      await updatePlayerMapLibrary(req, res, String(mapId || ''), { favorite: typeof favorite === 'boolean' ? favorite : undefined, played: played === true });
      return res.status(204).end();
    }
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).end();
  } catch (error) {
    return res.status((error as Error).message === 'AUTH_REQUIRED' ? 401 : 400).json({ message: (error as Error).message });
  }
}
