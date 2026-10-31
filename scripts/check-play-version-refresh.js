'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startPlayLibrary } = require('../apps/local-engine/src/play-library');

function request(port, pathname) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks).toString()));
        }).on('error', reject);
    });
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-play-refresh-'));
    const worldRoot = path.join(root, 'world');
    const dataRoot = path.join(worldRoot, 'data');
    const manifestPath = path.join(worldRoot, 'manifest.json');
    const statePath = path.join(dataRoot, 'project-state.json');
    const markerPath = path.join(dataRoot, 'marker.txt');
    const fixedTime = new Date('2020-01-01T00:00:00.000Z');
    fs.mkdirSync(path.join(dataRoot, 'blobs'), { recursive: true });

    const writeWorld = (version, marker) => {
        fs.writeFileSync(
            manifestPath,
            JSON.stringify({
                id: 'world',
                version,
                permissionHash: 'QmTestPermissionHash',
            }),
        );
        fs.writeFileSync(
            statePath,
            JSON.stringify({
                permissionHash: 'QmTestPermissionHash',
                extraProjectHash: '',
            }),
        );
        fs.writeFileSync(markerPath, marker);
        // Reproduce archive replacement where timestamps and file sizes are
        // unchanged. Version must still invalidate the active runtime.
        fs.utimesSync(manifestPath, fixedTime, fixedTime);
    };
    writeWorld('v1', 'old');

    let nextRuntimePort = 23000 + (process.pid % 10000);
    const library = startPlayLibrary({
        libraryRoot: root,
        host: '127.0.0.1',
        port: 0,
        runtimePortStart: nextRuntimePort,
        startRuntime: async (world, port) => {
            const marker = fs.readFileSync(path.join(world.dataRoot, 'marker.txt'), 'utf8');
            const server = http.createServer((_req, res) => res.end(marker));
            await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
            return {
                port,
                exited: false,
                async stop() {
                    this.exited = true;
                    await new Promise((resolve) => server.close(resolve));
                },
            };
        },
        waitForRuntime: async () => {},
    });

    try {
        await library.ready;
        const proxyPort = library.server.address().port;
        const before = await request(proxyPort, '/world/test');
        writeWorld('v2', 'new');
        const after = await request(proxyPort, '/world/test');
        if (before !== 'old' || after !== 'new') {
            throw new Error(`stale runtime: before=${before} after=${after}`);
        }
    } finally {
        await library.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('Play version refresh check passed');
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
