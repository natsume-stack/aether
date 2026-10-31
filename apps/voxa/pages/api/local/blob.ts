import type { NextApiRequest, NextApiResponse } from 'next';

import { storeBlob } from '../../../server/local-voxa-store';
import { setLocalCors } from '../../../server/local-cors';
import { requireVoxaModelManagement } from '../../../server/model-management-access';

export const config = {
  api: { bodyParser: false },
};

async function readBody(req: NextApiRequest) {
  const chunks: Buffer[] = [];
  const maximumBytes = Number(process.env.VOXA_MAX_BLOB_BYTES || 268435456);
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) throw new Error('VOXA_BLOB_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  if (!await requireVoxaModelManagement(req, res)) return;
  let data: Buffer;
  try {
    data = await readBody(req);
  } catch (error) {
    if ((error as Error).message === 'VOXA_BLOB_TOO_LARGE') {
      return res.status(413).json({ message: '文件超过本地 VOXA 大小限制' });
    }
    throw error;
  }
  if (!data.length) return res.status(400).json({ message: '文件内容为空' });
  const hash = await storeBlob(data, String(req.headers['content-type'] || ''));
  return res.status(201).json({ hash });
}
