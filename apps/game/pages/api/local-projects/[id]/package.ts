import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getLocalProjectManager } from '../../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../../server/creator-api-security';

export const config = {
  api: {
    // Project packages are intentionally streamed and commonly exceed the
    // API Routes advisory default of 4 MB.
    responseLimit: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'projects.export')) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const version = req.body?.version;
  if (!id || typeof version !== 'string') {
    return res.status(400).json({ message: 'Project ID and release version are required' });
  }
  try {
    const manager = getLocalProjectManager();
    const assetMode = req.body?.assetMode === 'oss' ? 'oss' : 'local';
    const bundle = await manager.exportPlayBundle(`${id}@${version}`, { assetMode });
    const cleanup = () => {
      fs.rmSync(bundle.archivePath, { force: true });
      fs.rmSync(bundle.temporaryRoot, { recursive: true, force: true });
    };
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="world.boxplay"; filename*=UTF-8''${encodeURIComponent(bundle.filename)}`);
    res.setHeader('Content-Length', String(fs.statSync(bundle.archivePath).size));
    res.setHeader('X-Box-Map-Count', String(bundle.mapCount || 1));
    res.setHeader('X-Box-Map-Group-Id', bundle.mapGroupId || id);
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(bundle.archivePath);
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
