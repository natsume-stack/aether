import type { NextApiRequest, NextApiResponse } from 'next';

import {
  authenticateVoxaAgent,
  recordVoxaAgentAction,
  rotateVoxaCode,
  revokeVoxaAgent,
  voxaAgentPanelState,
} from '../../../../server/agent-access';
import { setLocalCors } from '../../../../server/local-cors';
import { requireVoxaModelAccess } from '../../../../server/model-management-access';

/**
 * GET  /api/agent/v1/state   — VOXA Agent Active 面板数据源（创建者会话）。
 * POST /api/agent/v1/state   — 面板动作：rotate-code / revoke-agent / artifact。
 *
 * artifact 动作同时是 agent 登记产物的入口（agx_ 令牌可直接 POST）。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  // Agent 令牌只允许登记产物这一个动作。
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+agx_/i.test(authorization)) {
    if (req.method !== 'POST') return res.status(405).end();
    const auth = authenticateVoxaAgent(authorization);
    if (!auth.ok) {
      return res.status(401).json({ code: 'AGENT_AUTH_REQUIRED', message: '需要有效的 agent 令牌' });
    }
    const body = req.body as { kind?: unknown; name?: unknown; detail?: unknown } | undefined;
    const name = String(body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ code: 'INVALID_BODY', message: 'body 必须为 { kind, name, detail? }' });
    }
    await recordVoxaAgentAction(auth.agent.id, {
      action: 'artifact',
      result: 'applied',
      detail: String(body?.detail || '').slice(0, 500),
      artifact: {
        kind: String(body?.kind || 'model'),
        name,
        detail: String(body?.detail || ''),
      },
    });
    return res.status(201).json({ ok: true });
  }

  if (!await requireVoxaModelAccess(req, res, ['projects.edit', 'models.manage'])) return;

  if (req.method === 'GET') {
    return res.status(200).json(voxaAgentPanelState());
  }

  const action = String(req.body?.action || '');
  if (action === 'rotate-code') {
    const code = await rotateVoxaCode();
    return res.status(200).json({ ok: true, code });
  }
  if (action === 'revoke-agent') {
    const revoked = await revokeVoxaAgent(String(req.body?.agentId || ''));
    if (!revoked) return res.status(404).json({ code: 'AGENT_NOT_FOUND', message: 'agent 不存在' });
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ code: 'INVALID_ACTION', message: 'action 必须为 rotate-code | revoke-agent' });
}
