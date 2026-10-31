import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi } from '../../../../../../../server/creator-api-security';
import {
  authenticateMapAgent,
  recordMapAgentAction,
} from '../../../../../../../server/agent-access';
import { dispatchCommand } from '../../../../../../../server/agent-live';
import { agentAuthError, resolveLiveProject } from '../../../../../../../server/agent-live-http';

/**
 * POST /api/agent/v1/live/map/<projectId>/cmd
 * body: { kind, args?, waitMs? }
 *
 * One agent command, executed by the open editor tab. The call blocks until
 * the tab acknowledges, so the agent's next observation is always after the
 * previous action actually happened.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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

  const kind = String(req.body?.kind || req.body?.tool || '').trim();
  if (!kind) {
    return res.status(400).json({ code: 'INVALID_BODY', message: 'body 必须包含 kind（例如 observe / look / place）' });
  }
  const args = req.body?.args && typeof req.body.args === 'object' && !Array.isArray(req.body.args)
    ? req.body.args as Record<string, unknown>
    : {};
  const waitMs = Number(req.body?.waitMs) || undefined;

  const outcome = await dispatchCommand(
    reference,
    kind,
    args,
    { id: auth.agent.id, name: auth.agent.name },
    waitMs,
  );

  const argsPreview = JSON.stringify(args).slice(0, 400);
  await recordMapAgentAction(reference, auth.agent.id, {
    action: `live:${kind}`,
    result: outcome.ok ? 'applied' : 'failed',
    detail: outcome.ok
      ? `${argsPreview} → 完成（${outcome.elapsedMs} ms）`
      : `${argsPreview} → ${outcome.error.code}: ${outcome.error.message}`,
  });

  if (outcome.ok) {
    return res.status(200).json(outcome);
  }
  const status =
    outcome.error.code === 'EDITOR_TIMEOUT'
      ? 504
      : ['EDITOR_NOT_ATTACHED', 'EDITOR_STALE', 'EDITOR_REATTACHED', 'EDITOR_DETACHED'].includes(outcome.error.code)
        ? 409
        : 422;
  return res.status(status).json(outcome);
}
