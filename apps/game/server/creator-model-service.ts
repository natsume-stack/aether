import type { NextApiRequest, NextApiResponse } from 'next';
import { requestPlayerServiceIp } from './player-service-client';

const DEFAULT_TIMEOUT_MS = 10_000;

export class CreatorModelServiceError extends Error {
  readonly code: 'VOXA_NOT_CONFIGURED' | 'VOXA_UNAVAILABLE' | 'VOXA_REQUEST_FAILED';
  readonly status: number;

  constructor(
    code: CreatorModelServiceError['code'],
    message: string,
    status = 503,
  ) {
    super(message);
    this.name = 'CreatorModelServiceError';
    this.code = code;
    this.status = status;
  }
}

export function creatorModelServiceURL() {
  return String(process.env.VOXA_INTERNAL_URL || process.env.VOXA_URL || '').replace(/\/$/, '');
}

export function creatorModelEditorURL() {
  return String(process.env.VOXA_URL || '').replace(/\/$/, '');
}

/**
 * Creator's same-origin model APIs authorize the player first, then proxy to
 * VOXA. Preserve the browser session context so VOXA can perform the same
 * real-time permission check for mutations instead of treating the proxy as
 * an anonymous request.
 */
export function creatorModelIdentityHeaders(req: NextApiRequest) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  return {
    Cookie: String(req.headers.cookie || ''),
    'X-Box-Player-IP': requestPlayerServiceIp(req),
    'X-Box-Player-Proto': String(
      Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || 'http',
    ).split(',')[0].trim(),
    'X-Box-Player-User-Agent': String(req.headers['user-agent'] || '').slice(0, 512),
  };
}

export async function requestCreatorModelService(
  pathname: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const baseURL = creatorModelServiceURL();
  if (!baseURL) {
    throw new CreatorModelServiceError(
      'VOXA_NOT_CONFIGURED',
      '模型服务未配置，请先配置并启动 VOXA',
    );
  }

  try {
    return await fetch(`${baseURL}${pathname.startsWith('/') ? pathname : `/${pathname}`}`, {
      ...init,
      signal: init.signal || AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof CreatorModelServiceError) throw error;
    throw new CreatorModelServiceError(
      'VOXA_UNAVAILABLE',
      '模型服务未启动或暂时无法连接',
    );
  }
}

export async function creatorModelServiceError(
  response: Response,
  fallback = '模型服务请求失败',
) {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return new CreatorModelServiceError(
      'VOXA_REQUEST_FAILED',
      parsed.message || fallback,
      response.status,
    );
  } catch {
    return new CreatorModelServiceError(
      'VOXA_REQUEST_FAILED',
      body || fallback,
      response.status,
    );
  }
}

export function sendCreatorModelServiceError(
  res: NextApiResponse,
  error: unknown,
) {
  if (error instanceof CreatorModelServiceError) {
    return res.status(error.status).json({
      code: error.code,
      message: error.message,
      service: { state: error.code === 'VOXA_NOT_CONFIGURED' ? 'disabled' : 'unavailable' },
    });
  }
  return res.status(500).json({
    code: 'VOXA_REQUEST_FAILED',
    message: (error as Error)?.message || '模型服务请求失败',
    service: { state: 'unavailable' },
  });
}

export async function sendCreatorModelBinaryResponse(
  res: NextApiResponse,
  response: Response,
) {
  for (const header of ['content-type', 'content-disposition', 'content-length', 'cache-control']) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  return res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
}
