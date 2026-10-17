import type { NextApiRequest, NextApiResponse } from 'next';
import {
  allowLoopback,
  callEditRuntime,
  isValidProjectId,
  projectId,
} from '../_guard';

/**
 * POST /api/internal/map-authoring/<projectId>/save   (loopback only)
 * body: { force?: boolean }
 *
 * Persists the current in-memory edit replica to disk by forwarding to the
 * runtime's loopback `/internal/save-local-project` handler and returns
 * `{ permissionHash }`.
 *
 * Hard-order enforcement (voxels): the runtime does NOT record voxel chunk
 * hashes while the preview is running (`replica-server.ts:1602`). To keep an AI
 * authoring loop from silently persisting stale terrain, this endpoint checks
 * the live preview state first and refuses (409) unless `force` is set. Callers
 * should POST .../preview {action:"stop"} first, then save.
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
  const force = Boolean((req.body as { force?: unknown })?.force);

  const finish = async () => {
    try {
      const { status, data } = await callEditRuntime(id, 'internal/save-local-project', {
        method: 'POST',
      });
      return res.status(status).json(data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException & { cause?: { code?: string } })
        .cause?.code || (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED') {
        return res.status(409).json({ code: 'RUNTIME_NOT_ACTIVE', message: '该工程当前没有打开的编辑运行时，无法保存' });
      }
      return res.status(502).json({ code: 'RUNTIME_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (!force) {
    try {
      const { status, data } = await callEditRuntime(id, 'internal/creator-preview-runtime');
      if (status === 200) {
        const phase = (data as Record<string, unknown>)?.phase;
        const running = (data as Record<string, unknown>)?.running;
        if (running === true || phase === 'running') {
          return res.status(409).json({
            code: 'PREVIEW_RUNNING',
            message:
              '预览仍在运行：保存不会记录体素 chunk（replica-server.ts:1602）。' +
              '请先调用 .../preview {action:"stop"} 再保存，或传 force:true 强制保存。',
          });
        }
      }
    } catch {
      // Preview status probe failed; fall through to attempt the save, whose
      // own error handling is authoritative.
    }
  }
  return finish();
}
