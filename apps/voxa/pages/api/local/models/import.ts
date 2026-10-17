import type { NextApiRequest, NextApiResponse } from 'next';
import { getModelMetaData, migrateProject, projectSchemaToBytes } from '@box/voxa-project';

import { saveModel, storeBlob } from '../../../../server/local-voxa-store';
import { setLocalCors } from '../../../../server/local-cors';
import { readModelProjectBundle } from '../../../../server/local-voxa-project-bundle';
import { requireVoxaModelManagement } from '../../../../server/model-management-access';

export const config = { api: { bodyParser: false, responseLimit: false } };

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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  if (!await requireVoxaModelManagement(req, res)) return;

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
      creativeMode: bundle.editType === 1 ? 2 : 1,
      modelFileHash,
      modelProjectFileHash: projectFileHash,
      modelPreviewFileHash: storedResources.get('preview.bin')?.hash || '',
    });
    return res.status(201).json({
      ...created,
      // Older .voxaproject files contained only project.bin. They remain
      // editable, but require one VOXA save to regenerate their model blobs
      // and preview before they can be placed in a map.
      requiresResourceResave: !modelFileHash,
    });
  } catch (error) {
    if ((error as Error).message === 'VOXA_BLOB_TOO_LARGE') {
      return res.status(413).json({ message: '模型工程文件超过大小限制' });
    }
    return res.status(400).json({ message: '无法识别这个 VOXA 工程文件' });
  }
}
