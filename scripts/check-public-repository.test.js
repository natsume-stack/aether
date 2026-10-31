'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { forbiddenPath, inspect } = require('./check-public-repository');

test('internal source, live environments and runtime data cannot be published', () => {
    for (const file of [
        'apps/migrator/pages/index.tsx',
        'apps/license-server/.local/issuer.json',
        'license/old.boxlic',
        'apps/local-engine/projects/private/project.json',
        'apps/voxa/data/model.json',
        'dump.sqlite',
        'debug.log',
        '.runtime.env',
        'apps/player-launcher/private/tmp/player-apply.mjs',
        'internals/dev-certs/certs/minica-key.pem',
    ]) {
        assert.ok(forbiddenPath(file), file);
    }
    assert.ok(!forbiddenPath('apps/game/pages/projects/index.tsx'));
    assert.ok(!forbiddenPath('packages/regl/LICENSE'));
    assert.ok(forbiddenPath('box-local-engine-internal/apps/migrator/package.json'));
    assert.ok(
        inspect('renamed/package.json', '{"name":"@box/migrator"}').includes(
            'internal-project-manifest',
        ),
    );
    assert.ok(
        inspect('.env.example', 'API_KEY=' + 'a'.repeat(32)).includes(
            'embedded-environment-credential',
        ),
    );
    assert.deepEqual(inspect('.env.local', 'VALUE=private'), ['private-environment-file']);
});

test('content-addressed names do not hide project state or retired business scripts', () => {
    const file = 'apps/local-engine/data/blobs/QmFixture';
    assert.ok(
        inspect(file, JSON.stringify({ owner: 'fixture', users: {} })).includes(
            'embedded-project-or-user-state',
        ),
    );
    assert.ok(
        inspect(file, JSON.stringify({ 123: { createdAt: 'fixture' } })).includes(
            'embedded-project-or-user-state',
        ),
    );
    assert.ok(
        inspect(file, 'player.url = "https://portal-backstage.dao3.fun"').includes(
            'internal-business-script',
        ),
    );
    assert.deepEqual(inspect(file, JSON.stringify({ textures: ['fixture'] })), []);
});

test('public development defaults cannot silently acquire credentials', () => {
    const defaults =
        'NEXT_PUBLIC_APP_ENV=development\nNEXT_PUBLIC_APP_EDITION=createra\nNEXT_PUBLIC_APP_REGION=oversea\n';
    assert.deepEqual(inspect('apps/game/.env.development', defaults), []);
    assert.ok(inspect('apps/game/.env.development', defaults + 'PRIVATE_TOKEN=hidden').length);
    assert.deepEqual(inspect('apps/game/rusty/.env.prod', 'RUSTY_CONFIG_URL='), []);
    assert.ok(
        inspect('apps/game/rusty/.env.prod', 'RUSTY_CONFIG_URL=https://private.invalid').length,
    );
});

test('credential diagnostics identify rule kinds without returning secret values', () => {
    const value = 'ghp_' + 'a'.repeat(36);
    const found = inspect('src/settings.js', `const value = "${value}"`);
    assert.ok(found.includes('provider-credential'));
    assert.ok(!JSON.stringify(found).includes(value));
    assert.ok(
        inspect(
            'src/key.js',
            '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n-----END PRIVATE KEY-----',
        ).includes('private-key-material'),
    );
    assert.deepEqual(inspect('README.md', 'API_KEY="CHANGE_ME_BEFORE_PRODUCTION"'), []);
});
