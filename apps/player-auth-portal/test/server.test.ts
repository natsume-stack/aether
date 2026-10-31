'use strict';

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

import type { PortalOptions } from '../server/config';
import { PortalServer, PortalConfig } from '../server/index';
const createAuthPortalServer = (options:Partial<PortalOptions>) =>
    new PortalServer(
        new PortalConfig({
            apiKey: 'fixture-server-only-key',
            playerServiceURL: new URL('http://127.0.0.1:9'),
            ...options,
        }),
    ).server;
const configFromEnvironment = (env:NodeJS.ProcessEnv = process.env) =>
    PortalConfig.fromEnvironment(env);
const trustedReturnURL = (source:string, requested:string, options:Partial<PortalOptions>) =>
    new PortalConfig({
        apiKey: 'fixture-server-only-key',
        playerServiceURL: new URL('http://127.0.0.1:9'),
        ...options,
    }).returnURL(source, requested);

let upstream:http.Server;
let portal:http.Server;
let upstreamURL:string;
let portalURL:string;
let lastUpstreamRequest:{
    method?:string;
    url?:string;
    headers:http.IncomingHttpHeaders;
    body:string;
};

function listen(server:http.Server):Promise<string> {
    return new Promise<string>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });
}

function close(server:http.Server):Promise<void> {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

before(async () => {
    upstream = http.createServer(async (request, response) => {
        const requestURL = request.url || '/';
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }
        lastUpstreamRequest = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: Buffer.concat(chunks).toString('utf8'),
        };
        response.setHeader('Content-Type', 'application/json');
        if (requestURL.endsWith('/transfer')) {
            if (!String(request.headers.cookie || '').includes('box_player_session=test-token')) {
                response.statusCode = 401;
                response.end(JSON.stringify({ message: 'AUTH_REQUIRED' }));
                return;
            }
            response.end(JSON.stringify({ code: 'c'.repeat(43) }));
            return;
        }
        if (requestURL.endsWith('/profile') || requestURL.endsWith('/password')) {
            if (!String(request.headers.cookie || '').includes('box_local_player_session=')) {
                response.statusCode = 401;
                response.end(JSON.stringify({ code: 'AUTH_REQUIRED', message: '请重新登录' }));
                return;
            }
            if (requestURL.endsWith('/password')) {
                response.setHeader(
                    'Set-Cookie',
                    'box_local_player_session=; Path=/; HttpOnly; Max-Age=0',
                );
                response.end(JSON.stringify({ changed: true, reloginRequired: true }));
                return;
            }
        }
        if (requestURL.endsWith('/session')) {
            response.end(
                JSON.stringify({
                    player: null,
                    databaseEnabled: true,
                    registrationEnabled: true,
                }),
            );
            return;
        }
        response.statusCode = requestURL.endsWith('/register') ? 201 : 200;
        response.setHeader(
            'Set-Cookie',
            'box_player_session=test-token; Path=/; HttpOnly; SameSite=Lax',
        );
        response.end(
            JSON.stringify({
                player: { username: 'tester', displayName: '测试玩家' },
            }),
        );
    });
    upstreamURL = await listen(upstream);
    portal = createAuthPortalServer({
        host: '127.0.0.1',
        port: 0,
        playerServiceURL: new URL(upstreamURL),
        publicURL: null,
        creatorURL: new URL('http://creator.example.test'),
        playURL: new URL('http://play.example.test'),
        apiKey: 'server-only-test-key',
        requestTimeoutMs: 2_000,
        trustProxy: false,
        registrationEnabled: true,
    });
    portalURL = await listen(portal);
});

after(async () => {
    await Promise.all([close(portal), close(upstream)]);
});

