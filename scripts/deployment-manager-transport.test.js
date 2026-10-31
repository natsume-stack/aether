'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// openapi-fetch uses the standards-based Request form. Keep these regression
// assertions readable by adapting Request back to the legacy test tuple while
// preserving the original body object (notably File/Blob uploads).
const NativeRequest = globalThis.Request;
const requestBodies = new WeakMap();
globalThis.Request = class TestRequest extends NativeRequest {
    constructor(input, init) {
        const resolvedInput =
            typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input;
        super(resolvedInput, init);
        requestBodies.set(
            this,
            init?.body ?? (input instanceof NativeRequest ? requestBodies.get(input) : undefined),
        );
    }
};

let fetchHandler;
Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get() {
        const handler = fetchHandler;
        return (input, init) => {
            if (!(input instanceof NativeRequest)) {
                return handler(input, init);
            }
            const url = new URL(input.url);
            const headers = Object.fromEntries(input.headers.entries());
            for (const name of [
                'Authorization',
                'Content-Type',
                'X-Backup-Name',
                'X-Operation-Id',
            ]) {
                const value = input.headers.get(name);
                if (value !== null) {
                    headers[name] = value;
                }
            }
            return handler(`${url.pathname}${url.search}`, {
                method: input.method,
                headers,
                credentials: input.credentials,
                signal: input.signal,
                body: requestBodies.get(input),
            });
        };
    },
    set: (handler) => {
        fetchHandler = handler;
    },
});

// Exercise the real transport with only the native bridge and HTTP boundary stubbed.
const source = fs
    .readFileSync(
        path.join(__dirname, '../apps/deployment-manager/src/infrastructure/transport.js'),
        'utf8',
    )
    .replace(
        /import .* from '@tauri-apps\/api\/core'/,
        'const tauriInvoke = (...args) => globalThis.nativeInvoke(...args)',
    )
    .replace(
        /import .* from '@tauri-apps\/api\/event'/,
        'const tauriListen = (...args) => globalThis.nativeListen(...args)',
    )
    .replace(
        "import { ApiClient } from '@box/apis'",
        `import { ApiClient } from ${JSON.stringify(
            pathToFileURL(path.join(__dirname, '../internals/apis/dist/index.es.mjs')).href,
        )}`,
    );
const transport = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('all authenticated HTTP operations forget a rejected token', async () => {
    const api = await transport;
    const values = new Map();
    globalThis.window = {};
    globalThis.sessionStorage = {
        getItem: (key) => values.get(key),
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
    };
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ message: '令牌失效' }), { status: 401 });
    for (const operation of [
        () => api.invoke('get_system_status'),
        () => api.uploadBackup({ name: 'backup.tar.gz' }),
        () => api.downloadBackup('backup.tar.gz'),
        () => api.downloadDiagnostics('diagnostics.tar.gz'),
    ]) {
        api.setWebManagerToken('expired');
        await assert.rejects(operation, /令牌失效/);
        assert.equal(api.hasWebManagerToken(), false);
    }
});

test('license notices are public while management commands still require a token', async () => {
    const api = await transport;
    web();
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/commands/get_legal_notices');
        assert.equal(options.headers.Authorization, undefined);
        return json({ result: { licenseName: '发行许可证', licenseText: 'license' } });
    };
    assert.deepEqual(await api.invoke('get_legal_notices'), {
        licenseName: '发行许可证',
        licenseText: 'license',
    });
    await assert.rejects(api.invoke('get_about_info'), /请先输入 Linux Web 管理令牌/);
});

test('desktop commands and progress events retain their native contract', async () => {
    const api = await transport;
    globalThis.window = { __TAURI_INTERNALS__: {} };
    const payload = { service: 'redis' };
    globalThis.nativeInvoke = async (name, body) => ({ name, body });
    assert.deepEqual(await api.invoke('start_managed_service', payload), {
        name: 'start_managed_service',
        body: payload,
    });
    const handler = () => {};
    const unlisten = () => {};
    globalThis.nativeListen = async (event, callback) => {
        assert.equal(event, 'install-progress');
        assert.equal(callback, handler);
        return unlisten;
    };
    assert.equal(await api.listen('install-progress', handler), unlisten);
});

