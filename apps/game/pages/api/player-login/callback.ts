import { parse, serialize } from 'cookie';
import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiClient } from '@box/apis';
import {
  applicationURL,
  decodeLoginState,
  loginReturnURL,
  transferCookiePrefix,
  transferTokenPattern,
} from '../../../server/player-login-transfer';
import { requestPlayerServiceIp } from '../../../server/player-service-client';

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
    const { state, code } = req.query;
    if (
      typeof state !== 'string' ||
      typeof code !== 'string' ||
      !transferTokenPattern.test(state) ||
      !transferTokenPattern.test(code)
    )
      throw new Error('登录回调无效，请重新登录');
    const cookie = `${transferCookiePrefix}${state}`;
    const options = {
      httpOnly: true,
      secure: applicationURL(source).protocol === 'https:',
      sameSite: 'lax' as const,
      path: '/',
    };
    const pending = decodeLoginState(parse(req.headers.cookie || '')[cookie] || '');
    const returnUrl = loginReturnURL(source, pending.returnUrl);
    res.setHeader('Set-Cookie', [serialize(cookie, '', { ...options, maxAge: 0 })]);
    const secret = process.env.PERMISSION_TOKEN_SECRET;
    const internal = process.env.BOX_PLAYER_SERVICE_INTERNAL_URL;
    if (!secret || !internal) throw new Error('玩家身份服务未配置');
    const api = new ApiClient({
      baseUrl: internal.replace(/\/$/, ''),
      headers: {
        'Authorization': `Bearer ${secret}`,
        'X-Box-Player-IP': requestPlayerServiceIp(req),
        'X-Box-Player-User-Agent': String(req.headers['user-agent'] || '').slice(0, 512),
      },
    });
    const { response, data: credentials } = await api.postApiPlayerInternalLoginTransferRaw({
      body: { code, verifier: pending.verifier, source },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (
      !response.ok ||
      !credentials ||
      !transferTokenPattern.test(credentials.session) ||
      !transferTokenPattern.test(credentials.device)
    )
      throw new Error('登录凭证失效，请重新登录');
    res.setHeader('Set-Cookie', [
      serialize(cookie, '', { ...options, maxAge: 0 }),
      serialize('box_local_player_session', credentials.session, {
        ...options,
        maxAge: 14 * 24 * 3600,
      }),
      serialize('box_local_player_device', credentials.device, {
        ...options,
        maxAge: 365 * 24 * 3600,
      }),
    ]);
    return res.redirect(303, returnUrl);
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
