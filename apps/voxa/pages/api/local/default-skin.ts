import type { NextApiRequest, NextApiResponse } from 'next';

import {
  getDefaultSkin,
  setDefaultSkin,
} from '../../../server/local-voxa-store';
import { setLocalCors } from '../../../server/local-cors';
import { requireVoxaModelAccess } from '../../../server/model-management-access';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'PUT') return res.status(405).end();
  if (!await requireVoxaModelAccess(req, res, 'projects.edit')) return;

  const queryProjectKey = Array.isArray(req.query.projectKey)
    ? req.query.projectKey[0]
    : req.query.projectKey;
  const queryMapId = Array.isArray(req.query.mapId)
    ? req.query.mapId[0]
    : req.query.mapId;
  const rawScope =
    queryProjectKey ?? req.body?.projectKey ?? queryMapId ?? req.body?.mapId;
  const scope = String(rawScope ?? '').trim();
  if (!scope || scope.length > 200) {
    return res.status(400).json({ message: 'Invalid project scope' });
  }

  if (req.method === 'GET') {
    return res.status(200).json(getDefaultSkin(scope));
  }
  if (req.method === 'PUT') {
    const skinId = Number(req.body?.skinId || 0);
    const success = await setDefaultSkin(scope, skinId);
    return success
      ? res.status(200).json(true)
      : res.status(404).json({ message: 'Skin not found' });
  }
  return res.status(405).end();
}
