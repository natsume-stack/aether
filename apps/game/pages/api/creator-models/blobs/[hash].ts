import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../../server/creator-api-security';
import {
  creatorModelIdentityHeaders,
  creatorModelServiceError,
  requestCreatorModelService,
  sendCreatorModelBinaryResponse,
  sendCreatorModelServiceError,
} from '../../../../server/creator-model-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, ['projects.edit', 'models.manage'])) return;
  if (req.method !== 'GET') return res.status(405).end();
  const hash = String(Array.isArray(req.query.hash) ? req.query.hash[0] : req.query.hash || '');
  if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(hash)) {
    return res.status(400).json({ message: '资源哈希无效' });
  }
  try {
    const response = await requestCreatorModelService(`/api/local/blobs/${encodeURIComponent(hash)}`, {
      headers: creatorModelIdentityHeaders(req),
    });
    if (!response.ok) throw await creatorModelServiceError(response, '模型预览不存在');
    return await sendCreatorModelBinaryResponse(res, response);
  } catch (error) {
    return sendCreatorModelServiceError(res, error);
  }
}
