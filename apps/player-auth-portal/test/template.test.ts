'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
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

import { MockPlayerService } from '../scripts/mock';
const createMockPlayerService = (key:string) => new MockPlayerService(key).server;
const listen = (server:http.Server):Promise<string> =>
    new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            resolve(`http://127.0.0.1:${address.port}`);
        }),
    );
const close = (server:http.Server):Promise<void> =>
    new Promise((resolve) => server.close(() => resolve()));

test('standard launcher configuration takes priority and legacy deployments remain compatible', () => {
    const standard = configFromEnvironment({
        BOX_PLAYER_AUTH_API_KEY: 'standard-server-only-key',
        AUTH_DEMO_API_KEY: 'wrong-legacy-key',
        BOX_PLAYER_SERVICE_INTERNAL_URL: 'http://player-service:3213',
        AUTH_DEMO_PLAYER_SERVICE_URL: 'http://wrong:1111',
        HOST: '0.0.0.0',
        PORT: '3214',
        BOX_PLAYER_REGISTRATION_ENABLED: 'false',
        AUTH_DEMO_REGISTRATION_ENABLED: 'true',
    });
    assert.equal(standard.apiKey, 'standard-server-only-key');
    assert.equal(standard.playerServiceURL.origin, 'http://player-service:3213');
    assert.equal(standard.registrationEnabled, false);
    assert.equal(standard.host, '0.0.0.0');
    assert.throws(
        () => configFromEnvironment({ BOX_PLAYER_SERVICE_INTERNAL_URL: 'http://service:3213' }),
        /at least 16/,
    );
});

test('public assets work without custom routes but dotfiles, unsupported extensions and escaping symlinks do not', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'box-login-assets-'));
    const directory = path.join(temp, 'public');
    mkdirSync(path.join(directory, 'images'), { recursive: true });
    writeFileSync(path.join(directory, 'index.html'), '<!doctype html>preview');
    writeFileSync(path.join(directory, 'images/logo.svg'), '<svg/>');
    writeFileSync(path.join(directory, '.env'), 'private-test-value');
    writeFileSync(path.join(temp, 'outside.js'), 'private-outside-value');
    try {
        symlinkSync(path.join(temp, 'outside.js'), path.join(directory, 'escape.js'));
    } catch (error) {
        // Windows 无开发者模式/权限时不能创建链接，其余路径防护检查仍要执行。
        if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) {
            throw error;
        }
    }
    const server = createAuthPortalServer({ publicDirectory: directory });
    const base = await listen(server);
    try {
        const logo = await fetch(`${base}/images/logo.svg`);
        assert.equal(logo.status, 200);
        assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
        assert.match(logo.headers.get('content-security-policy') || '', /font-src 'self'/);
        assert.equal((await fetch(`${base}/`)).headers.get('cache-control'), 'no-store');
        for (const url of [
            '/.env',
            '/%2eenv',
            '/escape.js',
            '/server.js',
            '/%2e%2e%2foutside.js',
            '/account',
        ]) {
            const response = await fetch(base + url);
            assert.equal(response.status, 404, url);
            assert.doesNotMatch(await response.text(), /private-/);
        }
    } finally {
        await close(server);
        rmSync(temp, { recursive: true, force: true });
    }
});

test('standalone packaging validates image names, explicit target platforms and output types before Docker writes', async () => {
    const { ImagePackager } = await import('../scripts/tasks');
    const packageOptions = (args:string[], arch:NodeJS.Architecture) =>
        new ImagePackager().options(args, arch);
    const options = packageOptions(['--image', 'my-login:1.0', '--platform', 'linux/arm64'], 'x64');
    assert.equal(options.image, 'my-login:1.0');
    assert.ok(options.output.endsWith('my-login-1.0-linux-arm64.tar.gz'));
    for (const args of [
        ['--image', 'https://evil.test/a:1'],
        ['--image', '--privileged'],
        ['--platform', 'darwin/arm64'],
        ['--output', 'archive.zip'],
        ['--unknown'],
    ]) {
        assert.throws(() => packageOptions(args, 'x64'));
    }
});

test('invalid successful upstream responses become gateway errors, preserving cookie arrays and retry information', async () => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Retry-After': '30',
            'Set-Cookie': [
                'box_local_player_session=fixture; Path=/; HttpOnly',
                'box_local_player_device=fixture; Path=/; HttpOnly',
            ],
        });
        res.end('<html>unexpected upstream page</html>');
    });
    const url = await listen(upstream);
    const portal = createAuthPortalServer({
        apiKey: 'fixture-server-only-key',
        playerServiceURL: new URL(url),
        publicURL: null,
        playURL: null,
        creatorURL: null,
        requestTimeoutMs: 1000,
        registrationEnabled: true,
    });
    const base = await listen(portal);
    try {
        const response = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Origin': base },
            body: JSON.stringify({ username: 'fixture', password: 'fixture-password' }),
        });
        assert.equal(response.status, 502);
        assert.equal((await response.json()).code, 'INVALID_UPSTREAM_RESPONSE');
        assert.equal(response.headers.get('retry-after'), '30');
        assert.equal(response.headers.getSetCookie().length, 2);
    } finally {
        await Promise.all([close(portal), close(upstream)]);
    }
});

test('mock preview exercises login, nickname and password without using or overwriting production cookie names', async () => {
    const apiKey = 'development-fixture-key';
    const upstream = createMockPlayerService(apiKey);
    const upstreamURL = await listen(upstream);
    const portal = createAuthPortalServer({
        playerServiceURL: new URL(upstreamURL),
        apiKey,
        publicURL: null,
        playURL: null,
        creatorURL: null,
        requestTimeoutMs: 1000,
        registrationEnabled: true,
        trustProxy: false,
    });
    const base = await listen(portal);
    let cookie = '';
    const call = async (operation:string, method = 'GET', body?:object) => {
        const response = await fetch(`${base}/api/auth/${operation}`, {
            method,
            headers: {
                Cookie: cookie,
                Origin: base,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) {
            cookie = cookies.map((value) => value.split(';')[0]).join('; ');
        }
        return { response, data: await response.json() };
    };
    try {
        assert.equal((await call('session')).data.player, null);
        const login = await call('login', 'POST', {
            username: 'demo',
            password: 'demo-password-123',
        });
        assert.equal(login.response.status, 200);
        assert.match(cookie, /box_portal_preview_session=/);
        assert.doesNotMatch(cookie, /box_local_player_/);
        assert.equal(
            (await call('profile', 'PATCH', { displayName: '测试昵称' })).data.player.displayName,
            '测试昵称',
        );
        assert.equal(
            (
                await call('password', 'POST', {
                    currentPassword: 'wrong',
                    newPassword: 'new-password-123',
                })
            ).response.status,
            400,
        );
        assert.equal(
            (
                await call('password', 'POST', {
                    currentPassword: 'demo-password-123',
                    newPassword: 'new-password-123',
                })
            ).data.reloginRequired,
            true,
        );
        assert.equal((await call('session')).data.player, null);
    } finally {
        await Promise.all([close(portal), close(upstream)]);
    }
});
