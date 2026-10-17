import type { NextApiRequest, NextApiResponse } from 'next';

import { createAdminActionContext, type AdminActionContext } from './local-player-identity';
import { resolvePlayerAdminSession } from './player-admin-identity';
import type { PlayerAdminIdentity } from './player-admin-identity';
import { playerAdminRequestError } from './player-admin-errors';
import {
  roleHasPlayerAdminPermission,
  type PlayerAdminCapability,
  type PlayerAdminRequirement,
  type PlayerAdminRole,
} from '@box/player-policy';

export type PlayerAdminActor = AdminActionContext & {
  actor: string;
  /** Login name, kept separate from the stable audit actor identifier. */
  actorUsername?: string;
  actorDisplayName: string;
  actorRole: PlayerAdminRole;
  actorPermissions: PlayerAdminCapability[];
  subjectId: string;
  credential: 'account' | 'owner-session';
};

export { roleHasPlayerAdminPermission } from '@box/player-policy';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizedOrigin(value: string | undefined) {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function requestOrigins(req: NextApiRequest) {
  const origins = new Set<string>();
  for (const configured of [
    process.env.BOX_PLAYER_SERVICE_PUBLIC_URL,
    process.env.BOX_SERVER_PUBLIC_URL,
  ]) {
    const origin = normalizedOrigin(configured);
    if (origin) origins.add(origin);
  }
  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const host =
    process.env.BOX_TRUST_PROXY === 'true'
      ? forwardedHost || req.headers.host
      : req.headers.host;
  if (host) {
    const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim();
    const protocol =
      process.env.BOX_TRUST_PROXY === 'true' && forwardedProtocol
        ? forwardedProtocol
        : 'http';
    const origin = normalizedOrigin(`${protocol}://${host}`);
    if (origin) origins.add(origin);
  }
  return origins;
}

export function applyPlayerAdminSecurityHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

export function sendPlayerAdminApiError(
  res: NextApiResponse,
  error: unknown,
  context: string,
) {
  const requestError = playerAdminRequestError(error);
  if (requestError) {
    if (requestError.retryAfterSeconds) {
      res.setHeader('Retry-After', String(requestError.retryAfterSeconds));
    }
    return res.status(requestError.status).json({ message: requestError.message });
  }
  console.error(`${context}:`, error instanceof Error ? error.message : String(error));
  return res.status(503).json({ message: '玩家管理服务暂时不可用' });
}

export function allowPlayerAdminRequestOrigin(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  applyPlayerAdminSecurityHeaders(res);
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    res.status(403).json({ message: '管理请求来源无效' });
    return false;
  }
  const header = req.headers.origin;
  const supplied = normalizedOrigin(
    String(Array.isArray(header) ? header[0] : header || ''),
  );
  if (header && (!supplied || !requestOrigins(req).has(supplied))) {
    res.status(403).json({ message: '管理请求来源无效' });
    return false;
  }
  return true;
}

export function actorHasPlayerAdminPermission(
  actor: Pick<PlayerAdminActor, 'actorRole' | 'actorPermissions' | 'credential'>,
  requirement: PlayerAdminRequirement,
) {
  if (requirement === 'owner') {
    return actor.actorRole === 'owner' && actor.credential === 'owner-session';
  }
  return roleHasPlayerAdminPermission(
    actor.actorRole,
    requirement,
    actor.actorPermissions,
  );
}

export function playerAdminIdentity(actor: PlayerAdminActor): PlayerAdminIdentity {
  return {
    id: actor.subjectId,
    username: actor.actor,
    displayName: actor.actorDisplayName,
    role: actor.actorRole,
    permissions: actor.actorPermissions,
    status: 'active',
    credential: actor.credential,
  };
}

/**
 * The only authorization seam for player-management APIs. Player cookies,
 * player roles and player passwords are intentionally never consulted here.
 */
export async function authorizePlayerAdmin(
  req: NextApiRequest,
  res: NextApiResponse,
  requirement: PlayerAdminRequirement | PlayerAdminRequirement[] = 'players.view',
): Promise<PlayerAdminActor | null> {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') {
    res.status(404).end();
    return null;
  }
  if (!allowPlayerAdminRequestOrigin(req, res)) return null;

  try {
    const identity = await resolvePlayerAdminSession(req, {
      requireCsrf: !SAFE_METHODS.has(req.method || 'GET'),
    });
    const requirements = Array.isArray(requirement) ? requirement : [requirement];
    const denied = requirements.find(
      (item) => item === 'owner'
        ? identity.role !== 'owner' || identity.credential !== 'owner-session'
        : !roleHasPlayerAdminPermission(identity.role, item, identity.permissions),
    );
    if (denied) {
      res.status(403).json({
        message:
          denied === 'owner'
            ? '此操作仅限服主密钥会话'
            : '当前管理账号没有执行此操作的权限',
      });
      return null;
    }
    return {
      ...createAdminActionContext(req),
      actor:
        identity.credential === 'owner-session'
          ? 'server-owner'
          : `admin:${identity.id}`,
      actorUsername: identity.username,
      actorDisplayName: identity.displayName,
      actorRole: identity.role,
      actorPermissions: identity.permissions,
      subjectId: identity.id,
      credential: identity.credential,
    };
  } catch (error) {
    sendPlayerAdminApiError(res, error, 'Player admin authorization failed');
    return null;
  }
}
