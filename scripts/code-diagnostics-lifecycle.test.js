const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const controller = fs.readFileSync(
    path.join(root, 'apps/game/src/client/edit/code-editor/code-editor-client-controller.ts'),
    'utf8',
);
const monaco = fs.readFileSync(
    path.join(root, 'apps/game/src/client/edit/code-editor/monaco.ts'),
    'utf8',
);
const debugPanel = fs.readFileSync(
    path.join(root, 'apps/game/src/views/edit/components/debugPanel/index.tsx'),
    'utf8',
);

test('entering a map does not eagerly create every script diagnostic model', () => {
    const monacoReady = controller.match(
        /public monacoReady[\s\S]*?\/\/ 文件恢复-fileSystem用的/,
    )?.[0];
    assert.ok(monacoReady, 'monacoReady method not found');
    assert.doesNotMatch(monacoReady, /prepareModelForAllFiles\(/);
    assert.doesNotMatch(monaco, /setEagerModelSync\(true\)/);
});

test('live diagnostics and the Problems panel stay disabled', () => {
    assert.match(monaco, /noSemanticValidation:\s*true/);
    assert.match(monaco, /noSyntaxValidation:\s*true/);
    assert.match(monaco, /checkJs:\s*false/);
    assert.doesNotMatch(debugPanel, /connectProblemDiagnostics|getProblems\(/);
    assert.doesNotMatch(debugPanel, /id:\s*'problems'/);
    assert.doesNotMatch(controller, /public async getProblems\(/);
});
