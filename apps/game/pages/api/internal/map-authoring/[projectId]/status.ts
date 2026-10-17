import type { NextApiRequest, NextApiResponse } from 'next';
import {
  RUNTIME_UNAVAILABLE_CODE,
  allowLoopback,
  callEditRuntime,
  isValidProjectId,
  projectId,
} from '../_guard';

/**
 * GET /api/internal/map-authoring/<projectId>/status   (loopback only)
 *
 * Reports whether an edit runtime is active for the project, whether the live
 * preview is running, and which programmable write surfaces are reachable.
 *
 * The terrain/UI *writes* themselves run in the edit runtime's AI tool layer
 * (`services/game-server/src/edit/ai/map-authoring-tools.ts`). Headless HTTP
 * reach to those tools needs a runtime-side `/internal/*` route, which is
 * registered in `createServer.ts` — outside this lane. This endpoint therefore
 * advertises `headlessWriteRoute: "unavailable"` with the exact reason so an
 * orchestrating MCP can decide between (a) driving the in-editor AI panel or
 * (b) waiting for that route to be approved.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowLoopback(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const id = projectId(req.query.projectId);
  if (!isValidProjectId(id)) {
    return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  }
  try {
    const { status, data } = await callEditRuntime(id, 'internal/creator-preview-runtime');
    const runtime = data as Record<string, unknown>;
    return res.status(200).json({
      projectId: id,
      runtimeActive: status === 200,
      preview: runtime,
      headlessWriteRoute: 'unavailable',
      headlessWriteRouteReason:
        'terrain/ui AI tools exist server-side but no runtime /internal HTTP route to invoke them ' +
        'headlessly (createServer.ts is out of the C4 lane). Coordinate with stop-preview -> write -> save.',
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { cause?: { code?: string } })
      .cause?.code || (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') {
      return res.status(200).json({
        projectId: id,
        runtimeActive: false,
        code: RUNTIME_UNAVAILABLE_CODE,
        message: '该工程当前没有打开的编辑运行时',
        headlessWriteRoute: 'unavailable',
      });
    }
    return res.status(502).json({ code: 'RUNTIME_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
}
