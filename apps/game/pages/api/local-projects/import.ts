import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';

import { getLocalProjectManager } from '../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';
import { prewarmLocalRuntimes } from '../../../server/runtime-prewarm';
import { serializeImportError } from '../../../server/import-diagnostics';

export const config = { api: { bodyParser: false } };

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'projects.import')) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const temporaryPath = path.join(os.tmpdir(), `box-project-import-${process.pid}-${Date.now()}.box-project`);
  let receivedBytes = 0;
  try {
    await pipeline(
      req,
      new Transform({
        transform(chunk, _encoding, callback) {
          receivedBytes += chunk.length;
          callback(receivedBytes > MAX_ARCHIVE_BYTES ? new Error('工程包不能超过 1GB') : undefined, chunk);
        },
      }),
      fs.createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    const mode = Array.isArray(req.query.mode) ? req.query.mode[0] : req.query.mode;
    const targetMainProjectId = Array.isArray(req.query.targetMainProjectId)
      ? req.query.targetMainProjectId[0]
      : req.query.targetMainProjectId;
    if (mode && mode !== 'independent' && mode !== 'submap') {
      throw new Error('不支持的工程导入方式');
    }
    const manager = getLocalProjectManager();
    const project = manager.importProject(temporaryPath, {
      mode: mode || 'independent',
      targetMainProjectId,
    });
    const members = manager.listMapGroup(project.id);
    void prewarmLocalRuntimes(members.map((member) => member.id), ['edit', 'play']);
    return res.status(201).json({ project });
  } catch (error) {
    return res.status(400).json(serializeImportError(error));
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}
