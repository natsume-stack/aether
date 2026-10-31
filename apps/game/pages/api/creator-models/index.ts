import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';
import {
  creatorModelIdentityHeaders,
  creatorModelServiceError,
  requestCreatorModelService,
  sendCreatorModelServiceError,
} from '../../../server/creator-model-service';

type ModelRow = {
  modelPreviewHash?: string;
  modelPreviewUrl?: string;
  [key: string]: unknown;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Editors place existing models; model managers operate the library. Either
  // capability may read metadata and preview assets, but mutations stay gated.
  if (!await allowAuthenticatedCreatorApi(req, res, ['projects.edit', 'models.manage'])) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }

  try {
    // Keep browser model requests same-origin with Creator.  Directly using
    // VOXA_URL from the browser breaks as soon as the public port/host differs
    // from the value baked into an older image (and is especially common on
    // LAN deployments).  The server already has the internal VOXA address.
    const query = new URLSearchParams();
    for (const key of ['modelType', 'mapId', 'creativeMode', 'modelName']) {
      const value = req.query[key];
      if (value !== undefined) query.set(key, String(Array.isArray(value) ? value[0] : value));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await requestCreatorModelService(`/api/local/models${suffix}`, {
      headers: creatorModelIdentityHeaders(req),
    });
    if (!response.ok) throw await creatorModelServiceError(response, '无法读取模型列表');
    const data = await response.json() as { rows?: ModelRow[]; count?: number };
    const rows = (data.rows || []).map((model) => ({
      ...model,
      modelPreviewUrl: model.modelPreviewHash
        ? `/api/creator-models/blobs/${encodeURIComponent(model.modelPreviewHash)}`
        : '',
    }));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      rows,
      count: rows.length,
      service: { state: 'ready' },
    });
  } catch (error) {
    return sendCreatorModelServiceError(res, error);
  }
}
