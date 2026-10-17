'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const prettierCli = require.resolve('prettier/bin/prettier.cjs', {
    paths: [path.join(root, 'tools/repo-tooling')],
});
const write = process.argv.includes('--write');
const owned = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/format-owned-code.js'), ...(write ? ['--write'] : [])],
    { cwd: root, stdio: 'inherit' },
);
if (owned.error) {
    throw owned.error;
}
if (owned.status !== 0) {
    process.exit(owned.status ?? 1);
}
const result = spawnSync(
    process.execPath,
    [prettierCli, write ? '--write' : '--check', '--ignore-path', '.prettierignore', '.'],
    { cwd: root, stdio: 'inherit' },
);

if (result.error) {
    throw result.error;
}
process.exit(result.status ?? 1);
