'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const game = path.resolve(__dirname, '../apps/game');

test('Jest fixtures isolate operator deployment settings before server modules load', () => {
    const context = {
        process: {
            env: {
                BOX_DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/fixture',
                BOX_TRUST_PROXY: 'true',
                BOX_PLAYER_LOGIN_URL: 'https://operator.invalid/login',
                BOX_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: '1',
                PERMISSION_TOKEN_SECRET: 'fixture-transport',
                MODERATION_TEST_DATABASE_URL:
                    'postgresql://fixture:fixture@disposable.invalid/fixture',
                PATH: '/fixture/node/bin',
                NODE_ENV: 'test',
                JEST_HTML_REPORT: '1',
            },
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(game, 'jest.environment.js'), 'utf8'), context);
    // These are the values consumed by the real authorization, rate-limit and
    // bootstrap modules. Fixtures subsequently configure their own exact cases.
    assert.equal(context.process.env.BOX_DATABASE_URL, undefined);
    assert.equal(context.process.env.BOX_TRUST_PROXY, undefined);
    assert.equal(context.process.env.BOX_PLAYER_LOGIN_URL, undefined);
    assert.equal(context.process.env.BOX_LOGIN_RATE_LIMIT_MAX_ATTEMPTS, undefined);
    assert.equal(context.process.env.PERMISSION_TOKEN_SECRET, undefined);
    assert.equal(
        context.process.env.MODERATION_TEST_DATABASE_URL,
        'postgresql://fixture:fixture@disposable.invalid/fixture',
    );
    assert.equal(context.process.env.PATH, '/fixture/node/bin');
    assert.equal(context.process.env.NODE_ENV, 'test');
    assert.equal(context.process.env.JEST_HTML_REPORT, '1');
});

test('Next Jest installs deployment isolation in setupFiles, before test imports', () => {
    const context = {
        process: { env: {} },
        module: { exports: {} },
        require(name) {
            assert.equal(name, 'next/jest');
            return () => (options) => options;
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(game, 'jest.config.js'), 'utf8'), context);
    assert.deepEqual(Array.from(context.module.exports.setupFiles), [
        '<rootDir>/jest.environment.js',
    ]);
});
