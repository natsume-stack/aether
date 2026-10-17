import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Loopback guard for the internal map-authoring surface.
 *
 * Mirrors the intent of `services/game-server/src/createServer.ts` (the
 * `/internal/save-local-project` and `/internal/creator-preview-runtime`
 * handlers): these routes exist to let a SAME-HOST orchestrator (the Creator
 * Next process driving an edit runtime) coordinate a map write. They must never
 * be reachable from another machine, so we require a loopback socket peer and
 * reject everything else with 403. This is strictly additive: it does not touch
 * the existing `/api/local-projects` or `/api/creator/v1` authentication.
 */
export function allowLoopback(
  req: NextApiRequest,
  res: NextApiResponse,
): boolean {
  const address = req.socket?.remoteAddress || '';
  const isLoopback =
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1';
  if (!isLoopback) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'loopback-only internal route' });
    return false;
  }
  return true;
}

export function projectId(value: string | string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] : value;
  return String(id || '').trim();
}

export function isValidProjectId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);
}

function runtimePort(): number {
  return Number(
    process.env.BOX_EDIT_RUNTIME_PORT ||
      process.env.BOX_EDIT_SERVER_PORT ||
      '9967',
  );
}

/**
 * Call the active edit runtime's loopback `/internal/...` route for a project.
 * The runtime only answers when that project currently has an edit session
 * open; otherwise the connection is refused and we surface a diagnosable error.
 */
export async function callEditRuntime(
  projectIdId: string,
  suffix: 'internal/creator-preview-runtime' | 'internal/save-local-project',
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${runtimePort()}/${encodeURIComponent(projectIdId)}/${suffix}`;
  const response = await fetch(url, {
    method: init?.method || 'GET',
    headers: init?.body
      ? { 'Content-Type': 'application/json', Accept: 'application/json' }
      : { Accept: 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

export const RUNTIME_UNAVAILABLE_CODE = 'RUNTIME_NOT_ACTIVE';
