import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../../../server/creator-api-security';
import { getLocalProjectManager } from '../../../../../server/local-project-manager';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'projects.edit')) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const projectId = Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId;
  const name = Array.isArray(req.query.name) ? req.query.name[0] : req.query.name;
  if (!projectId || !name) return res.status(400).json({ message: '缺少工程或备份文件名' });
  try {
    const backup = getLocalProjectManager().resolveProjectBackup(projectId, name);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="backup.boxproject"; filename*=UTF-8''${encodeURIComponent(`${projectId}_${name}`)}`);
    res.setHeader('Content-Length', String(fs.statSync(backup.archivePath).size));
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(backup.archivePath).pipe(res);
    return undefined;
  } catch (error) {
    return res.status(404).json({ message: (error as Error).message || '工程备份不存在' });
  }
}
