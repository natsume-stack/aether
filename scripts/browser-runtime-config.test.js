'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'apps/game/configs/client.ts');
const ts = require(
    require.resolve('typescript', { paths: [path.join(root, 'apps/player-launcher')] }),
);
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function extract(environment, window) {
    const exports = {};
    vm.runInNewContext(compiled, {
        exports,
        require: createRequire(file),
        process: { env: environment, version: process.version },
        ...(window ? { window } : {}),
    });
    return exports.extractServerConfigForClient;
}

const server = {
    isLocalGameServer: true,
    BACKEND_SERVER_URL: 'http://127.0.0.1:9966',
    CDN_PATH: 'http://127.0.0.1:9966',
    OSS_CDN_URL: 'http://127.0.0.1:9966',
    VOXA_URL: 'http://127.0.0.1:3123',
};

function assertRuntime(config, expected) {
    for (const key of [
        'BACKEND_SERVER_URL',
        'CDN_PATH',
        'OSS_CDN_URL',
        'JAVA_BACKEND_SERVER_URL',
        'MAAS_BACKEND_SERVER_URL',
        'CREATERA_BACKEND_SERVER_URL',
    ]) {
        assert.equal(config[key], expected, key);
    }
    for (const key of ['ARENA_URL', 'WEBSITE_URL', 'HOME_URL', 'PLATFORM_URL']) {
        assert.equal(config[key], '', key);
    }
}

test('creator browser routes stay same-origin and preserve the public prefix', () => {
    const read = extract({ BOX_DEPLOYMENT_MODE: 'creator', BOX_APP_BASE_PATH: '/creator' });
    assertRuntime(
        read(server, 'edit', 'map with space'),
        '/creator/runtime/edit/map%20with%20space',
    );
    assertRuntime(read(server, 'play', 'map-one'), '/creator/runtime/play/map-one');
    assert.equal(read(server).VOXA_URL, server.VOXA_URL);
});

test('Play browser runtime routes support both map-library and single-runtime deployments', () => {
    const library = extract({
        BOX_DEPLOYMENT_MODE: 'play',
        BOX_PLAY_LIBRARY_PATH: '/maps',
        BOX_APP_BASE_PATH: '/abc',
    });
    assertRuntime(library(server, 'play', 'map-one'), '/abc/runtime/play/map-one');
    assert.equal(library(server).VOXA_URL, '');
    const single = extract({ BOX_DEPLOYMENT_MODE: 'play' });
    assertRuntime(single(server, 'play', 'map-one'), '/runtime/play');
});

test('browser runtime prefixes use the actual page prefix rather than the server-only environment', () => {
    const read = extract(
        { BOX_DEPLOYMENT_MODE: 'creator', BOX_APP_BASE_PATH: '/server-only' },
        { __BOX_APP_BASE_PATH__: '/public' },
    );
    assertRuntime(read(server, 'edit', 'map-one'), '/public/runtime/edit/map-one');
});

test('non-product callers retain the existing configuration contract', () => {
    const read = extract({});
    const config = read(server);
    assert.equal(config.BACKEND_SERVER_URL, server.BACKEND_SERVER_URL);
    assert.equal(config.CDN_PATH, server.CDN_PATH);
});

for (const prefix of ['', '/creator']) {
    test(`local edit teleport preserves the active public prefix ${prefix || '(root)'}`, () => {
        const utility = {};
        const compile = (relative) =>
            ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
                compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
            }).outputText;
        vm.runInNewContext(compile('apps/game/src/utils/public-url.ts'), {
            exports: utility,
            window: { __BOX_RESOLVE_PUBLIC_URL__: (target) => `${prefix}${target}` },
        });
        const exports = {};
        const jumps = [];
        const dependencies = {
            '@box/schema/teleport/teleport-protocol': { TeleportProtocol: {} },
            'src/messenger': { messenger: { jumpTo: (value) => jumps.push(value.url) } },
            'src/config/client': { clientConfig: { isLocalGameServer: true } },
            'src/utils/public-url': utility,
        };
        vm.runInNewContext(compile('apps/game/src/engine/teleport/teleport-client.ts'), {
            exports,
            require: (name) => {
                assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
                return dependencies[name];
            },
        });
        let handlers;
        new exports.TeleportClient({
            client: {
                protocol: () => ({
                    configure: (options) => {
                        handlers = options.message;
                    },
                }),
            },
            state: {},
            connectGame() {},
        });
        handlers.editTeleport('map with space');
        handlers.editTeleport('');
        assert.deepEqual(jumps, [`${prefix}/e/map%20with%20space`]);
    });
}
