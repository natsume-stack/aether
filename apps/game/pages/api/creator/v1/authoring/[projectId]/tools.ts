import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeCreatorCliApi } from '../../../../../../server/creator-api-security';
import {
  CREATOR_AUTHORING_SCOPE,
  authoringBearer,
  createLoopbackRuntimeCaller,
  invokeAuthoringTool,
  isAuthoringProjectId,
  consumeAuthoringWriteQuota,
  tokenFingerprint,
  writeAuthoringAudit,
} from '../../../../../../server/creator-authoring-bridge';

/**
 * POST /api/creator/v1/authoring/<projectId>/tools   body { tool|name, args? }
 * GET  /api/creator/v1/authoring/<projectId>/tools
 *
 * The identity-bearing AI map-authoring surface required by
 * `box3-re/plan/N7-ai-adaptation-decisions.md` decision 1. Authentication is
 * the `bxc_*` CLI Token and the scope is `authoring.apply`; the loopback-only
 * `/api/internal/map-authoring/**` routes are untouched and keep serving the
 * same-host editor orchestration with no credential of their own.
 *
 * The call is forwarded verbatim to the edit runtime's `/internal/ai-tool`
 * handler, so the C4 semantics stay single-sourced in the engine:
 * `expectedRevision` optimistic lock (409 `REVISION_CONFLICT`), `undoToken`
 * rollback through `terrainRevert`, and `PREVIEW_RUNNING` refusals. Nothing here
 * auto-stops a preview or persists anything — that is `.../save`.
 *
 * Per-token, per-project write quota (429 + `Retry-After`) and one audit row per
 * write, including refusals.
 */
function projectIdOf(value: string | string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] : value;
  return String(id || '').trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const identity = await authorizeCreatorCliApi(req, res, CREATOR_AUTHORING_SCOPE);
  if (!identity) return;

  const projectId = projectIdOf(req.query.projectId);
  if (!isAuthoringProjectId(projectId)) {
    return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  }
  const caller = createLoopbackRuntimeCaller(projectId);
  const actor = {
    tokenSubject: identity.subjectId,
    tokenFingerprint: tokenFingerprint(authoringBearer(req)),
  };

  if (req.method === 'GET') {
    try {
      const probe = await caller.probeRuntime();
      if (!probe) {
        return res.status(409).json({
          code: 'RUNTIME_NOT_ACTIVE',
          message: '该工程当前没有打开的编辑运行时；请先在 Creator 中打开地图编辑器再列出工具',
        });
      }
      const { status, data } = await caller.listTools();
      return res.status(status).json(data);
    } catch (error) {
      return res.status(502).json({
        code: 'RUNTIME_REQUEST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const body = req.body as { tool?: unknown; name?: unknown; args?: unknown } | undefined;
  const tool =
    body && typeof body.tool === 'string' && body.tool
      ? body.tool
      : body && typeof body.name === 'string' && body.name
        ? body.name
        : '';

  const quota = consumeAuthoringWriteQuota(actor.tokenFingerprint, projectId);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfterSeconds));
    writeAuthoringAudit({
      ...actor,
      projectId,
      tool,
      action: 'tool',
      result: 'denied-rate-limit',
      statusCode: 429,
      code: 'AUTHORING_RATE_LIMITED',
      detail: `窗口内写操作超过 ${quota.retryAfterSeconds}s 后重置`,
    });
    return res.status(429).json({
      code: 'AUTHORING_RATE_LIMITED',
      message: `该 CLI Token 在此地图上的写操作已超出配额，请 ${quota.retryAfterSeconds}s 后重试`,
    });
  }
  res.setHeader('X-Authoring-Quota-Remaining', String(Math.max(quota.remaining, 0)));

  const { status, body: payload } = await invokeAuthoringTool({
    caller,
    ...actor,
    tool,
    args: body?.args,
  });
  return res.status(status).json(payload);
}

/**
 * `terrainRevert` replays multi-MB `undoToken` strings produced by large
 * terrainApply calls; the 1 MiB Next default body limit would break the
 * rollback half of the write/undo pair before it reaches the runtime.
 * Matches the internal route's limit so neither side is the weaker link.
 */
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '32mb',
    },
  },
};
