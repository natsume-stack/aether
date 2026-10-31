import {
  authorizePlayerAuthRequest,
  playerAuthClientAddress,
} from './player-auth-security';
import {
  PlayerLoginURLNotConfiguredError,
  playerLoginURL,
  requirePlayerLoginURL,
} from './player-service-client';
import { getServerSideProps as getLoginRequiredServerSideProps } from '../pages/login-required';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function responseMock() {
  const headers = new Map<string, string>();
  return {
    headers,
    statusCode: 0,
    body: undefined as unknown,
    ended: false,
    setHeader(name: string, value: string) { headers.set(name, value); },
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

describe('public player authentication boundary', () => {
  test('starts a browser-bound exchange before redirecting to an independent login host', () => {
    process.env.BOX_PLAYER_LOGIN_URL = 'https://accounts.example.com/sign-in?brand=box';
    process.env.BOX_PLAY_PUBLIC_URL = 'https://play.example.com';
    const login = new URL(playerLoginURL('play', 'https://play.example.com/p/demo?room=1'));
    expect(login.origin + login.pathname).toBe('https://play.example.com/api/player-login/start');
    expect(login.searchParams.get('returnUrl')).toBe('https://play.example.com/p/demo?room=1');
  });

  test('keeps direct login navigation when the application and portal share an origin', () => {
    process.env.BOX_PLAYER_LOGIN_URL = 'https://play.example.com/auth?brand=box';
    process.env.BOX_PLAY_PUBLIC_URL = 'https://play.example.com/play';
    const login = new URL(playerLoginURL('play'));
    expect(login.pathname).toBe('/auth');
    expect(login.searchParams.get('brand')).toBe('box');
    expect(login.searchParams.get('source')).toBe('play');
  });

  test('rejects an untrusted return origin and missing login configuration', () => {
    process.env.BOX_PLAYER_LOGIN_URL = 'https://accounts.example.com/sign-in';
    process.env.BOX_CREATOR_PUBLIC_URL = 'https://creator.example.com';
    const login = new URL(playerLoginURL('creator', 'https://attacker.example/steal'));
    expect(login.searchParams.get('returnUrl')).toBe('https://creator.example.com/');
    delete process.env.BOX_PLAYER_LOGIN_URL;
    expect(() => requirePlayerLoginURL('creator')).toThrow(PlayerLoginURLNotConfiguredError);
    expect(playerLoginURL('creator')).toBe(
      '/login-required?source=creator',
    );
  });

  test('renders the unavailable page when no external login URL is configured', async () => {
    delete process.env.BOX_PLAYER_LOGIN_URL;
    const response = responseMock();
    const result = await getLoginRequiredServerSideProps({
      query: { source: 'play' },
      res: response,
    } as never);
    expect(response.statusCode).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(result).toEqual({ props: { source: 'play' } });
  });

  test('allows credentialed requests only from exact configured origins', () => {
    process.env.BOX_PLAYER_SERVICE_PUBLIC_URL = 'https://player.example.com';
    process.env.BOX_PLAYER_AUTH_ALLOWED_ORIGINS = 'https://login.example.com';
    process.env.BOX_PLAYER_AUTH_API_KEY = 'test-player-auth-key-123';
    const allowed = responseMock();
    expect(authorizePlayerAuthRequest({
      method: 'POST', headers: {
        origin: 'https://login.example.com',
        'x-box-player-auth-key': 'test-player-auth-key-123',
      },
    } as never, allowed as never)).toBe(true);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://login.example.com');
    expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true');

    const rejected = responseMock();
    expect(authorizePlayerAuthRequest({
      method: 'POST', headers: { origin: 'https://evil.example.com' },
    } as never, rejected as never)).toBe(false);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.body).toEqual(expect.objectContaining({ code: 'AUTH_ORIGIN_NOT_ALLOWED' }));
  });

  test('handles allowed preflight and server-to-server requests', () => {
    process.env.BOX_PLAYER_AUTH_ALLOWED_ORIGINS = 'https://login.example.com';
    process.env.BOX_PLAYER_AUTH_API_KEY = 'test-player-auth-key-123';
    const preflight = responseMock();
    expect(authorizePlayerAuthRequest({
      method: 'OPTIONS', headers: { origin: 'https://login.example.com' },
    } as never, preflight as never)).toBe(false);
    expect(preflight.statusCode).toBe(204);
    expect(preflight.ended).toBe(true);

    const serverRequest = responseMock();
    expect(authorizePlayerAuthRequest({
      method: 'POST', headers: { 'x-box-player-auth-key': 'test-player-auth-key-123' },
    } as never, serverRequest as never)).toBe(true);
  });

  test('requires a configured server-side API key for every auth operation', () => {
    delete process.env.BOX_PLAYER_AUTH_API_KEY;
    const missing = responseMock();
    expect(authorizePlayerAuthRequest({ method: 'POST', headers: {} } as never, missing as never)).toBe(false);
    expect(missing.statusCode).toBe(503);
    expect(missing.body).toEqual(expect.objectContaining({ code: 'AUTH_API_KEY_NOT_CONFIGURED' }));

    process.env.BOX_PLAYER_AUTH_API_KEY = 'test-player-auth-key-123';
    const invalid = responseMock();
    expect(authorizePlayerAuthRequest({
      method: 'POST', headers: { 'x-box-player-auth-key': 'wrong-key' },
    } as never, invalid as never)).toBe(false);
    expect(invalid.statusCode).toBe(401);
    expect(invalid.body).toEqual(expect.objectContaining({ code: 'AUTH_API_KEY_INVALID' }));
  });

  test('uses a forwarded player address only for the authenticated login portal', () => {
    process.env.BOX_PLAYER_AUTH_API_KEY = 'test-player-auth-key-123';
    const forwarded = {
      headers: {
        'x-box-player-auth-key': 'test-player-auth-key-123',
        'x-forwarded-for': '203.0.113.20, 172.18.0.3',
      },
      socket: { remoteAddress: '172.18.0.3' },
    } as never;
    expect(playerAuthClientAddress(forwarded)).toBe('203.0.113.20');

    const forged = {
      headers: {
        'x-box-player-auth-key': 'wrong-key',
        'x-forwarded-for': '203.0.113.21',
      },
      socket: { remoteAddress: '172.18.0.4' },
    } as never;
    expect(playerAuthClientAddress(forged)).toBe('172.18.0.4');
  });
});
