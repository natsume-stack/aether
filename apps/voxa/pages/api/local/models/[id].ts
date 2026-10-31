import type { NextApiRequest, NextApiResponse } from 'next';

import {
  deleteModel,
  getModel,
  updateModelInfo,
} from '../../../../server/local-voxa-store';
import {
  clearEditLock,
  getEditLock,
  normalizeEditLockActor,
} from '../../../../server/local-voxa-edit-lock';
import { setLocalCors } from '../../../../server/local-cors';
import {
  requireVoxaModelAccess,
  requireVoxaModelManagement,
} from '../../../../server/model-management-access';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).end();
  if (req.method === 'GET') {
    if (!await requireVoxaModelAccess(req, res, ['projects.edit', 'models.manage', 'voxa.edit'])) return;
    const model = getModel(id);
    return model ? res.status(200).json(model) : res.status(404).end();
  }
  if (req.method === 'PUT' || req.method === 'DELETE') {
    const lock = getEditLock(id);
    const actor = normalizeEditLockActor(req.body?.actor);
    if (lock.locked && lock.actor !== actor) {
      return res.status(409).json({
        code: 'EDIT_LOCKED',
        message: `模型正在由 ${lock.actor} 编辑`,
        editLock: lock,
      });
    }
  }
  if (req.method === 'PUT') {
    if (!await requireVoxaModelAccess(req, res, ['voxa.edit', 'models.manage'])) return;
    const updated = await updateModelInfo(id, {
      modelName: String(req.body?.modelName || ''),
      modelDescription: String(req.body?.modelDescription || ''),
    });
    return res.status(updated ? 200 : 404).json(updated);
  }
  if (req.method === 'DELETE') {
    if (!await requireVoxaModelManagement(req, res)) return;
    const deleted = await deleteModel(id);
    if (deleted) clearEditLock(id);
    return res.status(deleted ? 200 : 404).json(deleted);
  }
  return res.status(405).end();
}
