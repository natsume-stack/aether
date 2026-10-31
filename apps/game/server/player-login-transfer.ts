import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

export type LoginSource = 'play' | 'creator';
export const transferTokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const transferCookiePrefix = 'box_player_login_';
export const transferLifetimeSeconds = 300;

export function applicationURL(source: unknown) {
  if (source !== 'play' && source !== 'creator') throw new Error('登录目标无效');
  const value =
    source === 'play' ? process.env.BOX_PLAY_PUBLIC_URL : process.env.BOX_CREATOR_PUBLIC_URL;
  const url = new URL(
    value || (source === 'play' ? 'http://127.0.0.1:3121' : 'http://127.0.0.1:3127'),
  );
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('应用公网地址无效');
  }
  return url;
}

export function applicationEndpoint(source: LoginSource, path: string) {
  const url = applicationURL(source);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  return url;
}

export function loginReturnURL(source: LoginSource, value: string) {
  const base = applicationURL(source);
  const url = new URL(value || base.href, base);
  const prefix = base.pathname.replace(/\/$/, '');
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
  ) {
    throw new Error('登录返回地址不属于当前应用');
  }
  return url.href;
}

export function transferChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

// The browser keeps only an opaque one-use code; the database cannot recover
// session credentials without that code. Never put the session itself in a URL.
export function sealTransfer(code: string, credentials: { session: string; device: string }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(code).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openTransfer(code: string, sealed: string): { session: string; device: string } {
  const data = Buffer.from(sealed, 'base64url');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(code).digest(),
    data.subarray(0, 12),
  );
  cipher.setAuthTag(data.subarray(12, 28));
  const credentials = JSON.parse(
    Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(),
  );
  if (
    !transferTokenPattern.test(credentials.session) ||
    !transferTokenPattern.test(credentials.device)
  ) {
    throw new Error('登录凭证无效');
  }
  return credentials;
}

function stateSignature(value: string) {
  const key = process.env.PERMISSION_TOKEN_SECRET;
  if (!key) throw new Error('玩家身份服务密钥未配置');
  return createHmac('sha256', key).update(value).digest();
}
export function encodeLoginState(value: { verifier: string; returnUrl: string; expires: number }) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${stateSignature(body).toString('base64url')}`;
}
export function decodeLoginState(value: string) {
  const [body, signature, extra] = value.split('.');
  const expected = stateSignature(body || '');
  const actual = Buffer.from(signature || '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('登录状态无效，请重新登录');
  const state = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
    verifier: string;
    returnUrl: string;
    expires: number;
  };
  if (
    !transferTokenPattern.test(state.verifier) ||
    !Number.isFinite(state.expires) ||
    state.expires < Date.now()
  )
    throw new Error('登录已过期，请重新登录');
  return state;
}
