import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';

import { getLocalProjectManager } from '../../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../../server/creator-api-security';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'projects.export')) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) return res.status(400).json({ message: 'Project ID is required' });
  const scope = Array.isArray(req.query.scope) ? req.query.scope[0] : req.query.scope;
  if (scope !== 'map' && scope !== 'group') {
    return res.status(400).json({ message: '导出范围必须是 map 或 group' });
  }
  try {
    const archive = getLocalProjectManager().exportProject(id, { scope });
    const cleanup = () => {
      fs.rmSync(archive.archivePath, { force: true });
    };
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="project.boxproject"; filename*=UTF-8''${encodeURIComponent(archive.filename)}`);
    res.setHeader('Content-Length', String(fs.statSync(archive.archivePath).size));
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(archive.archivePath);
    stream.on('error', () => {
      cleanup();
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.on('close', cleanup);
    res.on('close', cleanup);
    stream.pipe(res);
    return undefined;
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
