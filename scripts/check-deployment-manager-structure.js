'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { frontendFiles } = require('./lib/deployment-manager-source');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'apps/deployment-manager/src');
const graph = new Map();
let largest = { lines: 0, file: '' };

for (const extension of ['.js', '.css']) {
    for (const file of frontendFiles(root, extension)) {
        const relative = path.relative(directory, file).split(path.sep).join('/');
        const source = fs.readFileSync(file, 'utf8');
        const lines = source.trimEnd().split('\n').length;
        assert.ok(
            lines < 500,
            `${path.relative(root, file)} has ${lines} lines; keep source files below 500 lines`,
        );
        if (lines > largest.lines) {
            largest = { lines, file: relative };
        }

        const dependencies = [];
        for (const [, specifier] of source.matchAll(
            /(?:from\s+|import\s*|@import\s*)['"]([^'"]+)['"]/g,
        )) {
            if (!specifier.startsWith('.')) {
                continue;
            }
            const target = path.resolve(path.dirname(file), specifier);
            assert.ok(
                fs.existsSync(target),
                `${path.relative(root, file)} imports missing ${specifier}`,
            );
            if (target.endsWith('.js')) {
                dependencies.push(target);
            }
        }
        if (extension === '.js') {
            graph.set(file, dependencies);
        }
        if (extension === '.js' && relative !== 'infrastructure/transport.js') {
            assert.doesNotMatch(
                source,
                /from ['"]@tauri-apps\//,
                'native bridge imports belong in infrastructure/transport.js',
            );
        }
        if (relative.startsWith('views/')) {
            assert.doesNotMatch(
                source,
                /from ['"].*\/operations\//,
                'views must render data rather than call operations',
            );
        }
    }
}

const visited = new Set();
function visit(file, stack = []) {
    assert.ok(
        !stack.includes(file),
        `circular frontend imports: ${[...stack, file].map((item) => path.relative(directory, item)).join(' -> ')}`,
    );
    if (visited.has(file)) {
        return;
    }
    for (const dependency of graph.get(file) || []) {
        visit(dependency, [...stack, file]);
    }
    visited.add(file);
}
for (const file of graph.keys()) {
    visit(file);
}

console.log(
    `Deployment manager structure passed: ${graph.size} JavaScript modules; largest source ${largest.file} (${largest.lines} lines)`,
);
