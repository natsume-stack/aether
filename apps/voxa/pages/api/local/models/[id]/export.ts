import type { NextApiRequest, NextApiResponse } from 'next';
import { getModelMetaData } from '@box/voxa-project';

import { getBlob, getModel } from '../../../../../server/local-voxa-store';
import { setLocalCors } from '../../../../../server/local-cors';
import { requireVoxaModelManagement } from '../../../../../server/model-management-access';
import {
  buildModelProjectBundle,
  type ModelProjectBundleResource,
} from '../../../../../server/local-voxa-project-bundle';

function projectFileName(name: string) {
  const safeName = name
    .trim()
    .slice(0, 100)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.+$/g, '')
    .trim();
  return `${safeName || '未命名模型'}.voxaproject`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  if (req.method !== 'GET') return res.status(405).end();
  if (!await requireVoxaModelManagement(req, res)) return;

  const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).end();

  const model = getModel(id);
  if (!model) return res.status(404).json({ message: '模型不存在' });
  if (!model.projectFileHash) {
    return res.status(409).json({ message: '模型还没有可导出的工程数据，请先进入编辑器保存' });
  }
  const project = getBlob(model.projectFileHash);
  if (!project) return res.status(404).json({ message: '模型工程文件不存在' });

  const resources: ModelProjectBundleResource[] = [];
  const modelMetadata = model.modelFileHash ? getBlob(model.modelFileHash) : null;
  const modelMetaData = modelMetadata
    ? getModelMetaData(model.modelFileHash, new Uint8Array(modelMetadata.data))
    : undefined;
  const modelData = modelMetaData ? getBlob(modelMetaData.dataHash) : null;
  // A renderable model is a two-blob graph: metadata points to model data.
  // Include both together so a package can be imported on another server.
  if (modelMetadata && modelMetaData && modelData) {
    resources.push(
      {
        name: 'model-meta.bin',
        hash: model.modelFileHash,
        data: modelMetadata.data,
        contentType: modelMetadata.contentType,
      },
      {
        name: 'model-data.bin',
        hash: modelMetaData.dataHash,
        data: modelData.data,
        contentType: modelData.contentType,
      },
    );
  }
  const preview = model.modelPreviewHash ? getBlob(model.modelPreviewHash) : null;
  if (preview) {
    resources.push({
      name: 'preview.bin',
      hash: model.modelPreviewHash,
      data: preview.data,
      contentType: preview.contentType,
    });
  }
  const bundle = await buildModelProjectBundle({
    projectName: model.modelName || '未命名模型',
    editType: model.creativeMode === 2 ? 1 : 0,
    projectBytes: project.data,
    resources,
  });
  const filename = projectFileName(model.modelName);
  res.setHeader('Content-Type', 'application/vnd.box.voxaproject+zip');
  res.setHeader('Content-Length', String(bundle.length));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="model.voxaproject"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  return res.status(200).send(bundle);
}
