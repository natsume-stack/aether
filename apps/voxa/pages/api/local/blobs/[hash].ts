import type { NextApiRequest, NextApiResponse } from 'next';

import { getBlob } from '../../../../server/local-voxa-store';
import { setLocalCors } from '../../../../server/local-cors';
import { requireVoxaModelAccess } from '../../../../server/model-management-access';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();
  if (!await requireVoxaModelAccess(req, res, ['projects.edit', 'models.manage'])) return;
  const hash = Array.isArray(req.query.hash) ? req.query.hash[0] : req.query.hash;
  const blob = hash ? getBlob(hash) : null;
  if (!blob) return res.status(404).end('文件不存在');
  res.setHeader('Content-Type', blob.contentType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.status(200).send(blob.data);
}
