import http from 'node:http';
import fs from 'node:fs';
if (fs.existsSync(new URL('../.env', import.meta.url)) && process.loadEnvFile) {
    process.loadEnvFile(new URL('../.env', import.meta.url));
}
const checks = [
    ['creator', 'BOX_DEV_CREATOR_PORT', 13527, '/api/health-check'],
    ['identity', 'BOX_DEV_PLAYER_SERVICE_PORT', 13124, '/api/health-check'],
    ['voxa', 'BOX_DEV_VOXA_PORT', 13123, '/api/health-check'],
    ['admin', 'BOX_DEV_PLAYER_ADMIN_PORT', 18000, '/'],
];
const results = await Promise.all(
    checks.map(
        ([name, key, fallback, path]) =>
            new Promise((resolve) => {
                const port = Number(process.env[key] || fallback);
                if (port >= 3121 && port <= 3127) {
                    return resolve({
                        name,
                        ok: false,
                        error: 'Production port is forbidden in this development check',
                    });
                }
                const req = http.get({ host: '127.0.0.1', port, path, timeout: 30000 }, (res) => {
                    res.resume();
                    resolve({ name, port, status: res.statusCode, ok: res.statusCode === 200 });
                });
                req.on('timeout', () => req.destroy(new Error('timeout')));
                req.on('error', (error) =>
                    resolve({ name, port, ok: false, error: error.message }),
                );
            }),
    ),
);
console.log(JSON.stringify({ ok: results.every((row) => row.ok), checks: results }, null, 2));
if (results.some((row) => !row.ok)) {
    process.exitCode = 1;
}
