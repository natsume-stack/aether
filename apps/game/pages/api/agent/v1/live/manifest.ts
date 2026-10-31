import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi, authenticatedCreatorIdentity } from '../../../../../server/creator-api-security';
import {
  ensureMapAgentAccess,
  mapAgentPanelState,
} from '../../../../../server/agent-access';
import { liveStatus } from '../../../../../server/agent-live';
import {
  buildMapMcpManifest,
  mapLivePrerequisites,
  publicCreatorBaseUrl,
  resolveLiveProject,
} from '../../../../../server/agent-live-http';
import { getLocalProjectManager } from '../../../../../server/local-project-manager';

/**
 * GET /api/agent/v1/live/manifest?container=
 *
 * One response the human can paste into an agent host: where the live endpoints
 * are, the join code for this map, and a ready MCP registration JSON. This is
 * what makes the deployed (cdk.lat) editor reachable from an agent that is not
 * running on the server's loopback.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!await authenticatedCreatorIdentity(req, res, 'projects.view')) return;

  const project = resolveLiveProject(req.query.container);
  if (!project) {
    return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: '地图不存在' });
  }
  await ensureMapAgentAccess(project);
  const state = mapAgentPanelState(project);
  if (!state) {
    return res.status(500).json({ code: 'STATE_MISSING', message: 'Agent Access 状态缺失' });
  }

  let projectMeta: Record<string, unknown> = { id: project };
  try {
    const metadata = getLocalProjectManager().getProject(project);
    projectMeta = {
      id: project,
      name: metadata.name,
      permanentMapId: metadata.permanentMapId,
      mapSize: metadata.mapSize,
    };
  } catch {
    // A deleted project can still have an access entry; the panel shows it.
  }

  const baseUrl = publicCreatorBaseUrl(req);
  const manifest = buildMapMcpManifest({
    baseUrl,
    joinCode: state.code,
    projectId: project,
  });

  return res.status(200).json({
    ok: true,
    kind: 'map',
    project: projectMeta,
    baseUrl,
    editorUrl: manifest.editorUrl,
    joinCode: state.code,
    codeUpdatedAt: state.codeUpdatedAt,
    status: liveStatus(project),
    handoff: {
      minimal: ['编辑器地址', '地图识别码'],
      editorUrl: manifest.editorUrl,
      joinCode: state.code,
      projectId: project,
      projectIdAutoDiscovered: true,
    },
    prerequisites: mapLivePrerequisites(baseUrl, project),
    mcp: manifest.mcpServers['box3-agent'],
    mcpServers: manifest.mcpServers,
    endpoints: manifest.endpoints,
    instructions: [
      '把 mcpServers 里的 JSON 加到 AI 客户端的 MCP 配置，重启客户端；BOX_MAP_PROJECT 已填好，AI 侧也会从 join 响应自动发现。',
      '这是“活体”通道：命令由当前打开的编辑器标签页执行，人能实时看到 AI 移动镜头、光标和搭建。',
      `把人能复制的最小信息给 AI：编辑器地址 ${manifest.editorUrl} + 识别码 ${state.code}（或直接复制上面的 MCP 配置）。`,
      '这不是纯网页直连：必须有人登录并打开上面的编辑器标签页；AI 侧需要 MCP 客户端或自行发 HTTP。',
      `识别码 ${state.code} 等同这张图的开发邀请，泄露后立即在面板轮换。`,
    ],
  });
}
