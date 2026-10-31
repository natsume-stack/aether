import type { NextApiRequest, NextApiResponse } from 'next';
import { allowCreatorApi } from '../../../../server/creator-api-security';
import { joinMapByCode } from '../../../../server/agent-access';
import {
  mapEditorUrl,
  mapLiveEndpoints,
  mapLivePrerequisites,
  publicCreatorBaseUrl,
} from '../../../../server/agent-live-http';
import { liveStatus } from '../../../../server/agent-live';
import { getLocalProjectManager } from '../../../../server/local-project-manager';

/**
 * POST /api/agent/v1/join   body: { code, name? }
 *
 * 识别码即开发账号：AI（或任何持有识别码的协作方）用地图识别码换取一枚
 * `agx_` 随行令牌。识别码自己选定了地图，因此调用方不需要预先知道 project id；
 * 响应把 project id、编辑器深链和前置条件一并给出，接入方无需再查文档。
 *
 * 作用域：地图识别码 = 这张地图的开发（地形/实体/界面/脚本/保存/产物），
 * 令牌在别的 projectId 上一律失效（CROSS_MAP_TOKEN）。模型-only 的接入走
 * VOXA 侧的同名端点（VOX- 前缀识别码）。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const code = String(req.body?.code || '');
  const name = String(req.body?.name || '');
  if (!code.trim()) {
    return res.status(400).json({
      code: 'INVALID_BODY',
      message: 'body 必须为 { code, name? }',
      hint: 'code 形如 MAP-XXXX-XXXX-XXXX；在编辑器右下角 Agent Active → 识别码 复制。',
    });
  }
  const result = await joinMapByCode({ code, name });
  if (!result.ok) {
    if (result.code === 'AGENT_LIMIT') {
      return res.status(409).json({
        code: result.code,
        message: '该地图的 agent 数量已达上限',
        hint: '在编辑器 Agent Active → Agent 页签吊销不再使用的 agent，再重试。',
      });
    }
    return res.status(401).json({
      code: 'INVALID_CODE',
      message: '识别码无效或已被轮换',
      hint:
        '回编辑器 Agent Active → 识别码 重新复制完整的一串（MAP-XXXX-XXXX-XXXX）。'
        + '轮换后旧码立即失效；如果你刚复制过，确认没有漏字符或混入空格。',
    });
  }

  const baseUrl = publicCreatorBaseUrl(req);
  const editorUrl = mapEditorUrl(baseUrl, result.projectId);
  const status = liveStatus(result.projectId);

  let projectMeta: Record<string, unknown> = { id: result.projectId };
  try {
    const metadata = getLocalProjectManager().getProject(result.projectId);
    projectMeta = {
      id: result.projectId,
      name: metadata.name,
      permanentMapId: metadata.permanentMapId,
      mapSize: metadata.mapSize,
    };
  } catch {
    // A deleted project can still redeem its code; keep the minimal envelope.
  }

  return res.status(201).json({
    token: result.token,
    tokenFingerprint: result.agent.fingerprint,
    agentId: result.agent.id,
    scope: 'map',
    project: projectMeta,
    map: {
      projectId: result.projectId,
      editorUrl,
      attached: status.attached,
      attachedAt: status.attachedAt,
    },
    transport: {
      kind: 'editor-tab-relay',
      client: 'box3-agent-mcp',
      requiresEditorTab: true,
      pureWebDirect: false,
      endpoints: mapLiveEndpoints(baseUrl, result.projectId),
    },
    prerequisites: mapLivePrerequisites(baseUrl, result.projectId),
    usage: {
      auth: `Authorization: Bearer ${result.token}`,
      liveStatus: `GET  ${baseUrl}/api/agent/v1/live/map/${encodeURIComponent(result.projectId)}/status`,
      liveObserve: `POST ${baseUrl}/api/agent/v1/live/map/${encodeURIComponent(result.projectId)}/observe`,
      liveCommand: `POST ${baseUrl}/api/agent/v1/live/map/${encodeURIComponent(result.projectId)}/cmd   # body {kind,args}`,
      tools: `GET  /api/agent/v1/map/${result.projectId}/tools          # 批量面：terrain/entities/ui/script`,
      tool: `POST /api/agent/v1/map/${result.projectId}/tool            # body {tool,args}；写地形前先停预览`,
      status: `GET  /api/agent/v1/map/${result.projectId}/status`,
      save: `POST /api/agent/v1/map/${result.projectId}/save            # 预览运行中会 409，先停预览`,
      artifacts: `POST /api/agent/v1/map/${result.projectId}/artifacts       # 登记 {kind,name,detail}`,
    },
    notes: [
      '活体命令由已打开的编辑器标签页执行；status.attached=false 时先请人打开 editorUrl。',
      '批量面在地图运行时执行，不要求标签页可见；写地形顺序 = 停预览 → 写 → 保存。',
      '令牌只对上面这张地图有效；换图必须用那张图自己的识别码重新 join。',
      '每次调用都会记入该地图的 Agent Active 日志（识别码与令牌在日志中脱敏）。',
    ],
  });
}
