import { randomBytes } from 'crypto';
import { serialize } from 'cookie';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  applicationURL,
  encodeLoginState,
  loginReturnURL,
  transferChallenge,
  transferCookiePrefix,
  transferLifetimeSeconds,
} from '../../../server/player-login-transfer';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const source = process.env.BOX_DEPLOYMENT_MODE;
  if (source !== 'play' && source !== 'creator') return res.status(404).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  try {
    const login = new URL(process.env.BOX_PLAYER_LOGIN_URL || '');
    if (!['http:', 'https:'].includes(login.protocol) || login.username || login.password)
      throw new Error('登录服务地址无效');
    const returnUrl = loginReturnURL(
      source,
      typeof req.query.returnUrl === 'string' ? req.query.returnUrl : '',
    );
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    res.setHeader(
      'Set-Cookie',
      serialize(
        `${transferCookiePrefix}${state}`,
        encodeLoginState({
          verifier,
          returnUrl,
          expires: Date.now() + transferLifetimeSeconds * 1000,
        }),
        {
          httpOnly: true,
          secure: applicationURL(source).protocol === 'https:',
          sameSite: 'lax',
          path: '/',
          maxAge: transferLifetimeSeconds,
        },
      ),
    );
    login.searchParams.set('source', source);
    login.searchParams.set('returnUrl', returnUrl);
    login.searchParams.set('transferState', state);
    login.searchParams.set('transferChallenge', transferChallenge(verifier));
    return res.redirect(302, login.href);
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
