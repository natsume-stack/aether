import type { NextApiRequest, NextApiResponse } from 'next';
import { getLocalProjectManager } from '../../../../server/local-project-manager';
import { allowAuthenticatedCreatorApi } from '../../../../server/creator-api-security';

async function flushActiveEditor(projectId: string) {
  const port =
    process.env.BOX_EDIT_RUNTIME_PORT ||
    process.env.BOX_EDIT_SERVER_PORT ||
    '9967';
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/${encodeURIComponent(projectId)}/internal/save-local-project`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        message = JSON.parse(body)?.message || body;
      } catch { /* response was not JSON */ }
      throw new Error(message || `编辑器保存失败（HTTP ${response.status}）`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { cause?: { code?: string } })
      .cause?.code || (error as NodeJS.ErrnoException).code;
    // No edit runtime is normal when a project is published without currently
    // being open. In that case the on-disk project is already authoritative.
    if (code === 'ECONNREFUSED') return;
    throw error;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'projects.edit')) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) return res.status(400).json({ message: 'Project ID is required' });
  try {
    const manager = getLocalProjectManager();
    const members = manager.listMapGroup(id);
    await Promise.all(members.map((member) => flushActiveEditor(member.id)));
    return res.status(201).json({
      release: manager.publishMapGroup(id, req.body?.version, req.body?.notes),
    });
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
