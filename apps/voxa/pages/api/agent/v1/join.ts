import type { NextApiRequest, NextApiResponse } from 'next';

import { joinVoxaByCode } from '../../../../server/agent-access';
import { setLocalCors } from '../../../../server/local-cors';

/**
 * POST /api/agent/v1/join   body: { code, name? }
 *
 * VOXA 模型开发识别码 → `agx_` 令牌。作用域仅限模型构建（列出 / 导入 / 登记
 * 产物），与地图侧 MAP- 识别码互不相通。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const code = String(req.body?.code || '');
  const name = String(req.body?.name || '');
  if (!code.trim()) {
    return res.status(400).json({ code: 'INVALID_BODY', message: 'body 必须为 { code, name? }' });
  }
  const result = await joinVoxaByCode({ code, name });
  if (!result.ok) {
    const message =
      result.code === 'AGENT_LIMIT' ? 'VOXA 工作区的 agent 数量已达上限' : '识别码无效';
    return res.status(result.code === 'AGENT_LIMIT' ? 409 : 401).json({ code: result.code, message });
  }
  return res.status(201).json({
    token: result.token,
    tokenFingerprint: result.agent.fingerprint,
    agentId: result.agent.id,
    scope: 'voxa',
    scopeNote: '仅模型构建任务：列出模型、导入 .voxaproject、登记产物。地图开发需要地图识别码。',
    usage: {
      list: 'GET  /api/agent/v1/models                       # 已有模型清单',
      import: 'POST /api/agent/v1/models                       # 原始 .voxaproject bundle 字节 → 导入为模型',
      artifacts: 'POST /api/agent/v1/state                       # body {action:"artifact", kind, name, detail}',
    },
    notes: [
      '接受 aether/chisel 管线产物：runModelPipeline 输出的 .voxaproject zip（manifest + project.bin + model-meta.bin + model-data.bin + preview.bin）。',
      '每次调用都会记入 VOXA Agent Active 日志，可在 VOXA 页面面板查看。',
    ],
  });
}
