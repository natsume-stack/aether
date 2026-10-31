import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';
import {
  creatorModelIdentityHeaders,
  creatorModelServiceError,
  requestCreatorModelService,
  sendCreatorModelServiceError,
} from '../../../server/creator-model-service';

export const config = { api: { bodyParser: false, responseLimit: false } };

async function readBody(req: NextApiRequest) {
  const chunks: Buffer[] = [];
  const maximumBytes = Number(process.env.VOXA_MAX_BLOB_BYTES || 268435456);
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maximumBytes) throw new Error('MODEL_IMPORT_TOO_LARGE');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, ['models.manage', 'voxa.edit'])) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const body = await readBody(req);
    if (!body.length) return res.status(400).json({ message: '模型工程文件为空' });
    const response = await requestCreatorModelService('/api/local/models/import', {
      method: 'POST',
      headers: {
        ...creatorModelIdentityHeaders(req),
        'Content-Type': String(req.headers['content-type'] || 'application/octet-stream'),
      },
      body,
    }, 120_000);
    if (!response.ok) throw await creatorModelServiceError(response, '导入模型工程失败');
    return res.status(response.status).json(await response.json());
  } catch (error) {
    if ((error as Error).message === 'MODEL_IMPORT_TOO_LARGE') {
      return res.status(413).json({ message: '模型工程文件超过大小限制' });
    }
    return sendCreatorModelServiceError(res, error);
  }
}
