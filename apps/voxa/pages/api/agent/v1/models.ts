import type { NextApiRequest, NextApiResponse } from 'next';
import { getModelMetaData, migrateProject, projectSchemaToBytes } from '@box/voxa-project';

import { authenticateVoxaAgent, recordVoxaAgentAction } from '../../../../server/agent-access';
import { setLocalCors } from '../../../../server/local-cors';
import {
  listModels,
  saveModel,
  storeBlob,
} from '../../../../server/local-voxa-store';
import { readModelProjectBundle } from '../../../../server/local-voxa-project-bundle';

/**
 * Agent（AI 协作者）的模型构建面 — VOXA 识别码体系的作用域。
 *
 *   GET  /api/agent/v1/models   已有模型清单（id/名称/更新时间，供增量协作）
 *   POST /api/agent/v1/models   原始 .voxaproject bundle 字节 → 导入为新模型
 *
 * POST 的校验链与 /api/local/models/import 完全一致（bundle 解析、schema 迁移、
 * blob 哈希绑定、model-meta/data 校验），区别只在身份：这里认 join 换来的
 * `agx_` 令牌。导入成功即登记一条产物并写审计日志。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const auth = authenticateVoxaAgent(String(req.headers.authorization || ''));
  if (!auth.ok) {
    return res.status(401).json({
      code: 'AGENT_AUTH_REQUIRED',
      message: '需要有效的 agent 令牌；用 VOXA 识别码 POST /api/agent/v1/join 换取',
    });
  }

  if (req.method === 'GET') {
    const models = listModels({}).map((model) => ({
      id: model.modelId,
      name: model.modelName,
      animated: model.animated,
      updatedAt: model.updatedAt,
      revision: model.revision,
      lastEditActor: model.lastEditActor,
    }));
    await recordVoxaAgentAction(auth.agent.id, {
      action: 'GET models',
      result: 'applied',
      detail: `列出 ${models.length} 个模型`,
    });
    return res.status(200).json({ models });
  }

  if (req.method !== 'POST') return res.status(405).end();
  try {
    const body = await readBody(req);
    if (!body.length) return res.status(400).json({ message: '模型工程文件为空' });
    const bundle = await readModelProjectBundle(body);
    const project = migrateProject(bundle.projectBytes);
    if (!project) return res.status(400).json({ message: 'VOXA 工程数据损坏' });
    const normalizedBytes = Buffer.from(projectSchemaToBytes(project));
    const projectFileHash = await storeBlob(normalizedBytes, 'application/octet-stream');
    const storedResources = new Map<string, { hash: string; data: Uint8Array }>();
    for (const resource of bundle.resources) {
      const hash = await storeBlob(Buffer.from(resource.data), resource.contentType);
      if (hash !== resource.hash) throw new Error('VOXA_BUNDLE_RESOURCE_INVALID');
      storedResources.set(resource.name, { hash, data: resource.data });
    }
    const modelMetadata = storedResources.get('model-meta.bin');
    const modelData = storedResources.get('model-data.bin');
    let modelFileHash = '';
    if (modelMetadata && modelData) {
      const metadata = getModelMetaData(modelMetadata.hash, modelMetadata.data);
      if (!metadata || metadata.dataHash !== modelData.hash) {
        throw new Error('VOXA_BUNDLE_RESOURCE_INVALID');
      }
      modelFileHash = modelMetadata.hash;
    } else if (modelMetadata || modelData) {
      throw new Error('VOXA_BUNDLE_RESOURCE_INVALID');
    }
    const created = await saveModel({
      modelName: bundle.projectName,
      modelDescription: '',
      modelType: 0,
      animated: project.animations.length > 0,
      creativeMode: bundle.editType === 1 ? 2 : 1,
      modelFileHash,
      modelProjectFileHash: projectFileHash,
      modelPreviewFileHash: storedResources.get('preview.bin')?.hash || '',
      actor: `agent:${auth.agent.name}`,
    });
    await recordVoxaAgentAction(auth.agent.id, {
      action: 'POST models',
      result: 'applied',
      detail: `导入模型 #${created.modelId} ${created.modelName}`,
      artifact: {
        kind: 'voxa-model',
        name: created.modelName,
        detail: `modelId=${created.modelId} projectHash=${created.projectFileHash}`,
      },
    });
    return res.status(201).json({
      ...created,
      editorUrl: `/?modelId=${created.modelId}&editType=${bundle.editType}`,
      requiresResourceResave: !modelFileHash,
    });
  } catch (error) {
    await recordVoxaAgentAction(auth.agent.id, {
      action: 'POST models',
      result: 'failed',
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });
    if ((error as Error).message === 'VOXA_BLOB_TOO_LARGE') {
      return res.status(413).json({ message: '模型工程文件超过大小限制' });
    }
    return res.status(400).json({ message: '无法识别这个 VOXA 工程文件' });
  }
}

async function readBody(req: NextApiRequest) {
  const chunks: Buffer[] = [];
  const maximumBytes = Number(process.env.VOXA_MAX_BLOB_BYTES || 268435456);
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maximumBytes) throw new Error('VOXA_BLOB_TOO_LARGE');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const config = { api: { bodyParser: false, responseLimit: false } };
