const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'apps/local-engine/src/launcher.js'), 'utf8');
const createServer = fs.readFileSync(
    path.join(root, 'services/game-server/src/createServer.ts'),
    'utf8',
);

test('local runtimes do not enable fake admin or guest login modes', () => {
    assert.doesNotMatch(launcher, /LOGIN:\s*mode === 'edit' \? 'admin' : 'guest'/);
    assert.doesNotMatch(launcher, /LOGIN:\s*'guest'/);
});

test('authenticated editor account receives editor privileges without changing identity', () => {
    assert.match(createServer, /runtimeIdentity\.role === 'admin' \|\| editServer/);
    assert.match(createServer, /userData\.id = runtimeIdentity\.userId/);
    assert.match(createServer, /userData\.displayname = runtimeIdentity\.displayName/);
});
