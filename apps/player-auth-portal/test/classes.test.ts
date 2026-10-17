import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

import { PortalConfig, AuthOperation, AuthPolicy } from '../server/index';
import { HttpError } from '../server/http';

const config = () =>
    new PortalConfig({
        apiKey: 'private-test-key-not-for-browser',
        playerServiceURL: new URL('http://player-service:3213'),
        playURL: new URL('https://play.example.test/'),
    });

test('operation objects own their payload rules; identity fields cannot enter self-service requests', () => {
    const profile = AuthOperation.routes.get('/api/auth/profile')!;
    assert.equal(profile.method, 'PATCH');
    assert.equal(profile.selfService, true);
    assert.deepEqual(profile.payload({ displayName: '中文昵称' }), { displayName: '中文昵称' });
    assert.throws(
        () => profile.payload({ displayName: '中文昵称', role: 'owner' }),
        (error) => error instanceof HttpError && error.status === 400,
    );
    const login = AuthOperation.routes.get('/api/auth/login')!;
    assert.deepEqual(
        login.payload({
            username: 'demo',
            password: 'test-password',
            returnUrl: 'https://evil.test',
            role: 'owner',
        }),
        { username: 'demo', password: 'test-password' },
    );
});

test('policy methods reject unsupported verbs and origins without sending an upstream request', () => {
    const request = new IncomingMessage(new Socket());
    request.method = 'GET';
    request.headers = { host: 'portal.example.test', origin: 'http://portal.example.test' };
    const operation = AuthOperation.routes.get('/api/auth/password')!;
    const policy = new AuthPolicy(config());
    assert.throws(
        () => policy.validate(request, operation),
        (error) => error instanceof HttpError && error.headers.Allow === 'POST',
    );
    request.method = 'POST';
    request.headers.origin = 'https://evil.test';
    assert.throws(
        () => policy.validate(request, operation),
        (error) => error instanceof HttpError && error.code === 'ORIGIN_NOT_ALLOWED',
    );
    request.socket.destroy();
});

test('configuration hides the secret in serialization and validates redirect origins independently', () => {
    const options = config();
    assert.ok(!JSON.stringify(options).includes(options.apiKey));
    assert.equal(
        options.returnURL('play', 'https://play.example.test.evil.test/'),
        'https://play.example.test/',
    );
    assert.equal(options.returnURL('play', '/p/map'), 'https://play.example.test/p/map');
    assert.throws(
        () =>
            new PortalConfig({
                apiKey: 'private-test-key-not-for-browser',
                playerServiceURL: new URL('file:///etc/passwd'),
            }),
    );
});

test('configured HTTPS public origin survives an HTTP reverse proxy without trusting arbitrary headers', () => {
    const settings = new PortalConfig({
        apiKey: 'private-test-key-not-for-browser',
        playerServiceURL: new URL('http://player-service:3213'),
        publicURL: new URL('https://auth.example.test/accounts'),
    });
    const request = new IncomingMessage(new Socket());
    request.headers = {
        'host': 'player-auth-portal:3214',
        'origin': 'https://auth.example.test',
        'x-forwarded-proto': 'http',
    };
    assert.equal(settings.sameOrigin(request), true);
    assert.equal(settings.protocol(request), 'https');
    request.headers.origin = 'https://evil.example.test';
    assert.equal(settings.sameOrigin(request), false);
    request.socket.destroy();
});
