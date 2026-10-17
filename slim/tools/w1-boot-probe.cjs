#!/usr/bin/env node
// W1 verification harness: boot a Next standalone server entry and record the
// HTTP status of a fixed route list, so the same probe can be run against the
// unpruned control tree and the pruned tree in one container session.
//
//   node w1-boot-probe.cjs <server.js> <label> [port]
//
// Prints one `RESULT <label> <route> <status|ERR>` line per probe plus a
// MODULE_ERRORS count scraped from the server's own stdout/stderr.

const { spawn } = require('node:child_process');
const path = require('node:path');

const entry = path.resolve(process.argv[2] || '');
const label = process.argv[3] || 'run';
const port = Number(process.argv[4] || 3457);
const ROUTES = ['/', '/api/health-check', '/404', '/api/config/play/x', '/api/server-info'];

if (!entry) {
    throw new Error('usage: node w1-boot-probe.cjs <server.js> <label> [port]');
}

const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => {
    output += d;
});
child.stderr.on('data', (d) => {
    output += d;
});
child.on('exit', (code) => {
    output += `\n[exit code ${code}]\n`;
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline) {
        try {
            await fetch(`http://127.0.0.1:${port}/api/health-check`, { signal: AbortSignal.timeout(1500) });
            up = true;
            break;
        } catch {
            await wait(500);
        }
    }

    console.log(`LISTENING ${label} ${up}`);
    if (!up) {
        console.log(output.slice(-3000));
        child.kill('SIGKILL');
        process.exit(1);
    }

    for (const route of ROUTES) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}${route}`, {
                signal: AbortSignal.timeout(20_000),
                redirect: 'manual',
            });
            console.log(`RESULT ${label} ${route} ${response.status}`);
        } catch (error) {
            console.log(`RESULT ${label} ${route} ERR:${error.message}`);
        }
    }

    const moduleErrors = output
        .split('\n')
        .filter((line) => /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(line));
    console.log(`MODULE_ERRORS ${label} ${moduleErrors.length}`);
    moduleErrors.slice(0, 8).forEach((line) => console.log(`  ${label}: ${line.trim().slice(0, 300)}`));

    child.kill('SIGKILL');
    process.exit(up ? 0 : 1);
})();
