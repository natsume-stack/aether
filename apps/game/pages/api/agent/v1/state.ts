import type { NextApiRequest, NextApiResponse } from 'next';
import {
  allowCreatorApi,
  authenticatedCreatorIdentity,
} from '../../../../server/creator-api-security';
import {
  ensureMapAgentAccess,
  mapAgentPanelState,
  revokeMapAgent,
  rotateMapCode,
} from '../../../../server/agent-access';
import { getLocalProjectManager } from '../../../../server/local-project-manager';
import { mapEditorUrl, publicCreatorBaseUrl } from '../../../../server/agent-live-http';

/**
 * GET  /api/agent/v1/state?container=<project>   — Agent Active 面板数据源。
 * POST /api/agent/v1/state                       — 面板动作（rotate-code / revoke-agent）。
 *
 * 浏览器面（编辑器面板）走创建者会话；识别码全文只在这里返回给有 projects.view
 * 权限的创建者。agent（agx_ 令牌）不能读本路由——它们只有各自的作用域。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  if (req.method === 'POST') {
    if (!await authenticatedCreatorIdentity(req, res, 'projects.edit')) return;
    const action = String(req.body?.action || '');
    const container = String(req.body?.container || '');
    const reference = resolveContainer(container);
    if (!reference) {
      return res.status(400).json({ code: 'INVALID_CONTAINER', message: 'container 无效' });
    }
    if (action === 'rotate-code') {
      const code = await rotateMapCode(reference);
      return res.status(200).json({ ok: true, code });
    }
    if (action === 'revoke-agent') {
      const agentId = String(req.body?.agentId || '');
      const revoked = await revokeMapAgent(reference, agentId);
      if (!revoked) return res.status(404).json({ code: 'AGENT_NOT_FOUND', message: 'agent 不存在' });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ code: 'INVALID_ACTION', message: 'action 必须为 rotate-code | revoke-agent' });
  }

  if (!await authenticatedCreatorIdentity(req, res, 'projects.view')) return;
  const container = String(req.query.container || '');
  const reference = resolveContainer(container);
  if (!reference) {
    return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: '地图不存在' });
  }
  // Must be awaited: the first panel poll for a brand-new map is what creates
  // and persists the code, and mapAgentPanelState reads the same file.
  await ensureMapAgentAccess(reference);
  const state = mapAgentPanelState(reference);
  if (!state) {
    return res.status(500).json({ code: 'STATE_MISSING', message: 'Agent Access 状态缺失' });
  }
  const manager = getLocalProjectManager();
  let project: Record<string, unknown> = { id: reference };
  try {
    const metadata = manager.getProject(reference);
    project = {
      id: reference,
      permanentMapId: metadata.permanentMapId,
      name: metadata.name,
      mapSize: metadata.mapSize,
    };
  } catch {
    // State can outlive a deleted project; the panel still shows the trail.
  }
  return res.status(200).json({
    ...state,
    project,
    // The panel shows the exact URL an AI must be pointed at, so "地址 + 识别码"
    // is a complete handoff without the human copying a project id.
    editorUrl: mapEditorUrl(publicCreatorBaseUrl(req), reference),
  });
}

function resolveContainer(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  try {
    return getLocalProjectManager().resolveProjectReference(value);
  } catch {
    return '';
  }
}
