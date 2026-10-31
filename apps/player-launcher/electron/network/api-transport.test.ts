import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiTransport, mergeCookies, validateRequestUrl } from './api-transport';

test('API requests are restricted to server API and advertised login routes', () => {
    const base = new URL('https://play.example.com/base');
    assert.equal(
        validateRequestUrl(base, 'https://play.example.com/base/api/health-check').pathname,
        '/base/api/health-check',
    );
    assert.throws(() =>
        validateRequestUrl(base, 'https://other.example.com/base/api/health-check'),
    );
    assert.throws(() => validateRequestUrl(base, 'https://play.example.com/elsewhere'));
    assert.equal(
        validateRequestUrl(
            base,
            'https://accounts.example.com/api/auth/login',
            'https://accounts.example.com',
        ).pathname,
        '/api/auth/login',
    );
    assert.throws(() =>
        validateRequestUrl(
            base,
            'https://accounts.example.com/api/private',
            'https://accounts.example.com',
        ),
    );
    assert.throws(() =>
        validateRequestUrl(
            base,
            'https://play.example.com/base/api/health-check',
            undefined,
            'POST',
        ),
    );
    assert.throws(() =>
        validateRequestUrl(base, 'https://play.example.com/base/api/play-admin/players'),
    );
});

test('HTTP player servers can use an advertised login portal on the same hostname', async () => {
    const requests:string[] = [];
    const transport = createApiTransport({
        fetchImpl: async (url) => {
            requests.push(String(url));
            return Response.json({ loginApiUrl: 'http://203.0.113.9:3125/api/auth/login' });
        },
    });
    await transport.request({
        endpoint: 'http://203.0.113.9:3121',
        url: 'http://203.0.113.9:3121/api/player-launcher/bootstrap',
        method: 'GET',
    });
    await transport.request({
        endpoint: 'http://203.0.113.9:3121',
        url: 'http://203.0.113.9:3125/api/auth/login',
        method: 'POST',
        body: '{}',
    });
    assert.equal(requests.length, 2);
});

test('advertised HTTP and HTTPS login portals do not require matching domains', async () => {
    for (const [endpoint, loginUrl, allowed] of [
        ['http://box-play.boxcef.top', 'http://box-login.boxcef.top/api/auth/login', true],
        ['http://play.example.co.uk', 'http://login.example.co.uk/api/auth/login', true],
        ['http://play.example.co.uk', 'http://login.other.co.uk/api/auth/login', true],
        ['http://box-play.boxcef.top', 'http://login.boxcef.top.evil.com/api/auth/login', true],
        ['http://box-play.boxcef.top', 'http://login.other.top/api/auth/login', true],
        ['http://play.github.io', 'http://login.github.io/api/auth/login', true],
        ['http://203.0.113.9:3121', 'http://203.0.113.10:3125/api/auth/login', true],
        ['https://box-play.boxcef.top', 'http://box-login.boxcef.top/api/auth/login', true],
        ['http://play.example.com', 'https://login.other.com/api/auth/login', true],
        ['http://play.example.com', 'ftp://login.other.com/api/auth/login', false],
        ['http://play.example.com', 'http://login.other.com/api/private', false],
        ['http://play.example.com', 'http://user:pass@login.other.com/api/auth/login', false],
        ['http://play.example.com', 'http://login.other.com/api/auth/login?extra=1', false],
        ['http://play.example.com', 'http://login.other.com/api/auth/login#extra', false],
    ] as const) {
        const requests:string[] = [];
        const transport = createApiTransport({
            fetchImpl: async (url) => {
                requests.push(String(url));
                return Response.json({ loginApiUrl: loginUrl });
            },
        });
        await transport.request({
            endpoint,
            url: `${endpoint}/api/player-launcher/bootstrap`,
            method: 'GET',
        });
        const login = transport.request({ endpoint, url: loginUrl, method: 'POST', body: '{}' });
        if (allowed) {
            await login;
        } else {
            await assert.rejects(login, /API 请求必须指向/);
        }
        assert.equal(requests.length, allowed ? 2 : 1, `${endpoint} -> ${loginUrl}`);
    }
});

