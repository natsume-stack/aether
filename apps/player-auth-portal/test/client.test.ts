import assert from 'node:assert/strict';
import test from 'node:test';

import { PortalClient, PortalError } from '../src/client';

test('portal UI uses generated API requests and preserves cross-site navigation fields', async () => {
    const originalFetch = globalThis.fetch;
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const requests:Request[] = [];
    Object.defineProperty(globalThis, 'location', {
        value: new URL('https://login.example.test'),
        configurable: true,
    });
    globalThis.fetch = async (input) => {
        assert.ok(input instanceof Request);
        requests.push(input);
        assert.equal(input.credentials, 'same-origin');
        assert.equal(input.cache, 'no-store');
        assert.equal(input.headers.has('X-Box-Player-Auth-Key'), false);
        const path = new URL(input.url).pathname;
        if (path.endsWith('/logout')) {
            return Response.json({ loggedOut: true });
        }
        if (path.endsWith('/password')) {
            return Response.json({ changed: true, reloginRequired: true });
        }
        return Response.json({
            player: { username: 'tester', displayName: '测试' },
            returnUrl: 'https://play.example.test/play',
        });
    };
    try {
        const client = new PortalClient(
            `?source=play&returnUrl=https%3A%2F%2Fplay.example.test%2Fplay&transferState=${'s'.repeat(43)}&transferChallenge=${'v'.repeat(43)}`,
        );
        await client.session();
        assert.equal(
            new URL(requests[0].url).searchParams.get('transferChallenge'),
            'v'.repeat(43),
        );
        await client.login('tester', 'test-password');
        const login = await requests[1].clone().json();
        assert.equal(login.username, 'tester');
        assert.equal(login.transferState, 's'.repeat(43));
        assert.equal(login.source, 'play');
        await client.register('tester', '测试', 'test-password');
        assert.equal((await requests[2].clone().json()).displayName, '测试');
        await client.logout();
        await client.updateNickname('新昵称');
        await client.changePassword('old-password', 'new-password');
        assert.deepEqual(
            requests.map((request) => [request.method, new URL(request.url).pathname]),
            [
                ['GET', '/api/auth/session'],
                ['POST', '/api/auth/login'],
                ['POST', '/api/auth/register'],
                ['POST', '/api/auth/logout'],
                ['PATCH', '/api/auth/profile'],
                ['POST', '/api/auth/password'],
            ],
        );
        assert.deepEqual(await requests[5].clone().json(), {
            currentPassword: 'old-password',
            newPassword: 'new-password',
        });
    } finally {
        globalThis.fetch = originalFetch;
        if (locationDescriptor) {
            Object.defineProperty(globalThis, 'location', locationDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, 'location');
        }
    }
});

test('generated request errors keep portal status, retry and punishment details', async () => {
    const originalFetch = globalThis.fetch;
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
        value: new URL('https://login.example.test'),
        configurable: true,
    });
    globalThis.fetch = async () =>
        Response.json(
            { code: 'AUTH_REQUIRED', message: '请重新登录', banReason: '测试处罚' },
            { status: 401, headers: { 'Retry-After': '60' } },
        );
    try {
        const client = new PortalClient('');
        await assert.rejects(client.login('tester', 'test-password'), (error:unknown) => {
            assert.ok(error instanceof PortalError);
            assert.equal(error.status, 401);
            assert.equal(error.code, 'AUTH_REQUIRED');
            assert.equal(error.retryAfter, '60');
            assert.equal(error.banReason, '测试处罚');
            return true;
        });
    } finally {
        globalThis.fetch = originalFetch;
        if (locationDescriptor) {
            Object.defineProperty(globalThis, 'location', locationDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, 'location');
        }
    }
});