function web() {
    globalThis.window = { setTimeout, location: { href: 'http://localhost/' } };
    const values = new Map();
    globalThis.sessionStorage = {
        getItem: (key) => values.get(key),
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
    };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

test('Web events authenticate, filter progress and avoid HTTP polling', async () => {
    const api = await transport;
    web();
    class MockSocket {
        static OPEN = 1;
        static instances = [];
        readyState = 0;
        frames = [];
        constructor(url) {
            this.url = url;
            MockSocket.instances.push(this);
        }
        send(data) {
            this.frames.push(JSON.parse(data));
        }
        open() {
            this.readyState = 1;
            this.onopen?.();
        }
        event(value) {
            this.onmessage?.({ data: JSON.stringify(value) });
        }
        close(code = 1000) {
            this.readyState = 3;
            this.onclose?.({ code });
        }
    }
    globalThis.WebSocket = MockSocket;
    api.setWebManagerToken('secret');
    const requests = [],
        events = [],
        snapshots = [];
    const command = deferred();
    globalThis.fetch = (url, options) => {
        requests.push({ url, options });
        return command.promise;
    };
    const unlisten = await api.listen('install-progress', (value) => events.push(value));
    const unsubscribe = api.subscribeManager('overview', (value) => snapshots.push(value));
    try {
        const pending = api.invoke('start_services', { force: true });
        const socket = MockSocket.instances[0];
        assert.equal(socket.url, 'ws://localhost/api/events');
        socket.open();
        assert.deepEqual(socket.frames[0], { type: 'authenticate', token: 'secret' });
        socket.event({ type: 'ready' });
        const id = requests[0].options.headers['X-Operation-Id'];
        assert.deepEqual(socket.frames.at(-1), { topics: ['overview'], operations: [id] });
        socket.event({ type: 'progress', id: 'unrelated', payload: { percent: 1 } });
        socket.event({ type: 'progress', id, payload: { percent: 42 } });
        socket.event({ type: 'snapshot', topic: 'overview', payload: { allHealthy: true } });
        assert.deepEqual(events, [{ payload: { percent: 42 } }]);
        assert.deepEqual(snapshots, [{ allHealthy: true }]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(requests.length, 1, 'idle event stream must not poll HTTP');
        command.reject(new Error('main failure'));
        await assert.rejects(pending, /main failure/);
        socket.event({ type: 'progress', id, payload: { percent: 99 } });
        assert.equal(events.length, 1, 'finished operation ignores late progress');
        assert.deepEqual(socket.frames.at(-1).operations, []);
        socket.close(1008);
        assert.equal(api.hasWebManagerToken(), false);
    } finally {
        unlisten();
        unsubscribe();
        api.setWebManagerToken('');
        delete globalThis.WebSocket;
    }
});

test('Web local adapters choose files, clean listeners and download authenticated blobs', async () => {
    const api = await transport;
    web();
    api.setWebManagerToken('token');
    assert.equal(api.dockerPlatform().canStart, false);
    assert.doesNotMatch(JSON.stringify(api.dockerPlatform()), /Desktop/);
    assert.equal(api.dockerPlatform().action, '重新检测 Docker');
    assert.match(api.dockerPlatform().hint, /sudo systemctl start docker/);
    globalThis.window.open = (...args) =>
        assert.deepEqual(args, ['https://example.com', '_blank', 'noopener,noreferrer']);
    await api.openExternal('https://example.com');
    const file = { name: '备份.tar.gz' };
    let event = 'change';
    let removed = 0;
    let clicked = 0;
    const requests = [];
    globalThis.document = {
        body: { append() {} },
        createElement: (tag) => {
            const handlers = new Map();
            return {
                files: [file],
                addEventListener: (name, handler) => handlers.set(name, handler),
                removeEventListener: (name) => handlers.delete(name),
                remove: () => {
                    removed++;
                    assert.equal(handlers.size, 0);
                },
                click() {
                    if (tag === 'input') {
                        assert.equal(
                            this.accept,
                            '.zip,.tar,.tar.gz,application/zip,application/gzip',
                        );
                        handlers.get(event)();
                    } else {
                        clicked++;
                        assert.match(this.href, /^blob:/);
                    }
                },
            };
        },
    };
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return url.endsWith('/upload')
            ? json({ path: 'server/backup.tar.gz' })
            : new Response('archive');
    };
    assert.equal(await api.selectBackup(), 'server/backup.tar.gz');
    assert.equal(requests[0].options.body, file);
    assert.equal(requests[0].options.headers['X-Backup-Name'], encodeURIComponent(file.name));
    event = 'cancel';
    assert.equal(await api.selectBackup(), null);
    assert.equal(removed, 2);
    assert.equal(requests.length, 1);
    assert.equal(await api.exportBackupFile('备份.tar.gz'), '备份下载已开始。');
    assert.equal(requests[1].url, `/api/backups/${encodeURIComponent(file.name)}/download`);
    assert.equal(clicked, 1);
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return url.startsWith('/api/commands/')
            ? json({ result: 'diag.tar.gz' })
            : new Response('diag');
    };
    assert.equal(await api.exportDiagnosticsFile(), '诊断文件下载已开始。');
    assert.equal(requests.at(-1).url, '/api/diagnostics/diag.tar.gz/download');
    event = 'change';
    globalThis.fetch = async () => {
        throw new Error('upload failed');
    };
    await assert.rejects(api.selectBackup(), /upload failed/);
    assert.equal(removed, 3);
});

