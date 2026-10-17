'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('console production build prepares generated API entry points before Vite', () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../apps/deployment-manager/package.json'), 'utf8'),
    );
    for (const command of ['build', 'check']) {
        const script = manifest.scripts[command];
        const api = script.indexOf('npm --prefix ../../internals/apis run build');
        const vite = script.indexOf('vite build');
        assert.ok(api >= 0 && api < vite, `${command} must prepare API runtime before Vite`);
    }
});
