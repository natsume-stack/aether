import type { NextApiRequest, NextApiResponse } from 'next';

import {
  getEditLock,
  normalizeEditLockActor,
} from '../../../../../server/local-voxa-edit-lock';
import {
  getBlob,
  getModel,
  replaceModelPayload,
  storeBlob,
} from '../../../../../server/local-voxa-store';
import { setLocalCors } from '../../../../../server/local-cors';
import { requireVoxaModelManagement } from '../../../../../server/model-management-access';

export const config = {
  // The write API accepts base64 encoded blobs in JSON, so the default 1 MB
  // body limit is far too small for a real VOXA project.
  api: { bodyParser: { sizeLimit: '300mb' } },
};

const maximumBlobBytes = () =>
  Number(process.env.VOXA_MAX_BLOB_BYTES || 268435456);

type ApiError = Error & { status?: number; code?: string };

function fail(status: number, code: string, message: string): never {
  const error = new Error(message) as ApiError;
  error.status = status;
  error.code = code;
  throw error;
}

function decodeBase64(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    fail(400, 'INVALID_PAYLOAD', `${field} 必须是 base64 字符串`);
  }
  // Accept a `data:...;base64,` prefix because agents commonly hand back a
  // browser-style data URL.
  const normalized = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    fail(400, 'INVALID_BASE64', `${field} 不是合法的 base64`);
  }
  const data = Buffer.from(normalized, 'base64');
  if (!data.length) {
    fail(400, 'INVALID_PAYLOAD', `${field} 内容为空`);
  }
  if (data.length > maximumBlobBytes()) {
    fail(413, 'BLOB_TOO_LARGE', `${field} 超过本地 VOXA 大小限制`);
  }
  return data;
}

async function resolveBlob(params: {
  body: Record<string, any>;
  base64Key: string;
  blobHashKey: string;
  label: string;
  required: boolean;
  contentType?: string;
}) {
  const { body, base64Key, blobHashKey, label, required, contentType } = params;
  const data = decodeBase64(body[base64Key], label);
  const requestedHash = typeof body[blobHashKey] === 'string'
    ? body[blobHashKey].trim()
    : '';

  if (data) {
    const hash = await storeBlob(data, contentType || 'application/octet-stream');
    if (requestedHash && requestedHash !== hash) {
      fail(400, 'BLOB_HASH_MISMATCH', `${label} 的哈希与内容不一致`);
    }
    return { hash, data };
  }

  if (requestedHash) {
    const existing = getBlob(requestedHash);
    if (!existing) {
      fail(404, 'BLOB_NOT_FOUND', `${label} 对应的 blob 不存在：${requestedHash}`);
    }
    return { hash: requestedHash, data: existing.data };
  }

  if (required) {
    fail(400, 'MODEL_FIELD_REQUIRED', `缺少 ${base64Key} 或 ${blobHashKey}`);
  }
  return null;
}

function requireWriteLock(id: number, actor: string) {
  const lock = getEditLock(id);
  if (!lock.locked) {
    fail(409, 'EDIT_LOCK_REQUIRED', '写入前必须先获取模型编辑锁');
  }
  if (lock.actor !== actor) {
    fail(409, 'EDIT_LOCKED', `模型正在由 ${lock.actor} 编辑`);
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req, res)) return res.status(403).end('仅允许本机访问');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'PUT') return res.status(405).end();
  if (!await requireVoxaModelManagement(req, res)) return;

  const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).end();
  if (!getModel(id)) {
    return res.status(404).json({ code: 'MODEL_NOT_FOUND', message: '模型不存在' });
  }

  const body = (req.body || {}) as Record<string, any>;
  const actor = normalizeEditLockActor(body.actor);
  if (!actor) {
    return res.status(400).json({ code: 'ACTOR_REQUIRED', message: '必须提供 actor' });
  }

  try {
    // Reject early so a conflicting agent does not spend time uploading blobs.
    requireWriteLock(id, actor);

    const project = await resolveBlob({
      body,
      base64Key: 'projectBase64',
      blobHashKey: 'projectBlobHash',
      label: 'project',
      required: true,
    });
    const meta = await resolveBlob({
      body,
      base64Key: 'metaBase64',
      blobHashKey: 'metaBlobHash',
      label: 'meta',
      required: true,
      contentType: 'application/json',
    });
    const data = await resolveBlob({
      body,
      base64Key: 'dataBase64',
      blobHashKey: 'dataBlobHash',
      label: 'data',
      required: false,
    });
    const preview = await resolveBlob({
      body,
      base64Key: 'previewBase64',
      blobHashKey: 'previewBlobHash',
      label: 'preview',
      required: false,
      contentType: 'image/png',
    });

    if (!project || !meta) {
      fail(400, 'MODEL_FIELD_REQUIRED', '缺少模型工程或元数据');
    }

    // The VOXA model meta graph points at a data blob. Skin meta is a plain
    // `{version}` object, so only enforce the link when the field exists.
    let metaJSON: Record<string, any> | null = null;
    try {
      metaJSON = JSON.parse(Buffer.from(meta.data).toString('utf8'));
    } catch {
      fail(400, 'MODEL_META_INVALID', 'metaBase64 不是合法 JSON');
    }
    const referencedDataHash =
      metaJSON && typeof metaJSON.dataHash === 'string' ? metaJSON.dataHash : '';
    if (referencedDataHash) {
      if (data && data.hash !== referencedDataHash) {
        fail(400, 'MODEL_DATA_HASH_MISMATCH', 'data 内容与 meta.dataHash 不一致');
      }
      if (!data && !getBlob(referencedDataHash)) {
        fail(400, 'MODEL_DATA_MISSING', `meta 引用的 data blob 不存在：${referencedDataHash}`);
      }
    }

    // Check again immediately before the index swap: a slow upload may have
    // outlived the caller's TTL.
    requireWriteLock(id, actor);

    const updated = await replaceModelPayload({
      id,
      actor,
      projectFileHash: project.hash,
      modelFileHash: meta.hash,
      modelPreviewHash: preview ? preview.hash : undefined,
    });
    if (!updated) {
      return res.status(404).json({ code: 'MODEL_NOT_FOUND', message: '模型不存在' });
    }
    return res.status(200).json(updated);
  } catch (error) {
    const apiError = error as ApiError;
    if (apiError?.status) {
      return res.status(apiError.status).json({
        code: apiError.code || 'MODEL_WRITE_REJECTED',
        message: apiError.message,
        editLock: apiError.status === 409 ? getEditLock(id) : undefined,
      });
    }
    console.error('Failed to write VOXA model payload', error);
    return res.status(500).json({
      code: 'MODEL_WRITE_FAILED',
      message: '保存模型失败',
    });
  }
}
