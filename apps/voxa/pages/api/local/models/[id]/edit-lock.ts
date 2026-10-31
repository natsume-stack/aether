import type { NextApiRequest, NextApiResponse } from 'next';

import {
  acquireEditLock,
  getEditLock,
  normalizeEditLockActor,
  releaseEditLock,
} from '../../../../../server/local-voxa-edit-lock';
import { getModel } from '../../../../../server/local-voxa-store';
import { setLocalCors } from '../../../../../server/local-cors';
import { requireVoxaModelManagement } from '../../../../../server/model-management-access';

function requestActor(req: NextApiRequest) {
  return normalizeEditLockActor(
    req.body?.actor
      ?? req.query.actor
      ?? req.headers['x-voxa-actor'],
  );
}

function requestTTL(req: NextApiRequest) {
  return req.body?.ttlMs ?? req.query.ttlMs;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Voxa-Actor',
  );
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!await requireVoxaModelManagement(req, res)) return;

  const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).end();
  if (!getModel(id)) {
    return res.status(404).json({ code: 'MODEL_NOT_FOUND', message: '模型不存在' });
  }

  if (req.method === 'GET') {
    return res.status(200).json(getEditLock(id));
  }

  if (req.method === 'POST') {
    const actor = requestActor(req);
    if (!actor) {
      return res.status(400).json({ code: 'ACTOR_REQUIRED', message: '必须提供 actor' });
    }
    const result = acquireEditLock(id, actor, requestTTL(req));
    if (!result.acquired) {
      return res.status(409).json({
        code: 'EDIT_LOCKED',
        message: `模型正在由 ${result.lock.actor} 编辑`,
        editLock: result.lock,
      });
    }
    return res.status(200).json(result.lock);
  }

  if (req.method === 'DELETE') {
    const actor = requestActor(req);
    if (!actor) {
      return res.status(400).json({ code: 'ACTOR_REQUIRED', message: '必须提供 actor' });
    }
    const result = releaseEditLock(id, actor);
    if (!result.released) {
      return res.status(409).json({
        code: 'EDIT_LOCKED',
        message: `模型正在由 ${result.lock.actor} 编辑`,
        editLock: result.lock,
      });
    }
    return res.status(200).json(result.lock);
  }

  return res.status(405).end();
}
