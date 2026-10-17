import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../../server/creator-api-security';
import {
  creatorModelIdentityHeaders,
  creatorModelServiceError,
  requestCreatorModelService,
  sendCreatorModelBinaryResponse,
  sendCreatorModelServiceError,
} from '../../../../server/creator-model-service';

export const config = { api: { responseLimit: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'models.manage')) return;
  if (req.method !== 'GET') return res.status(405).end();
  const id = Number(Array.isArray(req.query.id) ? req.query.id[0] : req.query.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: '模型 ID 无效' });
  try {
    const response = await requestCreatorModelService(`/api/local/models/${id}/export`, {
      headers: creatorModelIdentityHeaders(req),
    }, 120_000);
    if (!response.ok) throw await creatorModelServiceError(response, '导出模型工程失败');
    return await sendCreatorModelBinaryResponse(res, response);
  } catch (error) {
    return sendCreatorModelServiceError(res, error);
  }
}