test('cross-host login exchanges freshly issued cookies for a code bound to the configured callback', async () => {
    const response = await fetch(`${portalURL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': portalURL },
        body: JSON.stringify({
            username: 'tester',
            password: 'secret',
            source: 'play',
            returnUrl: 'https://attacker.test/steal',
            transferState: 's'.repeat(43),
            transferChallenge: 'v'.repeat(43),
        }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    const callback = new URL(data.returnUrl);
    assert.equal(callback.origin, 'http://play.example.test');
    assert.equal(callback.pathname, '/api/player-login/callback');
    assert.equal(callback.searchParams.get('code'), 'c'.repeat(43));
    assert.equal(callback.searchParams.get('state'), 's'.repeat(43));
    assert.equal(lastUpstreamRequest.url, '/api/player-auth/transfer');
    assert.deepEqual(JSON.parse(lastUpstreamRequest.body), {
        source: 'play',
        challenge: 'v'.repeat(43),
    });
    assert.ok(String(lastUpstreamRequest.headers.cookie).includes('box_player_session=test-token'));
    assert.ok(
        response.headers.getSetCookie().some((value) => value.startsWith('box_player_session=')),
    );
    assert.ok(!JSON.stringify(data).includes('test-token'));
});

test('nickname and password APIs forward only self-service fields, sessions and cookie revocation', async () => {
    const profile = await fetch(
        `${portalURL}/api/auth/profile?source=play&returnUrl=http://play.example.test/`,
        {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Origin': portalURL,
                'Cookie': 'box_local_player_session=fixture; box_local_player_device=device',
            },
            body: JSON.stringify({ displayName: '新昵称' }),
        },
    );
    assert.equal(profile.status, 200);
    assert.equal(lastUpstreamRequest.method, 'PATCH');
    assert.equal(lastUpstreamRequest.url, '/api/player-auth/profile');
    assert.deepEqual(JSON.parse(lastUpstreamRequest.body), { displayName: '新昵称' });
    assert.match(lastUpstreamRequest.headers.cookie || '', /box_local_player_session=fixture/);
    assert.equal((await profile.json()).returnUrl, undefined);
    const password = await fetch(`${portalURL}/api/auth/password`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Origin': portalURL,
            'Cookie': 'box_local_player_session=fixture',
        },
        body: JSON.stringify({
            currentPassword: 'old-password-123',
            newPassword: 'new-password-456',
        }),
    });
    assert.equal(password.status, 200);
    assert.deepEqual(await password.json(), { changed: true, reloginRequired: true });
    assert.match(password.headers.get('set-cookie') || '', /Max-Age=0/);
    assert.equal(lastUpstreamRequest.url, '/api/player-auth/password');
    assert.deepEqual(JSON.parse(lastUpstreamRequest.body), {
        currentPassword: 'old-password-123',
        newPassword: 'new-password-456',
    });
    assert.equal(lastUpstreamRequest.headers['x-box-player-auth-key'], 'server-only-test-key');
});

test('self-service proxy rejects avatar/identity fields and cross-origin writes and preserves upstream session errors', async () => {
    for (const [api, method, body] of [
        ['profile', 'PATCH', { displayName: 'new', avatar: 'ignored' }],
        ['profile', 'PATCH', { displayName: 'new', avatarSkinId: 'pilot' }],
        [
            'password',
            'POST',
            { currentPassword: 'old', newPassword: 'new-password-456', subjectId: 'other-player' },
        ],
    ] as const) {
        const previous = lastUpstreamRequest;
        const rejected = await fetch(`${portalURL}/api/auth/${api}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'Origin': portalURL },
            body: JSON.stringify(body),
        });
        assert.equal(rejected.status, 400);
        assert.equal(lastUpstreamRequest, previous);
    }
    const forbidden = await fetch(`${portalURL}/api/auth/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://untrusted.test' },
        body: JSON.stringify({ displayName: 'new' }),
    });
    assert.equal(forbidden.status, 403);
    const missing = await fetch(`${portalURL}/api/auth/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Origin': portalURL },
        body: JSON.stringify({ displayName: 'new' }),
    });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, 'AUTH_REQUIRED');
});

test('requires a server-side API key', () => {
    assert.throws(
        () =>
            configFromEnvironment({
                AUTH_DEMO_PLAYER_SERVICE_URL: 'http://127.0.0.1:3213',
                AUTH_DEMO_API_KEY: 'short',
            }),
        /at least 16 characters/,
    );
});

test('reads the owner registration policy from the environment', () => {
    const config = configFromEnvironment({
        AUTH_DEMO_PLAYER_SERVICE_URL: 'http://127.0.0.1:3213',
        AUTH_DEMO_API_KEY: 'server-only-test-key',
        AUTH_DEMO_REGISTRATION_ENABLED: 'false',
    });
    assert.equal(config.registrationEnabled, false);
});

test('hides and rejects registration when the owner disabled it', async () => {
    const disabledPortal = createAuthPortalServer({
        host: '127.0.0.1',
        port: 0,
        playerServiceURL: new URL(upstreamURL),
        publicURL: null,
        creatorURL: new URL('http://creator.example.test'),
        playURL: new URL('http://play.example.test'),
        apiKey: 'server-only-test-key',
        requestTimeoutMs: 2_000,
        trustProxy: false,
        registrationEnabled: false,
    });
    const disabledPortalURL = await listen(disabledPortal);
    try {
        const sessionResponse = await fetch(`${disabledPortalURL}/api/auth/session`);
        assert.equal(sessionResponse.status, 200);
        assert.equal((await sessionResponse.json()).registrationEnabled, false);

        const previousRequest = lastUpstreamRequest;
        const registerResponse = await fetch(`${disabledPortalURL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Origin': disabledPortalURL },
            body: JSON.stringify({
                username: 'blocked-user',
                displayName: 'Blocked User',
                password: 'password-123',
            }),
        });
        assert.equal(registerResponse.status, 403);
        assert.equal((await registerResponse.json()).code, 'REGISTRATION_DISABLED');
        assert.equal(lastUpstreamRequest, previousRequest);
    } finally {
        await close(disabledPortal);
    }
});

