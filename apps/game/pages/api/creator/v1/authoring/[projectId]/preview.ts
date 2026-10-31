import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeCreatorCliApi } from '../../../../../../server/creator-api-security';
import {
  CREATOR_AUTHORING_SCOPE,
  authoringBearer,
  controlAuthoringPreview,
  createLoopbackRuntimeCaller,
  isAuthoringProjectId,
  tokenFingerprint,
} from '../../../../../../server/creator-authoring-bridge';

/**
 * GET  /api/creator/v1/authoring/<projectId>/preview   live preview state
 * POST /api/creator/v1/authoring/<projectId>/preview   body { action: "start" | "stop" }
 *
 * Preview control is part of `authoring.apply`, not a second scope: stop-preview
 * → write → save is one indivisible sequence (voxel hashes are only recorded on
 * save while the preview is stopped, `replica-server.ts:1600-1602`), so a token
 * that may write terrain must also be able to reach the refusal's fix. A token
 * that should only drive previews keeps using `runtime.control` on
 * `/api/creator/v1/projects/<id>/runtime`.
 *
 * Forwarded to the runtime's existing loopback `/internal/creator-preview-runtime`
 * handler; no runtime semantics are re-implemented here.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const identity = await authorizeCreatorCliApi(req, res, CREATOR_AUTHORING_SCOPE);
  if (!identity) return;

  const projectId = String(
    Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId || '',
  ).trim();
  if (!isAuthoringProjectId(projectId)) {
    return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  }
  const caller = createLoopbackRuntimeCaller(projectId);

  if (req.method === 'GET') {
    try {
      const { status, data } = await caller.previewStatus();
      return res.status(status).json(data);
    } catch (error) {
      return res.status(502).json({
        code: 'RUNTIME_REQUEST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const action = (req.body as { action?: unknown })?.action;
  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ code: 'INVALID_ACTION', message: 'action 必须为 start 或 stop' });
  }
  const { status, body } = await controlAuthoringPreview({
    caller,
    tokenSubject: identity.subjectId,
    tokenFingerprint: tokenFingerprint(authoringBearer(req)),
    action,
  });
  return res.status(status).json(body);
}
