import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeCreatorCliApi } from '../../../../../../server/creator-api-security';
import {
  CREATOR_AUTHORING_SCOPE,
  authoringSurface,
  createLoopbackRuntimeCaller,
  isAuthoringProjectId,
  isPreviewRunning,
} from '../../../../../../server/creator-authoring-bridge';

/**
 * GET /api/creator/v1/authoring/<projectId>/status
 *
 * What an AI orchestrator must know before it plans a write: is an edit runtime
 * open for this map, is the live preview running, and is the tool surface
 * reachable. Read-only, no quota, still attributed and scoped to
 * `authoring.apply` so a token cannot probe maps it may not write.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!await authorizeCreatorCliApi(req, res, CREATOR_AUTHORING_SCOPE)) return;

  const projectId = String(
    Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId || '',
  ).trim();
  if (!isAuthoringProjectId(projectId)) {
    return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  }
  const caller = createLoopbackRuntimeCaller(projectId);
  try {
    const probe = await caller.probeRuntime();
    if (!probe) {
      return res.status(200).json({
        ...authoringSurface(projectId),
        runtimeActive: false,
        previewRunning: false,
        code: 'RUNTIME_NOT_ACTIVE',
        message: '该工程当前没有打开的编辑运行时',
      });
    }
    let preview: unknown = null;
    let previewStatus = 0;
    try {
      const status = await caller.previewStatus();
      preview = status.data;
      previewStatus = status.status;
    } catch {
      // Preview state unreadable: reported as unknown below rather than a hard error.
    }
    const previewRunning = previewStatus === 200 && isPreviewRunning(preview);
    return res.status(200).json({
      ...authoringSurface(projectId),
      runtimeActive: true,
      previewRunning,
      preview,
      saveBlockedWhilePreviewRunning: previewRunning,
      saveUnblockAction: previewRunning
        ? `POST /api/creator/v1/authoring/${projectId}/preview {action:"stop"} 后再 POST .../save（或 force:true）`
        : '',
    });
  } catch (error) {
    return res.status(502).json({
      code: 'RUNTIME_REQUEST_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
