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

/**
 * Route family that is contracted to a CLI Bearer token. Every operation under
 * it declares `creatorToken` bearer security in
 * `internals/apis/openapi/openapi.json`; the Creator lifecycle routes
 * (`/api/local-projects/**`, `/api/creator-models/**`, `/api/system/**`) declare
 * no bearer scheme at all and authorise against the account's user-level
 * `creatorPermissions`.
 */
export const CREATOR_CLI_API_PATH_PREFIX = '/api/creator/v1';

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
 * Route path used only to classify a credential. Anything that cannot be
 * classified with certainty returns `''`, which fails closed for a Bearer and
 * never affects the cookie path.
 */
function creatorRequestPathname(req: Pick<NextApiRequest, 'url'>) {
  const raw = String(req.url || '').trim();
  if (!raw) return '';
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname;
    } catch {
      return '';
    }
  }
  for (const cut of [pathname.indexOf('?'), pathname.indexOf('#')]) {
    if (cut >= 0) pathname = pathname.slice(0, cut);
  }
  let decoded = '';
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return '';
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return '';
  return `/${segments.join('/')}`;
}

export function usesCreatorCliBearer(req: Pick<NextApiRequest, 'headers'>) {
  return /^\s*Bearer\s+\S/i.test(String(req.headers.authorization || ''));
}

export function isCreatorCliApiRoute(req: Pick<NextApiRequest, 'url'>) {
  const pathname = creatorRequestPathname(req);
  return pathname === CREATOR_CLI_API_PATH_PREFIX || pathname.startsWith(`${CREATOR_CLI_API_PATH_PREFIX}/`);
}

/**
 * Gate: a CLI Bearer credential may only reach the CLI route family.
 *
 * `player-service-client.ts` forwards *any* `Authorization: Bearer ` value as
 * `X-Box-Creator-Authorization`, and `pages/api/player-internal/runtime-identity.ts`
 * then resolves it with `resolveCreatorCliTokenIdentity` instead of the session
 * cookie. That CLI identity still carries the account's user-level
 * `creatorPermissions`, so a Bearer passed the capability check of
 * `authenticatedCreatorIdentity` no matter which of the nine CLI scopes it holds
 * — the scopes were only ever enforced inside `allowAuthenticatedCreatorCliApi`.
 * One read-only `bxc_…` token could therefore create, publish, export, package,
 * import or delete maps, which silently voids the minimum-privilege promise of
 * CLI scopes and contradicts the OpenAPI contract (those routes declare no
 * bearer scheme, only the `/api/creator/v1/**` operations declare `creatorToken`).
 *
 * The rule is inert for browser sessions, which never send `Authorization`, and
 * inert for `/api/creator/v1/**` — including the scene-control family, which is
 * CLI-contracted and still gated by the account's `projects.edit` permission.
 *
 * One-step rollback: set `BOX_CREATOR_ALLOW_CLI_BEARER_ON_UI_ROUTES=true`.
 */
export function rejectsCreatorCliBearerOnUiRoute(req: Pick<NextApiRequest, 'headers' | 'url'>) {
  if (!usesCreatorCliBearer(req)) return false;
  if (process.env.BOX_CREATOR_ALLOW_CLI_BEARER_ON_UI_ROUTES === 'true') return false;
  return !isCreatorCliApiRoute(req);
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
  if (rejectsCreatorCliBearerOnUiRoute(req)) {
    res.status(403).json({
      code: 'CREATOR_CLI_ROUTE_DENIED',
      message: 'CLI Token 只能调用 /api/creator/v1 接口；此创作端点需要浏览器会话，或为该 Token 申请对应的 CLI scope',
    });
    return undefined;
  }
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
