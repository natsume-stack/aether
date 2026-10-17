import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';

import { getPlayBundleReviewResource } from '../../../server/play-admin';
import { allowPlayLibraryAdmin } from '../../../server/play-admin-security';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!allowPlayLibraryAdmin(req, res)) return;

  const reviewId = typeof req.query.reviewId === 'string' ? req.query.reviewId : '';
  const resourceId = typeof req.query.resourceId === 'string' ? req.query.resourceId : '';
  if (!reviewId || !resourceId) return res.status(400).json({ message: '缺少审查资源参数' });

  try {
    const { path, resource } = getPlayBundleReviewResource(reviewId, resourceId);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', resource.kind === 'script' ? 'text/plain; charset=utf-8' : resource.mimeType);
    res.setHeader('Content-Length', resource.bytes);
    res.setHeader('Content-Disposition', 'inline');
    return fs.createReadStream(path).pipe(res);
  } catch (error) {
    return res.status(404).json({ message: error instanceof Error ? error.message : '审查资源无法读取' });
  }
}
