import type { NextApiRequest, NextApiResponse } from 'next';
import { allowCreatorApi } from '../../../../../../server/creator-api-security';
import {
  authenticateMapAgent,
  mapAgentPanelState,
  recordMapAgentAction,
} from '../../../../../../server/agent-access';
import { getLocalProjectManager } from '../../../../../../server/local-project-manager';
import { agentAuthError } from '../../../../../../server/agent-live-http';

/**
 * Agent（AI 协作者）地图创作面 — 识别码体系的令牌作用域。
 *
 *   GET  /api/agent/v1/map/<projectId>/tools       工具目录（runtime internal/ai-tool GET）
 *   POST /api/agent/v1/map/<projectId>/tool        body {tool,args} → runtime AI 工具层
 *   GET  /api/agent/v1/map/<projectId>/status      运行时/预览状态
 *   POST /api/agent/v1/map/<projectId>/save        body {force?} 保存工程
 *   GET|POST /api/agent/v1/map/<projectId>/artifacts  产物登记/查询
 *
 * 与 /api/internal/map-authoring 的差异只有一道门：这里验的是 join 换来的
 * `agx_` 令牌（agent-access.ts HMAC 校验），而不是 loopback 套接字。下游语义
 * 完全复用引擎 AI 工具层（services/game-server/src/edit/ai/map-authoring-tools.ts），
 * 包括 expectedRevision 乐观锁（409）与「预览运行中拒写地形」（409 PREVIEW_RUNNING）
 * 的硬顺序 —— 顺序依然是：停预览 → 写 → 保存。
 *
 * 每个动作在响应边界记一条审计日志（拒绝也记），面板实时可见。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const rawProject = Array.isArray(req.query.projectId)
    ? req.query.projectId[0]
    : req.query.projectId;
  const actionParts = (Array.isArray(req.query.action) ? req.query.action : [req.query.action])
    .filter((part): part is string => Boolean(part));
  const action = actionParts.join('/');

  const reference = resolveProject(rawProject);
  if (!reference) {
    return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: '地图不存在' });
  }
  const auth = authenticateMapAgent(reference, req.headers.authorization);
  if (!auth.ok) {
    const failure = agentAuthError(auth.code);
    return res.status(failure.status).json(failure.body);
  }
  const audit = (result: string, detail: string, artifact?: { kind: string; name: string; detail?: string }) =>
    recordMapAgentAction(reference, auth.agent.id, { action: `${req.method} ${action}`, result, detail, artifact });

  try {
    switch (action) {
      case 'tools': {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
        const response = await fetchRuntime(reference, 'internal/ai-tool', 'GET');
        await audit(response.status === 200 ? 'applied' : 'refused', `工具目录 HTTP ${response.status}`);
        return res.status(response.status).json(response.data);
      }
      case 'tool': {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
        const body = req.body as { tool?: unknown; name?: unknown; args?: unknown; operationId?: unknown } | undefined;
        const toolName =
          (typeof body?.tool === 'string' && body.tool) ||
          (typeof body?.name === 'string' && body.name) ||
          '';
        if (!toolName) {
          await audit('refused', '缺少 tool 名');
          return res.status(400).json({ code: 'INVALID_BODY', message: 'body 必须为 { tool|name, args? }；GET 本路由族 /tools 可列出工具' });
        }
        if (body?.operationId !== undefined && (typeof body.operationId !== 'string' || !/^[\w:.-]{1,100}$/.test(body.operationId))) {
          return res.status(400).json({ code: 'INVALID_OPERATION_ID', message: 'operationId must contain 1–100 letters, digits, _, :, . or -' });
        }
        const response = await fetchRuntime(reference, 'internal/ai-tool', 'POST', {
          tool: toolName,
          args: body?.args ?? {},
          ...(typeof body?.operationId === 'string' ? { operationId: `${auth.agent.id}:${body.operationId}` } : {}),
        });
        const detail = summarize(response.data, `tool=${toolName}`);
        const outcome = (response.data as { result?: { success?: boolean } })?.result;
        await audit(response.status === 200 && outcome?.success !== false ? 'applied' : 'refused', detail);
        return res.status(response.status).json(response.data);
      }
      case 'events': {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
        const after = Number(req.query.after || 0);
        if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ code: 'INVALID_CURSOR' });
        const response = await fetchRuntime(reference, 'internal/ai-tool', 'POST', { tool: 'authoringEvents', args: { after } });
        return res.status(response.status).json(response.data);
      }
      case 'operation': {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
        const operationId = String(req.query.operationId || '');
        if (!/^[\w:.-]{1,100}$/.test(operationId)) return res.status(400).json({ code: 'INVALID_OPERATION_ID' });
        const response = await fetchRuntime(reference, 'internal/ai-tool', 'POST', { tool: 'authoringOperation', args: { operationId: `${auth.agent.id}:${operationId}` } });
        return res.status(response.status).json(response.data);
      }
      case 'status': {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
        const response = await fetchRuntime(reference, 'internal/creator-preview-runtime', 'GET');
        await audit('applied', `状态 HTTP ${response.status}`);
        return res.status(response.status).json(response.data);
      }
      case 'preview': {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
        const action = (req.body as { action?: unknown } | undefined)?.action;
        if (action !== 'start' && action !== 'stop') return res.status(400).json({ code: 'INVALID_PREVIEW_ACTION' });
        const response = await fetchRuntime(reference, 'internal/creator-preview-runtime', 'POST', { action });
        await audit(response.status === 200 ? 'applied' : 'refused', `预览 ${action} HTTP ${response.status}`);
        return res.status(response.status).json(response.data);
      }
      case 'save': {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
        const force = Boolean((req.body as { force?: unknown } | undefined)?.force);
        if (!force) {
          const preview = await fetchRuntime(reference, 'internal/creator-preview-runtime', 'GET').catch(() => null);
          const data = (preview?.data ?? {}) as Record<string, unknown>;
          if (preview?.status === 200 && (data.running === true || data.phase === 'running')) {
            await audit('refused', '预览运行中，保存被拒（PREVIEW_RUNNING）；先停预览或 force=true');
            return res.status(409).json({
              code: 'PREVIEW_RUNNING',
              message: '预览运行中无法保存（terrain 哈希不会被记录）。先停预览，或 body {force:true}',
            });
          }
        }
        const response = await fetchRuntime(reference, 'internal/save-local-project', 'POST');
        await audit(response.status === 200 ? 'saved' : 'refused', `保存 HTTP ${response.status}`);
        return res.status(response.status).json(response.data);
      }
      case 'artifacts': {
        if (req.method === 'GET') {
          const state = mapAgentPanelState(reference);
          return res.status(200).json({ artifacts: state?.artifacts ?? [] });
        }
        const body = req.body as { kind?: unknown; name?: unknown; detail?: unknown } | undefined;
        const name = String(body?.name || '').trim();
        if (!name) {
          await audit('refused', '产物缺少 name');
          return res.status(400).json({ code: 'INVALID_BODY', message: 'body 必须为 { kind, name, detail? }' });
        }
        await audit('applied', String(body?.detail || '').slice(0, 500), {
          kind: String(body?.kind || 'other'),
          name,
          detail: String(body?.detail || ''),
        });
        return res.status(201).json({ ok: true });
      }
      default:
        return res.status(404).json({
          code: 'UNKNOWN_ACTION',
          message: '可用动作：tools (GET) | tool (POST) | events (GET) | operation (GET) | status (GET) | preview (POST) | save (POST) | artifacts (GET/POST)',
        });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { cause?: { code?: string } }).cause?.code
      || (error as NodeJS.ErrnoException).code;
    await audit('failed', error instanceof Error ? error.message.slice(0, 300) : String(error));
    if (code === 'ECONNREFUSED') {
      return res.status(409).json({
        code: 'RUNTIME_NOT_ACTIVE',
        message: '该工程当前没有打开的编辑运行时；请先在 Creator 中打开地图编辑器',
      });
    }
    return res.status(502).json({ code: 'RUNTIME_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
}

function resolveProject(raw: string | undefined): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    return getLocalProjectManager().resolveProjectReference(value);
  } catch {
    return '';
  }
}

function runtimePort(): number {
  return Number(
    process.env.BOX_EDIT_RUNTIME_PORT ||
      process.env.BOX_EDIT_SERVER_PORT ||
      '9967',
  );
}

async function fetchRuntime(
  projectId: string,
  suffix: 'internal/ai-tool' | 'internal/creator-preview-runtime' | 'internal/save-local-project',
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(
    `http://127.0.0.1:${runtimePort()}/${encodeURIComponent(projectId)}/${suffix}`,
    {
      method,
      headers: body
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    },
  );
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function summarize(data: unknown, prefix: string): string {
  const record = (data || {}) as Record<string, any>;
  const code = record.code || record.result?.code || (record.result?.success === false ? 'failed' : 'ok');
  const message = record.message || record.result?.error || '';
  return `${prefix} → ${code}${message ? ` (${String(message).slice(0, 200)})` : ''}`;
}
