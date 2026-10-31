import type { NextApiRequest, NextApiResponse } from 'next';

import { requireVoxaEditorAccess } from '../../../server/model-management-access';
import { setLocalCors } from '../../../server/local-cors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function internalURL() {
  const value = (process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || '').trim();
  if (!value) throw new Error('玩家身份服务未配置');
  return value.replace(/\/$/, '');
}

function segments(req: NextApiRequest) {
  const value = req.query.path;
  const parts = (Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] !== 'providers' && parts[0] !== 'preferences') return null;
  if (parts[0] === 'preferences' && parts.length !== 1) return null;
  if (parts[0] === 'providers') {
    if (parts.length >= 2 && !UUID.test(parts[1])) return null;
    if (parts.length > 3) return null;
    if (parts.length === 3 && !['test', 'models'].includes(parts[2])) return null;
  }
  return parts;
}

function requestProtocol(req: NextApiRequest) {
  const forwarded = req.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  if (value?.trim()) return value.trim();
  return process.env.BOX_SERVER_PUBLIC_URL?.startsWith('https://') ? 'https' : 'http';
}

/**
 * Browser-facing provider API. The player-service owns the rows and keys; this
 * deployment only forwards the caller's session and drops the internal secret,
 * so a Creator page never talks to the identity service directly.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!setLocalCors(req, res)) return res.status(403).end();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST, PATCH, PUT, DELETE');
    return res.status(405).end();
  }
  if (!await requireVoxaEditorAccess(req, res)) return;
  const parts = segments(req);
  if (!parts) return res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在' });
  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method || '') && req.body !== undefined
      ? JSON.stringify(req.body)
      : undefined;
    const response = await fetch(`${internalURL()}/api/player-ai-internal/${parts.map(encodeURIComponent).join('/')}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${process.env.PERMISSION_TOKEN_SECRET || ''}`,
        Cookie: String(req.headers.cookie || ''),
        'Content-Type': 'application/json',
        'X-Box-Player-IP': String(req.socket.remoteAddress || ''),
        'X-Box-Player-Proto': requestProtocol(req),
        'X-Box-Player-User-Agent': String(req.headers['user-agent'] || '').slice(0, 512),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = responseHeaders.getSetCookie?.() || [];
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
    else {
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) res.setHeader('Set-Cookie', setCookie);
    }
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    const text = await response.text();
    res.status(response.status);
    return text ? res.send(text) : res.end();
  } catch (error) {
    return res.status(503).json({ code: 'PLAYER_SERVICE_UNAVAILABLE', message: 'Player service unavailable' });
  }
}
