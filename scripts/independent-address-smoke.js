'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const tls = require('node:tls');

function webSocketHandshake(entry, certificate) {
    return new Promise((resolve, reject) => {
        const socket =
            entry.protocol === 'https'
                ? tls.connect({
                      host: '127.0.0.1',
                      port: entry.port,
                      servername: entry.host,
                      ca: fs.readFileSync(certificate),
                      rejectUnauthorized: true,
                  })
                : net.connect({ host: '127.0.0.1', port: entry.port });
        let response = '';
        socket.setTimeout(5000, () => socket.destroy(new Error('WebSocket handshake timed out')));
        socket.once('error', reject);
        socket.once(entry.protocol === 'https' ? 'secureConnect' : 'connect', () =>
            socket.write(
                `GET /runtime/play/town/ws HTTP/1.1\r\nHost: ${entry.host}:${entry.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
            ),
        );
        socket.on('data', (data) => {
            response += data.toString();
            if (response.includes('\r\n\r\n')) {
                socket.destroy();
                resolve(response);
            }
        });
        socket.once('end', () => {
            if (!response.includes('\r\n\r\n')) {
                reject(new Error('WebSocket closed without a handshake'));
            }
        });
    });
}

async function main() {
    const root = path.resolve(__dirname, '..');
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    const { externalNginxConfiguration } = await import(
        pathToFileURL(
            path.join(root, 'apps/deployment-manager/src/configuration/external-nginx.js'),
        )
    );
    const { publicServices } = await import(
        pathToFileURL(path.join(root, 'apps/deployment-manager/src/configuration/public-access.js'))
    );
    const { state } = await import(
        pathToFileURL(path.join(root, 'apps/deployment-manager/src/core/state.js'))
    );
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'box-independent-smoke-'));
    const id = `${process.pid}-${Date.now()}`;
    const upstream = `box-independent-upstreams-${id}`;
    const proxy = `box-independent-proxy-${id}`;
    const docker = (args) =>
        execFileSync('docker', args, {
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    const base = Number(process.env.BOX_ROUTING_SMOKE_PORT_BASE || 18381);
    const matrices = [
        {
            name: 'HTTP independent domains',
            protocol: 'http',
            port: () => base,
            host: (service) => `${service}.box-smoke.test`,
        },
        {
            name: 'HTTPS independent domains',
            protocol: 'https',
            port: () => base + 1,
            host: (service) => `${service}.box-smoke.test`,
        },
        {
            name: 'HTTP independent ports',
            protocol: 'http',
            port: (index) => base + 2 + index,
            host: () => '127.0.0.1',
        },
        {
            name: 'HTTPS independent domains and ports',
            protocol: 'https',
            port: (index) => base + 7 + index,
            host: (service) => `${service}.box-smoke.test`,
        },
        {
            name: 'Mixed HTTP and HTTPS independent services',
            protocol: 'mixed',
            port: (index) => base + 12 + index,
            host: (service) => `${service}.box-smoke.test`,
        },
    ];
    try {
        const certs = path.join(temporary, 'certs');
        fs.mkdirSync(certs);
        const certificate = path.join(temporary, 'certificate.pem');
        const privateKey = path.join(temporary, 'private-key.pem');
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-days',
                '1',
                '-subj',
                '/CN=box-smoke.test',
                '-addext',
                `subjectAltName=${publicServices.map(([service]) => `DNS:${service}.box-smoke.test`).join(',')}`,
                '-keyout',
                privateKey,
                '-out',
                certificate,
            ],
            { stdio: 'ignore' },
        );
        for (const [service] of publicServices) {
            const directory = path.join(certs, `${service}.box-smoke.test`);
            fs.mkdirSync(directory);
            fs.copyFileSync(certificate, path.join(directory, 'fullchain.pem'));
            fs.copyFileSync(privateKey, path.join(directory, 'privkey.pem'));
        }
        const ports = new Set();
        const cases = [];
        const configurations = [];
        state.sslDraft = { mode: 'external' };
        for (const matrix of matrices) {
            state.externalGuideProtocol = matrix.protocol === 'http' ? 'http' : 'https';
            const config = {
                publicAddressMode: 'independent',
                playNetworkMode: 'public',
                creatorNetworkMode: 'public',
                publicServicePaths: Object.fromEntries(
                    publicServices.map(([service]) => [service, '/stale-shared-prefix']),
                ),
            };
            publicServices.forEach(([service, _label, field, key, fallback], index) => {
                const protocol =
                    matrix.protocol === 'mixed' ? (index % 2 ? 'https' : 'http') : matrix.protocol;
                const port = matrix.port(index);
                const host = matrix.host(service);
                ports.add(port);
                config[field] = `${protocol}://${host}:${port}`;
                config[key] = fallback;
                cases.push({ matrix: matrix.name, service, protocol, host, port });
            });
            const result = externalNginxConfiguration(config);
            assert.equal(result.error, '');
            assert.equal((result.content.match(/server \{/g) || []).length, 5);
            assert.ok(!result.content.includes('rewrite '));
            assert.ok(!result.content.includes('/stale-shared-prefix'));
            configurations.push(
                configurations.length
                    ? result.content.replace(/^map \$http_upgrade.*$/m, '')
                    : result.content,
            );
        }
        const configuration = path.join(temporary, 'nginx.conf');
        fs.writeFileSync(configuration, `events {}\nhttp {\n${configurations.join('\n')}\n}\n`);
        docker([
            'run',
            '-d',
            '--name',
            upstream,
            ...[...ports].flatMap((port) => ['-p', `127.0.0.1:${port}:${port}`]),
            '--mount',
            `type=bind,src=${path.join(__dirname, 'lib/independent-address-upstreams.cjs')},dst=/fixtures/upstreams.cjs,readonly`,
            '--entrypoint',
            'node',
            'box-local-engine-play:v2026.1.4-linux-arm64',
            '/fixtures/upstreams.cjs',
        ]);
        const mounts = [
            '--mount',
            `type=bind,src=${configuration},dst=/etc/nginx/nginx.conf,readonly`,
            '--mount',
            `type=bind,src=${certs},dst=/etc/letsencrypt/live,readonly`,
        ];
        const image = 'docker.m.daocloud.io/library/nginx:stable-bookworm';
        docker([
            'run',
            '--rm',
            '--network',
            `container:${upstream}`,
            ...mounts,
            image,
            'nginx',
            '-t',
        ]);
        docker([
            'run',
            '-d',
            '--name',
            proxy,
            '--network',
            `container:${upstream}`,
            ...mounts,
            image,
        ]);
        for (const entry of cases) {
            const url = `${entry.protocol}://${entry.host}:${entry.port}`;
            const args = [
                '--noproxy',
                '*',
                '--silent',
                '--show-error',
                '--max-time',
                '5',
                '--cacert',
                certificate,
                '--resolve',
                `${entry.host}:${entry.port}:127.0.0.1`,
            ];
            let body;
            for (let attempt = 0; attempt < 20; attempt++) {
                try {
                    body = execFileSync('curl', [...args, `${url}/api/health-check?probe=1`], {
                        encoding: 'utf8',
                        timeout: 6000,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    break;
                } catch (error) {
                    if (attempt === 19) {
                        throw error;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
            const response = JSON.parse(body);
            assert.equal(response.service, entry.service);
            assert.equal(response.path, '/api/health-check?probe=1');
            assert.equal(response.host, `${entry.host}:${entry.port}`);
            assert.equal(response.protocol, entry.protocol);
            const resource = JSON.parse(
                execFileSync('curl', [...args, `${url}/_next/static/chunks/demo.js`], {
                    encoding: 'utf8',
                    timeout: 6000,
                }),
            );
            assert.equal(resource.service, entry.service);
            assert.equal(resource.path, '/_next/static/chunks/demo.js');
            const upgrade = await webSocketHandshake(entry, certificate);
            assert.match(upgrade, /101 Switching Protocols/);
            assert.match(upgrade, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
        }
        console.log(
            JSON.stringify({
                passed: true,
                matrices: matrices.map((value) => value.name),
                services: cases.length,
                httpAndResourceChecks: cases.length * 2,
                webSocketChecks: cases.length,
            }),
        );
    } catch (error) {
        for (const name of [proxy, upstream]) {
            try {
                console.error(docker(['logs', name]));
            } catch {
                // A container that failed to start may not have logs.
            }
        }
        throw error;
    } finally {
        for (const name of [proxy, upstream]) {
            try {
                docker(['rm', '-f', name]);
            } catch {
                // Continue cleaning the remaining resources if a container is already absent.
            }
        }
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
