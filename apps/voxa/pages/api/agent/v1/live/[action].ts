import type { NextApiRequest, NextApiResponse } from 'next';

import {
  acknowledgeVoxaCommand,
  attachVoxaEditor,
  detachVoxaEditor,
  pollVoxaEditor,
  progressVoxaEditor,
  voxaLiveStatus,
} from '../../../../../server/agent-live';
import { requireVoxaModelAccess } from '../../../../../server/model-management-access';
import { setLocalCors } from '../../../../../server/local-cors';

/**
 * The VOXA editor's live channel, in one route.
 *
 * `/api/agent/v1/live/<action>` where action is one of
 * attach | next | ack | progress | status | detach | manifest.
 *
 * Kept as a single catch-all instead of six near-identical files: the whole
 * surface shares one guard and one body shape, and VOXA is a separate deploy
 * image, so fewer files is fewer places for the two sides to drift apart.
 */

type LiveRequest = NextApiRequest & { query: { action?: string | string[] } };

function actionOf(req: LiveRequest) {
  const raw = req.query.action;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').trim();
}

function publicVoxaBaseUrl(req: NextApiRequest) {
  const configured = (process.env.BOX_VOXA_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost || (Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protoValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const proto =
    protoValue?.split(',')[0]?.trim() || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  return host ? `${proto}://${host}` : '';
}

export default async function handler(req: LiveRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = actionOf(req);
  if (!action) {
    return res.status(404).json({ code: 'UNKNOWN_ACTION', message: '缺少 live 动作' });
  }
  // The editor tab is a human-facing session; it needs projects.edit to drive
  // the document, and the panel's status poll only needs read access.
  const capability = action === 'status' || action === 'manifest' ? 'projects.edit' : 'projects.edit';
  if (!await requireVoxaModelAccess(req, res, capability)) return;

  if (action === 'attach') {
    if (req.method !== 'POST') return res.status(405).end();
    const snapshot = req.body?.snapshot;
    if (snapshot !== undefined && (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot))) {
      return res.status(400).json({ code: 'INVALID_SNAPSHOT', message: 'snapshot 必须是对象' });
    }
    const attached = attachVoxaEditor({ snapshot });
    return res.status(200).json({ ok: true, ...attached });
  }

  if (action === 'next') {
    if (req.method !== 'GET') return res.status(405).end();
    const sessionId = String(req.query.sessionId || '');
    const after = Number(req.query.after) || 0;
    const result = await pollVoxaEditor(sessionId, after);
    if (result.sessionInvalid) return res.status(409).json(result);
    return res.status(200).json(result);
  }

  if (action === 'ack') {
    if (req.method !== 'POST') return res.status(405).end();
    const accepted = acknowledgeVoxaCommand(String(req.body?.sessionId || ''), {
      id: String(req.body?.id || ''),
      ok: Boolean(req.body?.ok),
      result: req.body?.result,
      error: req.body?.error,
      snapshot: req.body?.snapshot,
      at: String(req.body?.at || new Date().toISOString()),
    });
    if (!accepted) return res.status(409).json({ code: 'SESSION_INVALID', message: '会话已失效' });
    return res.status(200).json({ ok: true });
  }

  if (action === 'progress') {
    if (req.method !== 'POST') return res.status(405).end();
    const accepted = progressVoxaEditor(
      String(req.body?.sessionId || ''),
      req.body?.snapshot || {},
      req.body?.note,
    );
    if (!accepted) return res.status(409).json({ code: 'SESSION_INVALID', message: '会话已失效' });
    return res.status(200).json({ ok: true });
  }

  if (action === 'status') {
    return res.status(200).json(voxaLiveStatus());
  }

  if (action === 'detach') {
    if (req.method !== 'POST') return res.status(405).end();
    return res.status(200).json({ ok: detachVoxaEditor(String(req.body?.sessionId || '')) });
  }

  if (action === 'manifest') {
    const { voxaAgentPanelState } = await import('../../../../../server/agent-access');
    const state = voxaAgentPanelState();
    const baseUrl = publicVoxaBaseUrl(req);
    const env = {
      BOX_VOXA_AGENT_BASE_URL: baseUrl,
      BOX_VOXA_AGENT_CODE: state.code,
    };
    return res.status(200).json({
      ok: true,
      kind: 'voxa',
      baseUrl,
      joinCode: state.code,
      codeUpdatedAt: state.codeUpdatedAt,
      mcpServers: {
        'box3-agent': {
          command: 'node',
          args: ['tools/box3-agent-mcp/src/index.js'],
          env,
        },
      },
      env,
      endpoints: {
        status: `${baseUrl}/api/agent/v1/live/voxa/status`,
        observe: `${baseUrl}/api/agent/v1/live/voxa/observe`,
        command: `${baseUrl}/api/agent/v1/live/voxa/cmd`,
        join: `${baseUrl}/api/agent/v1/join`,
      },
      instructions: [
        '把这个 VOX- 识别码发给 AI：它换取 agx_ 令牌后接管当前打开的 VOXA 编辑器。',
        'AI 会像人一样移动视角、移动体素光标、逐格上色，人能看到建模过程。',
      ],
    });
  }

  return res.status(404).json({ code: 'UNKNOWN_ACTION', message: `未知的 live 动作：${action}` });
}
