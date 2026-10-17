import { createHash, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

import { requestClientAddress } from './client-address';

export const PLAYER_AUTH_API_KEY_HEADER = 'x-box-player-auth-key';

function normalizedOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

function allowedOrigins() {
  const configured = (process.env.BOX_PLAYER_AUTH_ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizedOrigin)
    .filter(Boolean);
  const serviceOrigin = normalizedOrigin(
    process.env.BOX_PLAYER_SERVICE_PUBLIC_URL || 'http://127.0.0.1:3124',
  );
  return new Set([...configured, serviceOrigin].filter(Boolean));
}

function secretsMatch(provided: string, expected: string) {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * The owner-hosted login portal is a server-to-server caller. Only a request
 * that proves possession of its configured API key may supply a forwarded
 * player address while BOX_TRUST_PROXY remains false for direct browsers.
 */
export function hasTrustedPlayerAuthKey(req: NextApiRequest) {
  const expected = (process.env.BOX_PLAYER_AUTH_API_KEY || '').trim();
  if (expected.length < 16) return false;
  const header = req.headers[PLAYER_AUTH_API_KEY_HEADER];
  const provided = String(Array.isArray(header) ? header[0] : header || '');
  return Boolean(provided) && secretsMatch(provided, expected);
}

export function playerAuthClientAddress(req: NextApiRequest) {
  return requestClientAddress(req, hasTrustedPlayerAuthKey(req));
}

function applyCredentialedCors(req: NextApiRequest, res: NextApiResponse) {
  const header = req.headers.origin;
  const origin = Array.isArray(header) ? header[0] : header;
  if (origin) {
    const normalized = normalizedOrigin(origin);
    if (!normalized || !allowedOrigins().has(normalized)) {
      res.status(403).json({
        code: 'AUTH_ORIGIN_NOT_ALLOWED',
        message: '该登录服务来源未被服主允许',
      });
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', normalized);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Content-Type, ${PLAYER_AUTH_API_KEY_HEADER}`,
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return false;
  }
  return true;
}

/**
 * Single security seam for every externally callable player-auth route.
 * The key is server-to-server only and must never be shipped to browser code.
 */
export function authorizePlayerAuthRequest(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (!applyCredentialedCors(req, res)) return false;
  const expected = (process.env.BOX_PLAYER_AUTH_API_KEY || '').trim();
  if (expected.length < 16) {
    res.status(503).json({
      code: 'AUTH_API_KEY_NOT_CONFIGURED',
      message: '服主尚未配置有效的 BOX_PLAYER_AUTH_API_KEY',
    });
    return false;
  }
  if (!hasTrustedPlayerAuthKey(req)) {
    res.status(401).json({
      code: 'AUTH_API_KEY_INVALID',
      message: '玩家认证服务密钥无效',
    });
    return false;
  }
  return true;
}
