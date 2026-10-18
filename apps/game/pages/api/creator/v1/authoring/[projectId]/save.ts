import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeCreatorCliApi } from '../../../../../../server/creator-api-security';
import {
  CREATOR_AUTHORING_SCOPE,
  authoringBearer,
  consumeAuthoringWriteQuota,
  createLoopbackRuntimeCaller,
  isAuthoringProjectId,
  saveAuthoringProject,
  tokenFingerprint,
  writeAuthoringAudit,
} from '../../../../../../server/creator-authoring-bridge';

/**
 * POST /api/creator/v1/authoring/<projectId>/save   body { force?: boolean }
 *
 * Persists the live edit replica through the runtime's loopback
 * `/internal/save-local-project` handler, under the `authoring.apply` CLI scope.
 *
 * Hard ordering rule, enforced in this identity-bearing layer: while a live
 * preview runs, the engine does not record voxel chunk hashes on save
 * (`services/game-server/src/edit/replica/replica-server.ts:1600-1602`:
 * `// update voxel hashes only if game isn't running` guarding
 * `if (!gameState.replica.running) { const voxels = await recordVoxelInfo(gameState); … }`
 * and the `voxels` project action inside that same block). Saving then would
 * write a project whose terrain hashes are stale, so the request is refused with
 * 409 `PREVIEW_RUNNING` and audited. Correct order for an AI loop:
 * `POST .../preview {action:"stop"}` → writes → `POST .../save`.
 * `force:true` is the operator/agent escape hatch and is itself audited.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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
  const actor = {
    tokenSubject: identity.subjectId,
    tokenFingerprint: tokenFingerprint(authoringBearer(req)),
  };

  const quota = consumeAuthoringWriteQuota(actor.tokenFingerprint, projectId);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfterSeconds));
    writeAuthoringAudit({
      ...actor,
      projectId,
      tool: 'save',
      action: 'save',
      result: 'denied-rate-limit',
      statusCode: 429,
      code: 'AUTHORING_RATE_LIMITED',
    });
    return res.status(429).json({
      code: 'AUTHORING_RATE_LIMITED',
      message: `该 CLI Token 在此地图上的写操作已超出配额，请 ${quota.retryAfterSeconds}s 后重试`,
    });
  }

  const force = Boolean((req.body as { force?: unknown })?.force);
  const { status, body } = await saveAuthoringProject({
    caller: createLoopbackRuntimeCaller(projectId),
    ...actor,
    force,
  });
  return res.status(status).json(body);
}
