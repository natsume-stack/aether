import { playerBanResponse } from './player-ban-response';
import { createHash } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizePlayerAuthRequest, playerAuthClientAddress } from './player-auth-security';
import { changeCurrentPlayerPassword, consumePersistentAuthRateLimit, resolvePlayerIdentity, updateCurrentPlayerProfile } from './local-player-identity';
import { PlayerSelfServiceError, validateSelfPasswordInput } from './player-self-password';

export type PlayerSelfOperation = 'profile' | 'password';

export function validateSelfServiceBody(operation: PlayerSelfOperation, body: unknown): { displayName?: string; currentPassword?: string; newPassword?: string } {
  const fields = operation === 'profile' ? ['displayName'] : ['currentPassword', 'newPassword'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) {
    throw new PlayerSelfServiceError('请求包含不支持的账号字段', 'INVALID_INPUT', 400);
  }
  const values = body as Record<string, unknown>;
  if (operation === 'password') return validateSelfPasswordInput(values);
  if (typeof values.displayName !== 'string' || !/^.{1,32}$/.test(values.displayName.trim())) {
    throw new PlayerSelfServiceError('昵称长度必须为 1 到 32 个字符', 'INVALID_INPUT', 400);
  }
  return { displayName: values.displayName.trim() };
}

export async function handlePlayerSelfService(req: NextApiRequest, res: NextApiResponse, operation: PlayerSelfOperation) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (!authorizePlayerAuthRequest(req, res)) return;
  const method = operation === 'profile' ? 'PATCH' : 'POST';
  if (req.method !== method) {
    res.setHeader('Allow', `${method}, OPTIONS`);
    return res.status(405).end();
  }
  try {
    const values = validateSelfServiceBody(operation, req.body);
    const identity = await resolvePlayerIdentity(req, res);
    if (identity.status !== 'active') throw new PlayerSelfServiceError('账号当前不可用', 'PLAYER_BANNED', 403);
    const password = operation === 'password';
    const windowMs = (password ? 15 : 5) * 60_000;
    for (const [scope, key, maximum] of [
      [`player-${operation}-ip`, playerAuthClientAddress(req), password ? 30 : 100],
      [`player-${operation}-account`, identity.subjectId, password ? 5 : 20],
    ] as const) {
      const limit = await consumePersistentAuthRateLimit(scope, createHash('sha256').update(key).digest('hex'), maximum, windowMs);
      if (!limit) throw new Error('RATE_LIMIT_UNAVAILABLE');
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return res.status(429).json({ code: 'RATE_LIMITED', message: '操作过于频繁，请稍后重试' });
      }
    }
    if (operation === 'password') {
      return res.status(200).json(await changeCurrentPlayerPassword(req, res, values));
    }
    const player = await updateCurrentPlayerProfile(req, res, values);
    return res.status(200).json({ player: {
      subjectId: player.subjectId, userId: player.userId,
      username: player.username, displayName: player.displayName,
    } });
  } catch (error) {
    const ban = playerBanResponse(error);
    if (ban) return res.status(403).json(ban);
    if (error instanceof PlayerSelfServiceError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    const message = (error as Error).message;
    if (message === 'AUTH_REQUIRED') return res.status(401).json({ code: message, message: '登录状态已失效，请重新登录' });
    if (message === 'IP_BANNED' || message === 'DEVICE_BANNED') return res.status(403).json({ code: message, message: '当前访问来源已被封禁' });
    return res.status(503).json({ code: 'ACCOUNT_SERVICE_UNAVAILABLE', message: '账号服务暂时不可用，请稍后重试' });
  }
}
