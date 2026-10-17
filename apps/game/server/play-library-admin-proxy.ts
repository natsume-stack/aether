import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';

import { playerAdminRoute } from './player-admin-route';

function playLibraryURL() {
  const value = (process.env.BOX_PLAY_INTERNAL_URL || process.env.BOX_PLAY_PUBLIC_URL || '').trim();
  if (!value) throw new Error('未配置游玩端内部地址');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('游玩端内部地址无效');
  return url.toString().replace(/\/$/, '');
}

function ownerToken() {
  const value = (process.env.BOX_PLAY_ADMIN_TOKEN || '').trim();
  if (value.length < 16) throw new Error('服主管理密钥未配置');
  return value;
}

function target(path: string, query: NextApiRequest['query']) {
  const url = new URL(`${playLibraryURL()}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (key === 'id' || key === 'section') continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') url.searchParams.append(key, item);
    }
  }
  return url.toString();
}

async function relay(response: Response, res: NextApiResponse) {
  const contentType = response.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  const disposition = response.headers.get('content-disposition');
  if (disposition) res.setHeader('Content-Disposition', disposition);
  res.statusCode = response.status;
  if (!response.body) return res.end();
  Readable.fromWeb(response.body as never).pipe(res);
  return res;
}

async function proxy(req: NextApiRequest, res: NextApiResponse, path: string, rawBody = false) {
  const method = req.method || 'GET';
  const headers: Record<string, string> = { Authorization: `Bearer ${ownerToken()}` };
  let body: BodyInit | undefined;
  if (!['GET', 'HEAD'].includes(method)) {
    if (rawBody) {
      if (typeof req.headers['content-type'] === 'string') headers['Content-Type'] = req.headers['content-type'];
      body = req as unknown as BodyInit;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body || {});
    }
  }
  const response = await fetch(target(path, req.query), {
    method,
    headers,
    body,
    ...(rawBody ? { duplex: 'half' as never } : {}),
  } as RequestInit);
  return relay(response, res);
}

export const playLibraryAdminRoute = playerAdminRoute({
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  // Reading maps is safe for delegated map operators; every mutation still
  // requires the paired management capability before the owner token is used
  // to reach Play's internal API.
  requirement: (req) => {
    return ['GET', 'HEAD'].includes(req.method || 'GET')
      ? 'play-maps.view'
      : 'play-maps.manage'
  },
  errorContext: 'Play library administration proxy failed',
}, async ({ req, res }) => {
  const section = Array.isArray(req.query.section) ? req.query.section[0] : req.query.section;
  if (!['worlds', 'world-status', 'import-resource', 'import'].includes(String(section || ''))) {
    return res.status(404).json({ message: '管理接口不存在' });
  }
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const path = section === 'worlds'
    ? id ? `/api/play-admin/worlds/${encodeURIComponent(id)}` : '/api/play-admin/worlds'
    : section === 'world-status'
      ? '/api/play-admin/worlds/status'
      : section === 'import-resource'
        ? '/api/play-admin/import-resource'
        : '/api/play-admin/import';
  return proxy(req, res, path, section === 'import' && req.method === 'POST');
});
