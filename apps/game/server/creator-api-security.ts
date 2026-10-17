import type { NextApiRequest, NextApiResponse } from 'next';
import type { RuntimePlayerIdentity } from '@box/utils/local-player-identity';
import type { CreatorCapability } from '../shared/creator-policy';
import { hasCreatorCapability } from '../shared/creator-policy';
import type { CreatorCliCapability } from '../shared/creator-cli-policy';
import {
  PlayerAuthenticationRequiredError,
  requestPlayerServiceIp,
  resolvePlayerServiceIdentity,
} from './player-service-client';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function hostnameOf(value: string | undefined) {
  if (!value) return '';
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return '';
  }
}

function allowedCreatorHosts() {
  const configured = (process.env.BOX_CREATOR_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => hostnameOf(host.trim()))
    .filter(Boolean);
  return new Set([...LOOPBACK_HOSTS, ...configured]);
}

/**
 * Creator APIs can mutate and export editable projects. Keep them unavailable
 * in every other product and reject browser cross-site requests. The
 * deployment manager writes the configured public host into
 * BOX_CREATOR_ALLOWED_HOSTS; this guard remains defense in depth for both
 * local-only and LAN deployments.
 */
export function allowCreatorApi(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'creator') {
    res.status(404).end();
    return false;
  }

  const requestHost = hostnameOf(req.headers.host);
  if (!allowedCreatorHosts().has(requestHost)) {
    res.status(403).json({ message: 'Creator API is only available on an allowed host' });
    return false;
  }

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    res.status(403).json({ message: 'Cross-site creator requests are not allowed' });
    return false;
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        res.status(403).json({ message: 'Creator request origin does not match' });
        return false;
      }
    } catch {
      res.status(403).json({ message: 'Invalid creator request origin' });
      return false;
    }
  }

  return true;
}

export async function allowAuthenticatedCreatorApi(
  req: NextApiRequest,
  res: NextApiResponse,
  capability: CreatorCapability | readonly CreatorCapability[] = 'projects.view',
) {
  return Boolean(await authenticatedCreatorIdentity(req, res, capability));
}

/**
 * Same authorization gate as allowAuthenticatedCreatorApi, but returns the
 * verified identity when a feature must bind a short-lived browser session to
 * its owner. Never derive that owner from a browser supplied value.
 */
export async function authenticatedCreatorIdentity(
  req: NextApiRequest,
  res: NextApiResponse,
  capability: CreatorCapability | readonly CreatorCapability[] = 'projects.view',
): Promise<RuntimePlayerIdentity | undefined> {
  if (!allowCreatorApi(req, res)) return undefined;
  try {
    const { identity } = await resolvePlayerServiceIdentity(
      req,
      res,
      requestPlayerServiceIp(req),
    );
    if (!identity.creatorAccess) {
      res.status(403).json({ code: 'CREATOR_ACCESS_REQUIRED', message: '当前账号没有创作权限' });
      return undefined;
    }
    const requiredCapabilities = Array.isArray(capability) ? capability : [capability];
    if (!requiredCapabilities.some((item) => hasCreatorCapability(identity.creatorPermissions, item))) {
      res.status(403).json({ code: 'CREATOR_PERMISSION_DENIED', message: '当前账号没有执行此创作操作的权限' });
      return undefined;
    }
    return identity;
  } catch (error) {
    if (error instanceof PlayerAuthenticationRequiredError) {
      res.status(401).json({ code: 'AUTH_REQUIRED', message: '请先注册或登录账号' });
      return undefined;
    }
    res.status(503).json({ code: 'PLAYER_SERVICE_UNAVAILABLE', message: '无法验证创作者身份' });
    return undefined;
  }
}

/**
 * Authorizes one explicitly exposed CLI operation. Creator Access remains the
 * product-level gate; CLI scopes deliberately do not inherit Creator UI's
 * individual operation permissions.
 */
export async function allowAuthenticatedCreatorCliApi(
  req: NextApiRequest,
  res: NextApiResponse,
  capability: CreatorCliCapability,
) {
  if (!allowCreatorApi(req, res)) return false;
  try {
    const { identity } = await resolvePlayerServiceIdentity(
      req,
      res,
      requestPlayerServiceIp(req),
    );
    if (!identity.creatorAccess) {
      res.status(403).json({ code: 'CREATOR_ACCESS_REQUIRED', message: '当前账号未获准进入创作端，CLI 不可用' });
      return false;
    }
    if (!identity.creatorCliPermissions?.includes(capability)) {
      res.status(403).json({ code: 'CREATOR_CLI_PERMISSION_DENIED', message: '当前 CLI Token 没有执行此操作的权限' });
      return false;
    }
  } catch (error) {
    if (error instanceof PlayerAuthenticationRequiredError) {
      res.status(401).json({ code: 'AUTH_REQUIRED', message: 'CLI Token 无效或已撤销' });
      return false;
    }
    res.status(503).json({ code: 'PLAYER_SERVICE_UNAVAILABLE', message: '无法验证 CLI Token' });
    return false;
  }
  return true;
}
