import type { NextApiRequest, NextApiResponse } from 'next';

import { listModels, saveModel } from '../../../../server/local-voxa-store';
import { setLocalCors } from '../../../../server/local-cors';
import {
  requireVoxaModelAccess,
  requireVoxaModelManagement,
} from '../../../../server/model-management-access';

function cors(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return false;
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!cors(req, res)) return res.status(403).end('仅允许本机访问');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    if (!await requireVoxaModelAccess(req, res, ['projects.edit', 'models.manage'])) return;
    const modelType = req.query.modelType === undefined
      ? undefined
      : Number(Array.isArray(req.query.modelType) ? req.query.modelType[0] : req.query.modelType);
    const mapId = req.query.mapId === undefined
      ? undefined
      : Number(Array.isArray(req.query.mapId) ? req.query.mapId[0] : req.query.mapId);
    const creativeMode = req.query.creativeMode === undefined
      ? undefined
      : Number(Array.isArray(req.query.creativeMode) ? req.query.creativeMode[0] : req.query.creativeMode);
    const modelName = req.query.modelName === undefined
      ? undefined
      : String(Array.isArray(req.query.modelName) ? req.query.modelName[0] : req.query.modelName);
    const rows = listModels({ modelType, mapId, creativeMode, modelName });
    return res.status(200).json({ rows, count: rows.length });
  }
  if (req.method === 'POST') {
    if (!await requireVoxaModelManagement(req, res)) return;
    return res.status(200).json(await saveModel(req.body || {}));
  }
  return res.status(405).end();
}
