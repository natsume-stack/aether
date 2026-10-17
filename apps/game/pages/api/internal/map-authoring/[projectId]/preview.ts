import type { NextApiRequest, NextApiResponse } from 'next';
import {
  allowLoopback,
  callEditRuntime,
  isValidProjectId,
  projectId,
} from '../_guard';

/**
 * POST /api/internal/map-authoring/<projectId>/preview   (loopback only)
 * body: { action: "start" | "stop" }
 *
 * Starts/stops the live preview of an open edit runtime by forwarding to the
 * runtime's existing `/internal/creator-preview-runtime` handler. This is the
 * orchestration piece needed to honor the hard ordering rule: voxel chunk hashes
 * are only recorded on save when the preview is NOT running
 * (`replica-server.ts:1602`), so an AI authoring loop must stop the preview
 * before saving terrain.
 *
 * Purely additive: it re-uses an already-existing, loopback-only runtime route
 * and changes no contract.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowLoopback(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const id = projectId(req.query.projectId);
  if (!isValidProjectId(id)) {
    return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  }
  const action = (req.body as { action?: unknown })?.action;
  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ code: 'INVALID_ACTION', message: 'action 必须为 start 或 stop' });
  }
  try {
    const { status, data } = await callEditRuntime(id, 'internal/creator-preview-runtime', {
      method: 'POST',
      body: { action },
    });
    return res.status(status).json(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { cause?: { code?: string } })
      .cause?.code || (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') {
      return res.status(409).json({ code: 'RUNTIME_NOT_ACTIVE', message: '该工程当前没有打开的编辑运行时，无法控制预览' });
    }
    return res.status(502).json({ code: 'RUNTIME_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
}
