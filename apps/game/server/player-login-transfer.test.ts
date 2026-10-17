import { createHash } from 'crypto';
import { afterEach, expect, jest, test } from '@jest/globals';
import type { NextApiRequest, NextApiResponse } from 'next';
import start from '../pages/api/player-login/start';
import callback from '../pages/api/player-login/callback';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

function response() {
  const headers = new Map<string, unknown>();
  return {
    headers,
    statusCode: 200,
    destination: '',
    body: undefined as unknown,
    setHeader(name: string, value: unknown) {
      headers.set(name, value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name);
    },
    status(value: number) {
      this.statusCode = value;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
    redirect(status: number, url: string) {
      this.statusCode = status;
      this.destination = url;
      return this;
    },
  };
}
function setup() {
  process.env.BOX_DEPLOYMENT_MODE = 'play';
  process.env.BOX_PLAY_PUBLIC_URL = 'https://play.example.test/play';
  process.env.BOX_PLAYER_LOGIN_URL = 'http://47.111.123.64:3125';
  process.env.BOX_PLAYER_SERVICE_INTERNAL_URL = 'http://player-service:3213';
  process.env.PERMISSION_TOKEN_SECRET = 'test-internal-secret';
}

test('cross-host login installs both session and device cookies at the destination', async () => {
  setup();
  const initial = response();
  await start(
    {
      method: 'GET',
      query: { returnUrl: 'https://play.example.test/play/p/town?room=1' },
      headers: {},
    } as unknown as NextApiRequest,
    initial as unknown as NextApiResponse,
  );
  const login = new URL(initial.destination);
  expect(login.origin).toBe('http://47.111.123.64:3125');
  const state = login.searchParams.get('transferState')!;
  const cookie = String(initial.headers.get('Set-Cookie')).split(';')[0];
  expect(cookie).toContain('box_player_login_');
  globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    expect(request.url).toBe('http://player-service:3213/api/player-internal/login-transfer');
    expect(request.headers.get('authorization')).toBe('Bearer test-internal-secret');
    const body = await request.clone().json();
    expect(createHash('sha256').update(body.verifier).digest('base64url')).toBe(
      login.searchParams.get('transferChallenge'),
    );
    expect(body.source).toBe('play');
    return Response.json({ session: 's'.repeat(43), device: 'd'.repeat(43) });
  });
  const res = response();
  await callback(
    {
      method: 'GET',
      query: { state, code: 'c'.repeat(43) },
      headers: { cookie },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(res.destination).toBe('https://play.example.test/play/p/town?room=1');
  const cookies = res.headers.get('Set-Cookie') as string[];
  expect(
    cookies.some(
      (value) =>
        value.startsWith('box_local_player_session=') &&
        value.includes('Secure') &&
        value.includes('HttpOnly'),
    ),
  ).toBe(true);
  expect(cookies.some((value) => value.startsWith('box_local_player_device='))).toBe(true);
  expect(cookies.every((value) => !value.includes('Domain='))).toBe(true);
});

test('a callback without the initiating browser cookie never exchanges a code', async () => {
  setup();
  globalThis.fetch = jest.fn<typeof fetch>();
  const res = response();
  await callback(
    {
      method: 'GET',
      query: { state: 'a'.repeat(43), code: 'c'.repeat(43) },
      headers: {},
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(res.statusCode).toBe(400);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('login start refuses off-site return URLs', async () => {
  setup();
  const res = response();
  await start(
    {
      method: 'GET',
      query: { returnUrl: 'https://evil.test/steal' },
      headers: {},
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(res.statusCode).toBe(400);
});

test('Creator callbacks work over HTTP at an independent IP and port', async () => {
  setup();
  process.env.BOX_DEPLOYMENT_MODE = 'creator';
  process.env.BOX_CREATOR_PUBLIC_URL = 'http://47.111.123.64:3127';
  const initial = response();
  await start(
    { method: 'GET', query: {}, headers: {} } as unknown as NextApiRequest,
    initial as unknown as NextApiResponse,
  );
  const login = new URL(initial.destination);
  const cookie = String(initial.headers.get('Set-Cookie')).split(';')[0];
  globalThis.fetch = jest.fn<typeof fetch>(async () =>
    Response.json({ session: 's'.repeat(43), device: 'd'.repeat(43) }),
  );
  const res = response();
  await callback(
    {
      method: 'GET',
      query: { state: login.searchParams.get('transferState'), code: 'c'.repeat(43) },
      headers: { cookie },
      socket: {},
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  expect(res.destination).toBe('http://47.111.123.64:3127/');
  expect(
    (res.headers.get('Set-Cookie') as string[]).every((value) => !value.includes('Secure')),
  ).toBe(true);
});

test.each(['expired', 'tampered', 'revoked'])(
  '%s transfers never install a session cookie',
  async (failure) => {
    setup();
    const initial = response();
    await start(
      { method: 'GET', query: {}, headers: {} } as unknown as NextApiRequest,
      initial as unknown as NextApiResponse,
    );
    const login = new URL(initial.destination);
    let cookie = String(initial.headers.get('Set-Cookie')).split(';')[0];
    const realNow = Date.now;
    globalThis.fetch = jest.fn<typeof fetch>(async () =>
      Response.json({ message: 'AUTH_REQUIRED' }, { status: 401 }),
    );
    if (failure === 'expired') Date.now = () => realNow() + 301_000;
    if (failure === 'tampered') cookie += 'invalid';
    const res = response();
    try {
      await callback(
        {
          method: 'GET',
          query: { state: login.searchParams.get('transferState'), code: 'c'.repeat(43) },
          headers: { cookie },
          socket: {},
        } as unknown as NextApiRequest,
        res as unknown as NextApiResponse,
      );
      expect(res.statusCode).toBe(400);
      expect(String(res.headers.get('Set-Cookie') || '')).not.toContain(
        'box_local_player_session=',
      );
      if (failure !== 'revoked') expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  },
);
