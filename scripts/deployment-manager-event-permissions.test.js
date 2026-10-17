'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('native launcher can subscribe to and release progress events', () => {
    const root = path.join(__dirname, '../apps/deployment-manager/src-tauri/capabilities');
    const capabilities = fs.existsSync(root)
        ? fs
              .readdirSync(root)
              .filter((name) => name.endsWith('.json'))
              .map((name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')))
        : [];
    const permissions = capabilities
        .filter((capability) => capability.windows?.includes('main') && capability.local !== false)
        .flatMap((capability) => capability.permissions || []);
    for (const permission of ['core:event:allow-listen', 'core:event:allow-unlisten']) {
        assert.ok(
            permissions.includes(permission),
            `Missing native progress permission: ${permission}`,
        );
    }
});