test('native file and external adapters preserve command names, payloads and cancellation', async () => {
    const api = await transport;
    globalThis.window = { __TAURI_INTERNALS__: {} };
    globalThis.fetch = () => assert.fail('desktop must not fetch');
    const calls = [];
    globalThis.nativeInvoke = async (...args) => {
        calls.push(args);
        return '/native/file';
    };
    assert.equal(await api.selectBackup(), '/native/file');
    assert.equal(await api.exportBackupFile('archive'), '备份已导出：/native/file');
    assert.equal(await api.exportDiagnosticsFile(), '/native/file');
    await api.openExternal('https://example.com');
    await api.openExternal('https://qm.qq.com/q/oMdzAAN49a', 'open_community_group');
    await api.openExternal(
        'https://github.com/box3lab/box3-local-engine',
        'open_project_repository',
    );
    assert.deepEqual(calls, [
        ['import_backup', {}],
        ['export_backup', { archive: 'archive' }],
        ['export_diagnostics', {}],
        ['open_service', { url: 'https://example.com' }],
        ['open_community_group', {}],
        ['open_project_repository', {}],
    ]);
    assert.equal(api.dockerPlatform().canStart, true);
    globalThis.nativeInvoke = async () => null;
    assert.equal(await api.selectBackup(), null);
    assert.equal(await api.exportBackupFile('archive'), '');
    globalThis.nativeInvoke = async () => {
        throw new Error('native failure');
    };
    await assert.rejects(api.exportDiagnosticsFile(), /native failure/);
});

test('only explicitly supported long tasks carry operation IDs', async () => {
    const api = await transport;
    web();
    api.setWebManagerToken('token');
    const mutations = [
        'start_services',
        'stop_services',
        'control_service',
        'prepare_managed_database',
        'prepare_managed_redis',
        'start_managed_service',
        'save_configuration_command',
        'save_raw_environment',
        'save_raw_nginx_config',
        'create_backup',
        'restore_backup',
        'export_diagnostics',
        'destroy_project_runtime',
    ];
    const reads = [
        'get_system_status',
        'get_project_runtime_status',
        'get_performance_status',
        'get_managed_service_info',
        'get_install_config',
        'get_raw_environment',
        'get_raw_nginx_config',
        'get_legal_notices',
        'get_docker_check',
        'get_owner_secrets',
        'get_about_info',
        'list_backups',
        'inspect_backup',
        'has_managed_database_image',
        'has_managed_redis_image',
        'test_remote_connection',
        'unknown command',
    ];
    const ids = new Set();
    for (const command of [...mutations, ...reads]) {
        globalThis.fetch = async (url, options) => {
            assert.equal(url, `/api/commands/${encodeURIComponent(command)}`);
            // Read commands retain the existing POST RPC contract, without tracking metadata.
            assert.equal(options.method, 'POST');
            assert.equal(
                Object.hasOwn(options.headers, 'X-Operation-Id'),
                mutations.includes(command),
            );
            if (mutations.includes(command)) {
                ids.add(options.headers['X-Operation-Id']);
            }
            return json({ result: true });
        };
        assert.equal(await api.invoke(command), true);
    }
    assert.equal(ids.size, mutations.length);
});

test('late 401 responses preserve replacement tokens across authenticated adapters', async () => {
    const api = await transport;
    web();
    for (const operation of [
        () => api.invoke('get_system_status'),
        () => api.uploadBackup({ name: 'backup.tar.gz' }),
        () => api.downloadBackup('backup.tar.gz'),
        () => api.downloadDiagnostics('diag.tar.gz'),
    ]) {
        api.setWebManagerToken('old-token');
        const response = deferred();
        globalThis.fetch = (url, options) => {
            assert.equal(options.headers.Authorization, 'Bearer old-token');
            return response.promise;
        };
        const pending = operation();
        api.setWebManagerToken('new-token');
        response.resolve(json({ message: 'old token rejected' }, 401));
        await assert.rejects(pending, /old token rejected/);
        assert.equal(api.hasWebManagerToken(), true);
        globalThis.fetch = async (url, options) => {
            assert.equal(options.headers.Authorization, 'Bearer new-token');
            return json({ result: true });
        };
        await api.invoke('get_system_status');
    }
});
