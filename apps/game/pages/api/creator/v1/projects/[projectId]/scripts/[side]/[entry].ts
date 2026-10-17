import type { NextApiRequest, NextApiResponse } from 'next';
import {
  parseCreatorProjectScriptWrite,
  parseCreatorProjectScriptReference,
  readCreatorProjectScript,
  writeCreatorProjectScript,
  type CreatorProjectScriptStore,
} from '@box/cli';
import { allowAuthenticatedCreatorCliApi } from '../../../../../../../../server/creator-api-security';
import { getLocalProjectManager } from '../../../../../../../../server/local-project-manager';

// The protocol permits 20 MiB of UTF-8 script content. Leave a small envelope
// for JSON quoting so Next reaches the protocol validator instead of applying
// its much smaller default request-body limit first.
export const config = { api: { bodyParser: { sizeLimit: '22mb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT'].includes(req.method || '')) { res.setHeader('Allow', 'GET, PUT'); return res.status(405).end(); }
  if (!await allowAuthenticatedCreatorCliApi(req, res, req.method === 'GET' ? 'scripts.read' : 'scripts.update')) return;
  try {
    if (req.method === 'GET') {
      const input = parseCreatorProjectScriptReference({
        projectId: Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId,
        side: Array.isArray(req.query.side) ? req.query.side[0] : req.query.side,
        entry: Array.isArray(req.query.entry) ? req.query.entry[0] : req.query.entry,
      });
      return res.status(200).json(readCreatorProjectScript(getLocalProjectManager() as CreatorProjectScriptStore, input));
    }
    const input = parseCreatorProjectScriptWrite({
      projectId: Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId,
      side: Array.isArray(req.query.side) ? req.query.side[0] : req.query.side,
      entry: Array.isArray(req.query.entry) ? req.query.entry[0] : req.query.entry,
      content: req.body?.content,
    });
    // Load this through the runtime adapter rather than a static require.
    // Next otherwise bundles project-manager.js into this route and changes
    // __dirname, which breaks its createRequire() resolution in the slim
    // Creator image. The adapter keeps it at /app/apps/local-engine/src.
    return res.status(200).json(
      writeCreatorProjectScript(getLocalProjectManager() as CreatorProjectScriptStore, input),
    );
  } catch (error) {
    const detail = error as { code?: string; status?: number; message?: string };
    return res.status(detail.status || 422).json({
      code: detail.code || 'SCRIPT_WRITE_FAILED',
      message: detail.message || String(error),
    });
  }
}
