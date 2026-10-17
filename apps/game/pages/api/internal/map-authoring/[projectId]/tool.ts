import type { NextApiRequest, NextApiResponse } from 'next';
import {
  RUNTIME_UNAVAILABLE_CODE,
  allowLoopback,
  isValidProjectId,
  projectId,
} from '../_guard';

/**
 * POST /api/internal/map-authoring/<projectId>/tool   (loopback only)
 * body: { tool: string, args?: object }
 *
 * Headless entry point for the engine-side AI authoring tools (terrain/UI +
 * entities). It forwards one tool call to the edit runtime's loopback-only
 * `/internal/ai-tool` route (registered in createServer.ts, handler in
 * services/game-server/src/edit/ai/ai-tool-route.ts), which reuses C4's
 * `createMapAuthoringTools()` verbatim. This closes the gap recorded in
 * box3-re/scan/O4-engine-ai-adaptation.md §3.4 / decision D-b.
 *
 * Semantics intentionally NOT re-implemented here (they live in the tools):
 *   - `expectedRevision` optimistic lock  -> REVISION_CONFLICT (HTTP 409)
 *   - `undoToken` rollback via terrainRevert
 *   - hard ordering: terrain writes refused with PREVIEW_RUNNING (HTTP 409)
 *     while the live preview runs (replica-server.ts:1602). The orchestrator
 *     sequence stays: stop preview -> write -> POST .../save.
 *
 * GET returns the runtime tool catalog (name + description) for discovery.
 *
 * Purely additive: new file, no change to `_guard.ts` or any existing route.
 * The runtime fetch is local (not via `callEditRuntime`) because that helper's
 * suffix whitelist is C4-owned and must stay byte-identical for its callers.
 *
 * Side-effect guard: the edit-library proxy allocates a runtime for unknown
 * forwarded paths, so this route first reads `/__local_runtime/status` (which
 * the library answers itself, never allocating) and refuses with 409 unless an
 * edit runtime is actually alive for the project. Headless tool calls must not
 * silently boot a heavyweight editor process.
 */
function runtimePort(): number {
  return Number(
    process.env.BOX_EDIT_RUNTIME_PORT ||
      process.env.BOX_EDIT_SERVER_PORT ||
      '9967',
  );
}

async function fetchRuntimeJson(
  projectIdId: string,
  suffix: 'internal/ai-tool' | '__local_runtime/status',
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(
    `http://127.0.0.1:${runtimePort()}/${encodeURIComponent(projectIdId)}/${suffix}`,
    {
      method,
      headers: body
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      // Large undoTokens (terrainRevert) make tool calls slow on big regions;
      // keep the same budget as _guard.callEditRuntime.
      signal: AbortSignal.timeout(120_000),
    },
  );
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowLoopback(req, res)) return;
  const id = projectId(req.query.projectId);
  if (!isValidProjectId(id)) {
    return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }
  try {
    // Pre-check: does this project actually have a live edit runtime?
    // `/__local_runtime/status` is answered by the edit-library itself and
    // only exposes `pid`/`port` when a runtime process is running.
    const probe = await fetchRuntimeJson(id, '__local_runtime/status', 'GET');
    const info = probe.data as Record<string, unknown>;
    if (probe.status !== 200 || !info || info.pid === undefined) {
      return res.status(409).json({
        code: RUNTIME_UNAVAILABLE_CODE,
        message: '该工程当前没有打开的编辑运行时；请先在 Creator 中打开地图编辑器（或先 GET .../status 确认），再调用 AI 地图工具',
      });
    }
    if (req.method === 'GET') {
      const { status, data } = await fetchRuntimeJson(id, 'internal/ai-tool', 'GET');
      return res.status(status).json(data);
    }
    const body = req.body as { tool?: unknown; name?: unknown; args?: unknown } | undefined;
    const toolName =
      body && typeof body.tool === 'string' && body.tool
        ? body.tool
        : body && typeof body.name === 'string' && body.name
          ? body.name
          : '';
    if (!toolName) {
      return res.status(400).json({
        code: 'INVALID_BODY',
        message: 'body 必须为 { tool|name, args? }；GET 本路由可列出可用工具',
      });
    }
    const { status, data } = await fetchRuntimeJson(
      id,
      'internal/ai-tool',
      'POST',
      { tool: toolName, args: body?.args ?? {} },
    );
    // The runtime answers 409 for PREVIEW_RUNNING / REVISION_CONFLICT refusals
    // and 200 for everything the tools report in band; pass both through.
    return res.status(status).json(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { cause?: { code?: string } })
      .cause?.code || (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') {
      return res.status(409).json({
        code: RUNTIME_UNAVAILABLE_CODE,
        message: '该工程当前没有打开的编辑运行时，无法调用 AI 地图工具',
      });
    }
    return res.status(502).json({
      code: 'RUNTIME_REQUEST_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * terrainRevert replays multi-MB `undoToken` strings produced by large
 * terrainApply calls; the 1 MiB Next default body limit would break the
 * rollback half of the C4 write/undo pair before it reaches the runtime.
 */
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '32mb',
    },
  },
};
