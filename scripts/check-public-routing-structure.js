'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const modules = [
    'apps/manager-core/src/public_access.rs',
    'apps/manager-core/src/public_access/tests.rs',
    'apps/manager-core/src/ssl.rs',
    ...[
        'apply',
        'certificate_checks',
        'certificates',
        'plan',
        'proxy',
        'runtime',
        'transition',
    ].map((name) => `apps/manager-core/src/ssl/${name}.rs`),
];

for (const file of modules) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(source.trimEnd().split('\n').length <= 500, `${file} exceeds 500 lines`);
}

const formatted = spawnSync(
    'rustfmt',
    ['--check', '--edition', '2021', '--config', 'skip_children=true', ...modules],
    { cwd: root, stdio: 'inherit' },
);
assert.ifError(formatted.error);
assert.equal(formatted.status, 0, 'public routing Rust modules need rustfmt');
console.log(`Public routing structure passed: ${modules.length} formatted Rust modules`);
