'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { locateTool, commonParent, environment, scriptPlan } = require('./internal-migrator');

test('private tool is optional, external and validated without exposing secrets', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'box-private-tool-test-'));
    try {
        const engine = path.join(folder, 'local-engine');
        const tool = path.join(folder, 'box-local-engine-internal/apps/migrator');
        fs.mkdirSync(engine);
        assert.throws(() => locateTool(engine), /未安装内部迁移器/);
        fs.mkdirSync(tool, { recursive: true });
        fs.writeFileSync(
            path.join(tool, 'package.json'),
            JSON.stringify({ name: '@box/migrator' }),
        );
        assert.equal(locateTool(engine), fs.realpathSync(tool));
        assert.equal(commonParent(engine, tool), folder);
        const inside = path.join(engine, 'private-tool');
        fs.mkdirSync(inside);
        fs.writeFileSync(
            path.join(inside, 'package.json'),
            JSON.stringify({ name: '@box/migrator' }),
        );
        assert.throws(() => locateTool(engine, inside), /仓库之外/);
        const env = environment(engine, tool, {
            BOX_MIGRATOR_ENGINE_API_KEY: 'fixture-private-key',
        });
        assert.equal(env.BOX_MIGRATOR_ENGINE_API_KEY, 'fixture-private-key');
        assert.equal(env.BOX_MIGRATOR_CACHE_DIR, path.join(tool, 'cache'));
        assert.equal(
            env.BOX_MIGRATOR_RUNTIME_TEMPLATE,
            path.join(engine, 'apps/local-engine/data'),
        );
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

test('commands use a fixed interface and loopback development binding', () => {
    assert.deepEqual(scriptPlan('dev').args, ['run', 'dev', '--', '--hostname', '127.0.0.1']);
    assert.deepEqual(scriptPlan('test').args, ['run', 'test']);
    assert.throws(() => scriptPlan('arbitrary-shell-command'), /未知/);
});
