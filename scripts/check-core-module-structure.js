'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// Deliberately scoped to reviewed modules; this is not a whole-repository size check.
const modules = [
    'services/game-server/src/net/net-server-controller.ts',
    'services/game-server/src/net/net-state-operations.ts',
    'services/game-server/src/anticheat/anticheat-script.ts',
    'apps/player-admin/src/pages/maps/play-maps-page.tsx',
    'apps/player-admin/src/pages/maps/play-map-dialogs.tsx',
];

const graph = new Map();
for (const relative of modules) {
    const file = path.join(root, relative);
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.trimEnd().split('\n').length;
    assert.ok(
        lines <= 500,
        `${relative}: ${lines} lines; review responsibilities before splitting`,
    );
    const dependencies = [];
    for (const [, specifier] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (!specifier.startsWith('.')) {
            continue;
        }
        const base = path.resolve(path.dirname(file), specifier);
        const target = [
            base,
            `${base}.ts`,
            `${base}.tsx`,
            `${base}.js`,
            path.join(base, 'index.ts'),
        ].find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
        assert.ok(target, `${relative}: missing relative import ${specifier}`);
        if (modules.includes(path.relative(root, target))) {
            dependencies.push(target);
        }
    }
    graph.set(file, dependencies);
    if (relative.endsWith('/net-state-operations.ts')) {
        assert.doesNotMatch(
            source,
            /from ['"]\.\/net-server-controller['"]/,
            'state operations must not depend on transport orchestration',
        );
    }
    if (relative.endsWith('/play-map-dialogs.tsx')) {
        assert.doesNotMatch(
            source,
            /from ['"][^'"]*player-admin-api['"]/,
            'presentation must not own admin requests',
        );
    }
    console.log(`${relative}: ${lines} lines`);
}

function visit(file, stack = []) {
    assert.ok(
        !stack.includes(file),
        `circular module imports: ${[...stack, file].map((item) => path.relative(root, item)).join(' -> ')}`,
    );
    for (const dependency of graph.get(file) || []) {
        visit(dependency, [...stack, file]);
    }
}
for (const file of graph.keys()) {
    visit(file);
}
console.log(
    'Reviewed core module structure passed: size, relative imports and dependency direction',
);
