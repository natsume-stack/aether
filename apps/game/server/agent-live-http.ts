import fs from 'node:fs';
import path from 'node:path';
import type { NextApiRequest } from 'next';

import { allowCreatorApi } from './creator-api-security';
import { getLocalProjectManager } from './local-project-manager';

/** Resolve a panel container / project reference to the canonical project id. */
export function resolveLiveProject(raw: unknown): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    return getLocalProjectManager().resolveProjectReference(value);
  } catch {
    return '';
  }
}

export function liveEditorGuard(req: NextApiRequest, res: Parameters<typeof allowCreatorApi>[1]) {
  return allowCreatorApi(req, res);
}

export type AgentAuthFailureCode = 'INVALID_TOKEN' | 'NO_ENTRY' | 'CROSS_MAP_TOKEN';

/**
 * Actionable 401 for every agent-facing route. The response never echoes the
 * supplied token, the map code, or another project's id.
 */
export function agentAuthError(code: AgentAuthFailureCode): {
  status: number;
  body: { code: string; message: string; hint: string };
} {
  if (code === 'CROSS_MAP_TOKEN') {
    return {
      status: 401,
      body: {
        code,
        message: '该令牌属于另一张地图，不能在这里使用',
        hint: '用目标地图自己的 MAP- 识别码重新 POST /api/agent/v1/join；地图令牌与 VOXA 令牌都不能跨图。',
      },
    };
  }
  if (code === 'NO_ENTRY') {
    return {
      status: 401,
      body: {
        code,
        message: '该地图还没有 Agent Access 记录',
        hint: '在编辑器右下角打开 Agent Active 面板生成识别码，再用它 join。',
      },
    };
  }
  return {
    status: 401,
    body: {
      code,
      message: '需要有效的 agent 令牌',
      hint: '用识别码 POST /api/agent/v1/join 换取令牌；若刚轮换过识别码，重新 join 即可，已加入的 agent 不受影响。',
    },
  };
}

/**
 * Public origin the agent should call. Prefers the deployment's configured
 * creator URL, keeps the runtime path prefix, and falls back to the request's
 * forwarded host so a LAN/dev deployment still gets a usable value.
 */
export function publicCreatorBaseUrl(req: NextApiRequest): string {
  const configured = (process.env.BOX_CREATOR_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const basePath = (process.env.BOX_APP_BASE_PATH || '').trim().replace(/\/+$/, '');
  const appendBase = (origin: string) =>
    !basePath || origin.endsWith(basePath) ? origin : `${origin}${basePath}`;

  if (configured) return appendBase(configured);

  const forwardedHost = req.headers['x-forwarded-host'];
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost || (Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protoValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const proto = protoValue?.split(',')[0]?.trim() || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  if (!host) return appendBase('');
  return appendBase(`${proto}://${host}`);
}

function mcpEntryPath(): string {
  const configured = (process.env.BOX_AGENT_MCP_ENTRY || '').trim();
  if (configured) return configured;
  const candidates = [
    path.resolve(process.cwd(), 'tools/box3-agent-mcp/src/index.js'),
    path.resolve(process.cwd(), '../../tools/box3-agent-mcp/src/index.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'tools/box3-agent-mcp/src/index.js';
}

/** Deep link a human (or a browser-capable agent) must open for this map. */
export function mapEditorUrl(baseUrl: string, projectId: string): string {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  return `${base}/e/${encodeURIComponent(projectId)}`;
}

export function mapLiveEndpoints(baseUrl: string, projectId: string) {
  const encoded = encodeURIComponent(projectId);
  return {
    status: `${baseUrl}/api/agent/v1/live/map/${encoded}/status`,
    observe: `${baseUrl}/api/agent/v1/live/map/${encoded}/observe`,
    command: `${baseUrl}/api/agent/v1/live/map/${encoded}/cmd`,
    join: `${baseUrl}/api/agent/v1/join`,
  };
}

/**
 * The live channel is not a standalone web API: commands are executed by the
 * editor tab that a signed-in human has open. Say this plainly wherever we hand
 * an agent the connection details, so nobody advertises "pure HTTP direct".
 */
export function mapLivePrerequisites(baseUrl: string, projectId: string): string[] {
  const editorUrl = mapEditorUrl(baseUrl, projectId);
  return [
    `在浏览器登录 Creator 并打开 ${editorUrl}，保持该标签页可见；没有这个标签页，命令会返回 EDITOR_NOT_ATTACHED。`,
    'AI 侧需要能运行 MCP 客户端（tools/box3-agent-mcp）或自行发 HTTP 请求；这不是纯网页直连。',
    '只需要“编辑器地址 + 识别码”两样；project id 由 join 响应返回，不必让用户手抄。',
    '识别码等同这张图的开发邀请：泄露后在 Agent Active 面板轮换，旧码立即无法再加入。',
  ];
}

export function buildMapMcpManifest(options: {
  baseUrl: string;
  joinCode: string;
  projectId: string;
  modelId?: number;
}) {
  const entry = mcpEntryPath();
  const env: Record<string, string> = {
    BOX_MAP_AGENT_BASE_URL: options.baseUrl,
    BOX_MAP_AGENT_CODE: options.joinCode,
    BOX_MAP_PROJECT: options.projectId,
  };
  return {
    mcpServers: {
      'box3-agent': {
        command: 'node',
        args: [entry],
        env,
      },
    },
    entry,
    env,
    editorUrl: mapEditorUrl(options.baseUrl, options.projectId),
    endpoints: mapLiveEndpoints(options.baseUrl, options.projectId),
  };
}