test('transport rejects non-address server identifiers before making network requests', async () => {
    let fetchCalls = 0;
    const transport = createApiTransport({
        fetchImpl: async () => {
            fetchCalls += 1;
            return Response.json({});
        },
    });
    await assert.rejects(
        transport.request({
            endpoint: '122111222',
            url: 'https://7.62.213.222/api/health-check',
            method: 'GET',
        }),
        /有效的服务器网址、IPv4 或 IPv6/,
    );
    assert.equal(fetchCalls, 0);
});

test('only player session cookies are retained and logout expires them', () => {
    assert.equal(
        mergeCookies('box_local_player_device=device; unrelated=value', [
            'box_local_player_session=session; Path=/; HttpOnly',
            'box_local_player_device=; Path=/; Max-Age=0',
        ]),
        'box_local_player_session=session; unrelated=value',
    );
});

test('transport sends and clears server-scoped session cookies', async () => {
    const requests:Array<{ url:string; options:RequestInit }> = [];
    const transport = createApiTransport({
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            const headers = new Headers({ 'content-type': 'application/json' });
            if (requests.length === 1) {
                headers.append('set-cookie', 'box_local_player_session=first; Path=/; HttpOnly');
            }
            return new Response('{"status":"ok"}', { status: 200, headers });
        },
    });
    await transport.request({
        endpoint: 'play.example.com',
        url: 'https://play.example.com/api/health-check',
        method: 'GET',
    });
    await transport.request({
        endpoint: 'play.example.com',
        url: 'https://play.example.com/api/player-launcher/maps',
        method: 'GET',
    });
    assert.equal(
        new Headers(requests[1].options.headers).get('cookie'),
        'box_local_player_session=first',
    );
    transport.clear('play.example.com');
    assert.deepEqual(transport.cookies('play.example.com'), []);
});

test('forgetting a removed server revokes its advertised login portal', async () => {
    let fetchCalls = 0;
    const transport = createApiTransport({
        fetchImpl: async () => {
            fetchCalls += 1;
            return Response.json({ loginApiUrl: 'https://accounts.example.com/api/auth/login' });
        },
    });
    await transport.request({
        endpoint: 'play.example.com',
        url: 'https://play.example.com/api/player-launcher/bootstrap',
        method: 'GET',
    });

    transport.forget('play.example.com');

    await assert.rejects(
        transport.request({
            endpoint: 'play.example.com',
            url: 'https://accounts.example.com/api/auth/login',
            method: 'POST',
            body: '{}',
        }),
        /API 请求必须指向当前游玩服务器的 \/api\/ 接口/,
    );
    assert.equal(fetchCalls, 1);
});

test('advertised subpath login is scoped to its exact portal prefix', async () => {
    const endpoint = 'https://play.example.test';
    const transport = createApiTransport({
        fetchImpl: async () =>
            Response.json({ loginApiUrl: 'https://auth.example.test/accounts/api/auth/login' }),
    });
    await transport.request({
        endpoint,
        url: `${endpoint}/api/player-launcher/bootstrap`,
        method: 'GET',
    });
    await transport.request({
        endpoint,
        url: 'https://auth.example.test/accounts/api/auth/login',
        method: 'POST',
        body: '{}',
    });
    await assert.rejects(
        transport.request({
            endpoint,
            url: 'https://auth.example.test/api/auth/login',
            method: 'POST',
            body: '{}',
        }),
        /API 请求必须指向/,
    );
    await assert.rejects(
        transport.request({
            endpoint,
            url: 'https://auth.example.test/other/api/auth/login',
            method: 'POST',
            body: '{}',
        }),
        /API 请求必须指向/,
    );
});
