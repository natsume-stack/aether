'use strict';

const assert = require('assert');
const http = require('http');
const { startEditLibrary } = require('../src/edit-library');

function listen(server, port) {
    return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

async function get(port, path) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${path}`, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks).toString()));
        }).on('error', reject);
    });
}

async function post(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method: 'POST',
                headers,
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () =>
                    resolve({
                        statusCode: response.statusCode,
                        body: Buffer.concat(chunks).toString(),
                    }),
                );
            },
        );
        request.on('error', reject);
        request.end();
    });
}

async function main() {
    async function verifySlowStartupSurvivesHealthCheckWindow() {
        let startCalls = 0;
        let stopCalls = 0;
        let waitCalls = 0;
        let releaseHealthCheck;
        const healthCheckReady = new Promise((resolve) => {
            releaseHealthCheck = resolve;
        });
        const runtime = {
            port: 19100,
            exited: false,
            async stop() {
                stopCalls += 1;
                runtime.exited = true;
            },
        };
        const library = startEditLibrary({
            mode: 'edit',
            host: '127.0.0.1',
            port: 0,
            runtimePortStart: runtime.port,
            resolveProject: (id) => ({ id }),
            startRuntime: async () => {
                startCalls += 1;
                return runtime;
            },
            waitForRuntime: async () => {
                waitCalls += 1;
                if (waitCalls === 1) {
                    throw new Error('health check window elapsed');
                }
                await healthCheckReady;
            },
        });
        await library.ready;

        try {
            let startupError;
            const firstStartup = library.ensureRuntime('slow-project').catch((error) => {
                startupError = error;
            });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(
                startupError,
                undefined,
                'one elapsed health-check window must not fail the runtime startup',
            );
            assert.equal(startCalls, 1, 'the slow runtime must only be spawned once');
            assert.equal(
                stopCalls,
                0,
                'a live runtime must not be stopped while it is still loading',
            );

            const secondStartup = library.ensureRuntime('slow-project');
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(startCalls, 1, 'later callers must join the existing slow startup');
            releaseHealthCheck();
            await Promise.all([firstStartup, secondStartup]);
            assert.equal(waitCalls, 2);
            assert.equal(runtime.exited, false);
            console.log('PASS: slow runtime startup survives an elapsed health-check window');
        } finally {
            await library.stop();
        }
    }

    async function verifyMode(mode, proxyPortStart, runtimePortStart) {
        const children = new Map();
        let releaseProjectStatus;
        const projectStatusReady = new Promise((resolve) => {
            releaseProjectStatus = resolve;
        });
        const library = startEditLibrary({
            mode,
            host: '127.0.0.1',
            port: proxyPortStart,
            runtimePortStart,
            resolveProject: (id) => ({ id }),
            waitForRuntime: async (_url) => {
                if (_url.includes(String(runtimePortStart))) {
                    await projectStatusReady;
                }
            },
            startRuntime: async (project, port) => {
                const server = http.createServer((req, res) => res.end(`${project.id}:${req.url}`));
                await listen(server, port);
                const runtime = {
                    port,
                    exited: false,
                    async stop() {
                        runtime.exited = true;
                        await close(server);
                    },
                };
                children.set(project.id, runtime);
                return runtime;
            },
        });
        await library.ready;
        const address = library.server.address();
        assert(address && typeof address !== 'string');

        try {
            assert.equal(
                JSON.parse(await get(address.port, '/project-status/__local_runtime/status')).phase,
                'idle',
            );
            const startResponse = await post(address.port, '/project-status/__local_runtime/start');
            assert.equal(startResponse.statusCode, 202);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(
                JSON.parse(await get(address.port, '/project-status/__local_runtime/status')).phase,
                'loading',
            );
            let earlyProxyResolved = false;
            const earlyProxy = get(address.port, '/project-status/block/runtime-asset').then(
                (value) => {
                    earlyProxyResolved = true;
                    return value;
                },
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.equal(
                earlyProxyResolved,
                false,
                'resource requests must wait until the child runtime health check passes',
            );
            releaseProjectStatus();
            assert.equal(await earlyProxy, 'project-status:/block/runtime-asset');
            assert.equal(await get(address.port, '/project-idle/internal/save-local-project'), '');
            assert.equal(children.has('project-idle'), false);
            assert.equal(
                await get(address.port, '/project-one/api/health-check'),
                'project-one:/api/health-check',
            );
            assert.equal(
                await get(address.port, '/project-two/api/health-check'),
                'project-two:/api/health-check',
            );
            assert.equal(
                await get(address.port, '/project-one/internal/save-local-project'),
                'project-one:/internal/save-local-project',
            );
            assert.equal(children.size, 3);
            assert.equal(children.get('project-status').exited, false);
            assert.equal(children.get('project-one').exited, false);
            assert.equal(children.get('project-two').exited, false);
            console.log(`PASS: two ${mode} projects keep independent runtimes alive`);
        } finally {
            await library.stop();
        }
    }

    async function verifyDestroyBlocksAutomaticRestart() {
        let startCalls = 0;
        let releaseHealthCheck;
        const healthCheckReady = new Promise((resolve) => {
            releaseHealthCheck = resolve;
        });
        const library = startEditLibrary({
            host: '127.0.0.1',
            port: 0,
            runtimePortStart: 19180,
            resolveProject: (id) => ({ id }),
            startRuntime: async (_project, port) => {
                startCalls += 1;
                const runtime = {
                    port,
                    exited: false,
                    async stop() {
                        runtime.exited = true;
                    },
                };
                return runtime;
            },
            waitForRuntime: async () => healthCheckReady,
        });
        await library.ready;
        const address = library.server.address();
        assert(address && typeof address !== 'string');
        try {
            const startup = library.ensureRuntime('destroy-race').catch((error) => error);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(
                (await post(address.port, '/destroy-race/__local_runtime/destroy')).statusCode,
                204,
            );
            releaseHealthCheck();
            assert.equal((await startup).statusCode, 409);
            assert.match(await get(address.port, '/destroy-race/api/health-check'), /运行时已销毁/);
            assert.equal(startCalls, 1);
            await post(address.port, '/destroy-race/__local_runtime/start', {
                'x-box-runtime-restart': '1',
            });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(startCalls, 2);
            console.log('PASS: destroyed runtime only restarts after an explicit relink');
        } finally {
            await library.stop();
        }
    }

    await verifyMode('edit', 0, 19120);
    await verifyMode('play', 0, 19140);
    await verifySlowStartupSurvivesHealthCheckWindow();
    await verifyDestroyBlocksAutomaticRestart();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
