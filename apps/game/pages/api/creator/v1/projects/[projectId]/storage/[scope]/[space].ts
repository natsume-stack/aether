import type { NextApiRequest, NextApiResponse } from 'next';
import { allowAuthenticatedCreatorCliApi } from '../../../../../../../../server/creator-api-security';
import {
  withCreatorStorage,
  type CreatorStorageScope,
} from '../../../../../../../../server/creator-storage';

const storageNamePattern = /^[a-zA-Z0-9_]{1,50}$/;
const maxKeyBytes = 1024;
const maxValueBytes = 4 * 1024 * 1024;

function first(value: string | string[] | undefined) {
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

function projectId(req: NextApiRequest) {
  return first(req.query.projectId);
}

function scope(req: NextApiRequest): CreatorStorageScope | undefined {
  const value = first(req.query.scope);
  return value === 'project' || value === 'group' ? value : undefined;
}

function space(req: NextApiRequest) {
  const value = first(req.query.space);
  return storageNamePattern.test(value) ? value : undefined;
}

function key(value: unknown) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maxKeyBytes) {
    return undefined;
  }
  return value;
}

function page(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function limit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 50;
  return Math.max(1, Math.min(100, parsed));
}

function isJsonValue(value: unknown) {
  if (value === undefined) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxValueBytes;
  } catch {
    return false;
  }
}

function invalid(res: NextApiResponse, message: string) {
  return res.status(400).json({ code: 'INVALID_STORAGE_REQUEST', message });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, PUT, DELETE');
    return res.status(405).end();
  }
  const capability = req.method === 'GET' ? 'storage.read' : 'storage.write';
  if (!await allowAuthenticatedCreatorCliApi(req, res, capability)) return;

  const id = projectId(req);
  const storageScope = scope(req);
  const storageSpace = space(req);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return invalid(res, '永久地图 ID 无效');
  if (!storageScope) return invalid(res, '数据空间范围必须是 project 或 group');
  if (!storageSpace) return invalid(res, '数据空间名称只能包含字母、数字、下划线，长度最多 50');

  try {
    if (req.method === 'GET') {
      const requestedKey = key(req.query.key);
      if (req.query.key !== undefined && !requestedKey) return invalid(res, '数据键无效');
      const result = await withCreatorStorage(id, async (storage) => {
        if (requestedKey) return { item: await storage.get(storageScope, storageSpace, requestedKey) };
        return storage.list(storageScope, storageSpace, {
          cursor: page(req.query.page),
          pageSize: limit(req.query.limit),
        });
      });
      return res.status(200).json({ projectId: id, scope: storageScope, space: storageSpace, ...result });
    }

    const requestedKey = key(req.body?.key ?? req.query.key);
    if (!requestedKey) return invalid(res, '数据键无效');
    if (req.method === 'PUT') {
      if (!isJsonValue(req.body?.value)) return invalid(res, '数据值必须是最大 4 MiB 的 JSON 值');
      await withCreatorStorage(id, (storage) => storage.set(storageScope, storageSpace, requestedKey, req.body.value));
      const item = await withCreatorStorage(id, (storage) => storage.get(storageScope, storageSpace, requestedKey));
      return res.status(200).json({ projectId: id, scope: storageScope, space: storageSpace, item });
    }

    const item = await withCreatorStorage(id, (storage) => storage.remove(storageScope, storageSpace, requestedKey));
    return res.status(200).json({ projectId: id, scope: storageScope, space: storageSpace, item, deleted: Boolean(item) });
  } catch (error) {
    return res.status(502).json({
      code: 'STORAGE_REQUEST_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
