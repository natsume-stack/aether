import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiTransport } from './api-transport';

import type { ApiRequestTiming } from './request-diagnostics';

const endpoint = 'https://play.example.test';
const request = (path:string, method = 'GET') => ({ endpoint, url: endpoint + path, method });

const slowFetch:typeof fetch = async (_url, options) =>
    new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ ok: true })), 20);
        options.signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
        );
    });

test('login has its own response budget instead of the short ordinary API deadline', async () => {
    const transport = createApiTransport({
        fetchImpl: slowFetch,
        timeoutMs: 5,
        loginTimeoutMs: 80,
    });
    assert.equal((await transport.request(request('/api/auth/login', 'POST'))).status, 200);
    await assert.rejects(transport.request(request('/api/health-check')), /API 请求超时/);
});

test('the API deadline also covers a response body that stalls after headers', async () => {
    const fetchImpl:typeof fetch = async (_url, options) =>
        new Response(
            new ReadableStream({
                start(controller) {
                    options.signal.addEventListener(
                        'abort',
                        () => controller.error(new DOMException('Aborted', 'AbortError')),
                        { once: true },
                    );
                },
            }),
        );
    const transport = createApiTransport({ fetchImpl, timeoutMs: 5 });
    await assert.rejects(
        Promise.race([
            transport.request(request('/api/health-check')),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Response body escaped the deadline')), 200),
            ),
        ]),
        /API 请求超时/,
    );
});

test('request diagnostics contain timing only, without credentials, cookies or query values', async () => {
    const timings:ApiRequestTiming[] = [];
    const secret = 'private-fixture-value';
    const transport = createApiTransport({
        fetchImpl: async () =>
            Response.json(
                { player: {} },
                { headers: { 'set-cookie': `box_local_player_session=${secret}; Path=/` } },
            ),
        onTiming: (record) => timings.push(record),
    });
    await transport.request({
        ...request(`/api/auth/login?hint=${secret}`, 'POST'),
        body: JSON.stringify({ username: secret, password: secret }),
    });
    assert.equal(timings[0].path, '/api/auth/login');
    assert.equal(timings[0].status, 200);
    assert.equal(timings[0].outcome, 'ok');
    assert.equal(timings[0].timeoutMs, 30_000);
    assert.equal(JSON.stringify(timings).includes(secret), false);
});
