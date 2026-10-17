import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';
import { getLocalProjectManager } from '../../../server/local-project-manager';

declare global {
  // eslint-disable-next-line no-var
  var boxManualBackupQueued: boolean | undefined;
}

async function flushOpenProjects() {
  const manager = getLocalProjectManager();
  const port = Number(process.env.BOX_EDIT_RUNTIME_PORT || process.env.BOX_EDIT_SERVER_PORT || 9967);
  await Promise.all(manager.listProjects().map(async (project) => {
    try {
      await fetch(`http://127.0.0.1:${port}/${encodeURIComponent(project.id)}/internal/save-local-project`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // A closed or failed editor has no pending in-memory changes to flush.
    }
  }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, req.method === 'GET' ? 'projects.view' : 'projects.edit')) return;
  const manager = getLocalProjectManager();
  if (req.method === 'GET') {
    return res.status(200).json({
      configuration: manager.getBackupConfiguration(),
      status: manager.readBackupStatus(),
    });
  }
  if (req.method === 'POST') {
    if (globalThis.boxManualBackupQueued) {
      return res.status(202).json({ queued: true, status: manager.readBackupStatus() });
    }
    globalThis.boxManualBackupQueued = true;
    setImmediate(async () => {
      try {
        await flushOpenProjects();
        manager.runProjectBackups('manual');
      } catch (error) {
        console.error('Manual project backup failed:', error);
      } finally {
        globalThis.boxManualBackupQueued = false;
      }
    });
    return res.status(202).json({ queued: true, status: manager.readBackupStatus() });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
