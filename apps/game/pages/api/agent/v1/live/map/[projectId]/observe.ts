import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi } from '../../../../../../../server/creator-api-security';
import {
  authenticateMapAgent,
  recordMapAgentAction,
} from '../../../../../../../server/agent-access';
import { dispatchCommand } from '../../../../../../../server/agent-live';
import { agentAuthError, resolveLiveProject } from '../../../../../../../server/agent-live-http';

/**
 * POST /api/agent/v1/live/map/<projectId>/observe
 *
 * Convenience wrapper around `cmd {kind:"observe"}`: returns the editor's
 * current camera, raycast hit, cursor, selected entity and nearby entities.
 * Call it after every write; it is the agent's eyes.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const reference = resolveLiveProject(
    Array.isArray(req.query.projectId) ? req.query.projectId[0] : req.query.projectId,
  );
  if (!reference) {
    return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: '地图不存在' });
  }
  const auth = authenticateMapAgent(reference, req.headers.authorization);
  if (!auth.ok) {
    const failure = agentAuthError(auth.code);
    return res.status(failure.status).json(failure.body);
  }

  const body = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {};
  const outcome = await dispatchCommand(
    reference,
    'observe',
    { includeTerrain: Boolean((body as Record<string, unknown>).includeTerrain) },
    { id: auth.agent.id, name: auth.agent.name },
    Number((body as Record<string, unknown>).waitMs) || undefined,
  );

  await recordMapAgentAction(reference, auth.agent.id, {
    action: 'live:observe',
    result: outcome.ok ? 'applied' : 'failed',
    detail: outcome.ok
      ? `观察快照（${outcome.elapsedMs} ms）`
      : `${outcome.error.code}: ${outcome.error.message}`,
  });

  if (outcome.ok) {
    return res.status(200).json({
      ok: true,
      commandId: outcome.commandId,
      snapshot: outcome.snapshot ?? outcome.result,
      elapsedMs: outcome.elapsedMs,
    });
  }
  const status = outcome.error.code === 'EDITOR_TIMEOUT'
    ? 504
    : ['EDITOR_NOT_ATTACHED', 'EDITOR_STALE', 'EDITOR_REATTACHED', 'EDITOR_DETACHED'].includes(outcome.error.code)
      ? 409
      : 422;
  return res.status(status).json(outcome);
}