test('health check does not depend on Player Service', async () => {
    const previousRequest = lastUpstreamRequest;
    const response = await fetch(`${portalURL}/api/health-check`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        status: 'ok',
        service: 'player-auth-portal',
    });
    assert.equal(lastUpstreamRequest, previousRequest);
});

test('return URLs stay on the configured Creator or Play origin', () => {
    const config = {
        creatorURL: new URL('https://creator.example.com'),
        playURL: new URL('https://play.example.com'),
    };
    assert.equal(
        trustedReturnURL('play', 'https://play.example.com/p/world', config),
        'https://play.example.com/p/world',
    );
    assert.equal(
        trustedReturnURL('play', 'https://evil.example/steal', config),
        'https://play.example.com/',
    );
    assert.equal(trustedReturnURL('unknown', 'https://evil.example', config), null);
});

test('login is proxied without exposing the API key to the browser', async () => {
    const response = await fetch(`${portalURL}/api/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Origin': portalURL,
            'Cookie': 'existing=value',
            'X-Forwarded-For': '203.0.113.9',
        },
        body: JSON.stringify({
            username: 'tester',
            password: 'password-123',
            source: 'play',
            returnUrl: 'http://play.example.test/p/my-map',
            ignored: 'must-not-be-forwarded',
        }),
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.returnUrl, 'http://play.example.test/p/my-map');
    assert.match(response.headers.get('set-cookie') || '', /box_player_session=test-token/);
    assert.equal(lastUpstreamRequest.url, '/api/player-auth/login');
    assert.equal(lastUpstreamRequest.headers['x-box-player-auth-key'], 'server-only-test-key');
    assert.equal(lastUpstreamRequest.headers.cookie, 'existing=value');
    assert.equal(
        lastUpstreamRequest.headers['x-forwarded-for'],
        '127.0.0.1',
        'untrusted forwarding headers must not spoof the registration or login IP',
    );
    assert.deepEqual(JSON.parse(lastUpstreamRequest.body), {
        username: 'tester',
        password: 'password-123',
    });
    assert.equal(JSON.stringify(data).includes('server-only-test-key'), false);
});

test('configured public URL does not reject a request made through another host', async () => {
    const fixedURLPortal = createAuthPortalServer({
        host: '127.0.0.1',
        port: 0,
        playerServiceURL: new URL(upstreamURL),
        publicURL: new URL('http://127.0.0.1:3214'),
        creatorURL: new URL('http://creator.example.test'),
        playURL: new URL('http://play.example.test'),
        apiKey: 'server-only-test-key',
        requestTimeoutMs: 2_000,
        trustProxy: false,
        registrationEnabled: true,
    });
    const fixedURL = await listen(fixedURLPortal);
    try {
        const response = await fetch(`${fixedURL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': fixedURL,
            },
            body: JSON.stringify({ username: 'tester', password: 'password-123' }),
        });
        assert.equal(response.status, 200);
    } finally {
        await close(fixedURLPortal);
    }
});

test('cross-origin browser posts are rejected before reaching Player Service', async () => {
    const previousRequest = lastUpstreamRequest;
    const response = await fetch(`${portalURL}/api/auth/logout`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Origin': 'https://evil.example',
        },
        body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(lastUpstreamRequest, previousRequest);
});

test('older engine clients first establish browser state at the configured application', async () => {
    const server = createAuthPortalServer({
        playerServiceURL: new URL(upstreamURL),
        publicURL: new URL('http://47.111.123.64:3125'),
        playURL: new URL('https://play.example.test/play'),
    });
    const url = await listen(server);
    try {
        const response = await fetch(`${url}/?source=play&returnUrl=https://evil.test/`, {
            redirect: 'manual',
        });
        assert.equal(response.status, 302);
        const target = new URL(response.headers.get('location')!);
        assert.equal(target.origin, 'https://play.example.test');
        assert.equal(target.pathname, '/play/api/player-login/start');
        assert.equal(target.searchParams.get('returnUrl'), 'https://play.example.test/play');
    } finally {
        await close(server);
    }
});
