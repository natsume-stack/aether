import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';
import {
  creatorModelServiceError,
  creatorModelIdentityHeaders,
  requestCreatorModelService,
  sendCreatorModelServiceError,
} from '../../../server/creator-model-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'models.manage')) return;
  if (req.method !== 'PUT' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'PUT, DELETE');
    return res.status(405).end();
  }
  const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ message: '模型 ID 无效' });
  }

  try {
    const response = await requestCreatorModelService(`/api/local/models/${id}`, {
      method: req.method,
      headers: {
        ...creatorModelIdentityHeaders(req),
        ...(req.method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: req.method === 'PUT' ? JSON.stringify(req.body || {}) : undefined,
    });
    if (!response.ok) throw await creatorModelServiceError(response, req.method === 'DELETE' ? '删除模型失败' : '保存模型信息失败');
    const data = await response.json().catch(() => ({}));
    return res.status(response.status).json(data);
  } catch (error) {
    return sendCreatorModelServiceError(res, error);
  }
}
