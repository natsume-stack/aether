import type { NextApiRequest, NextApiResponse } from 'next';

import { authenticateVoxaAgent, recordVoxaAgentAction } from '../../../../../../server/agent-access';
import {
  dispatchVoxaCommand,
  voxaLiveStatus,
} from '../../../../../../server/agent-live';
import { setLocalCors } from '../../../../../../server/local-cors';

/**
 * The agent-facing side of the VOXA live channel.
 *
 * `/api/agent/v1/live/voxa/cmd|status|observe`, authenticated with the `agx_`
 * token a VOX- join code redeemed. Deliberately separate from
 * `/api/agent/v1/live/<action>` (the editor tab's own routes): the editor
 * proves a human session, the agent proves a token, and mixing the two guards
 * in one file is how privilege confusion starts.
 */

function authenticate(req: NextApiRequest, res: NextApiResponse) {
  const auth = authenticateVoxaAgent(String(req.headers.authorization || ''));
  if (!auth.ok) {
    res.status(401).json({
      code: 'AGENT_AUTH_REQUIRED',
      message: '需要有效的 agent 令牌；用 VOXA 识别码 POST /api/agent/v1/join 换取',
    });
    return undefined;
  }
  return auth.agent;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const agent = authenticate(req, res);
  if (!agent) return;

  const action = String(req.query.action || '');

  if (action === 'status' && req.method === 'GET') {
    return res.status(200).json({ ok: true, ...voxaLiveStatus() });
  }

  if (action === 'observe') {
    const outcome = await dispatchVoxaCommand(
      'observe',
      { screenshot: Boolean(req.body?.screenshot) },
      { id: agent.id, name: agent.name },
      Number(req.body?.waitMs) || 30_000,
    );
    return res.status(outcome.ok ? 200 : 504).json(outcome);
  }

  if (action === 'cmd' && req.method === 'POST') {
    const kind = String(req.body?.kind || '').trim();
    if (!kind) {
      return res.status(400).json({ code: 'INVALID_BODY', message: 'body 必须含 { kind, args? }' });
    }
    const outcome = await dispatchVoxaCommand(
      kind,
      (req.body?.args || {}) as Record<string, unknown>,
      { id: agent.id, name: agent.name },
      Number(req.body?.waitMs) || 30_000,
    );
    await recordVoxaAgentAction(agent.id, {
      action: `live:${kind}`,
      result: outcome.ok ? 'applied' : outcome.error.code,
      detail: outcome.ok ? String((outcome.result as { summary?: string })?.summary || '') : outcome.error.message,
    });
    return res.status(outcome.ok ? 200 : outcome.error.code === 'EDITOR_TIMEOUT' ? 504 : 409).json(outcome);
  }

  return res.status(404).json({ code: 'UNKNOWN_ACTION', message: '未知动作' });
}
