import type { NextApiRequest, NextApiResponse } from 'next';

import { getSnapshots } from '../../../../../server/local-voxa-store';
import { setLocalCors } from '../../../../../server/local-cors';
import { requireVoxaModelManagement } from '../../../../../server/model-management-access';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();
  if (!await requireVoxaModelManagement(req, res)) return;
  const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const snapshots = getSnapshots(
    Number(rawId),
    String(req.query.autoSave || '') === 'true',
  );
  return snapshots ? res.status(200).json(snapshots) : res.status(404).end();
}
