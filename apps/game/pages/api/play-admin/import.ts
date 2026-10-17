import fs from 'fs';
import os from 'os';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  cancelPlayBundleReview,
  confirmPlayBundleReview,
  createPlayBundleReview,
  getPlayBundleReviewResource,
  importPlayBundle,
} from '../../../server/play-admin';
import { allowPlayLibraryAdmin } from '../../../server/play-admin-security';
import { prewarmLocalRuntimes } from '../../../server/runtime-prewarm';
import { serializeImportError } from '../../../server/import-diagnostics';

export const config = { api: { bodyParser: false } };
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).end();
  }
  if (!allowPlayLibraryAdmin(req, res)) return;

  const reviewId = typeof req.query.reviewId === 'string' ? req.query.reviewId : '';
  const mode = typeof req.query.mode === 'string' ? req.query.mode : '';
  if (req.method === 'GET') {
    if (mode !== 'resource' || !reviewId) {
      return res.status(400).json({ message: '缺少审查资源参数' });
    }
    const resourceId = typeof req.query.resourceId === 'string' ? req.query.resourceId : '';
    if (!resourceId) return res.status(400).json({ message: '缺少审查资源参数' });
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
  if (req.method === 'DELETE') {
    if (!reviewId) return res.status(400).json({ message: '缺少游玩包审查 ID' });
    cancelPlayBundleReview(reviewId);
    return res.status(204).end();
  }

  if (mode === 'confirm') {
    if (!reviewId) return res.status(400).json({ message: '缺少游玩包审查 ID' });
    try {
      const imported = confirmPlayBundleReview(reviewId);
      void prewarmLocalRuntimes(imported.worlds.map((world) => world.id), ['play']);
      return res.status(201).json(imported);
    } catch (error) {
      return res.status(400).json(serializeImportError(error));
    }
  }

  const temporaryPath = path.join(os.tmpdir(), `box-play-upload-${process.pid}-${Date.now()}.boxplay`);
  let receivedBytes = 0;
  try {
    await pipeline(
      req,
      new Transform({
        transform(chunk, _encoding, callback) {
          receivedBytes += chunk.length;
          callback(receivedBytes > MAX_ARCHIVE_BYTES ? new Error('游玩包不能超过 1GB') : undefined, chunk);
        },
      }),
      fs.createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    if (mode === 'preview') {
      const review = await createPlayBundleReview(temporaryPath);
      return res.status(201).json({ review });
    }
    const imported = await importPlayBundle(temporaryPath);
    void prewarmLocalRuntimes(imported.worlds.map((world) => world.id), ['play']);
    return res.status(201).json(imported);
  } catch (error) {
    return res.status(400).json(serializeImportError(error));
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}
