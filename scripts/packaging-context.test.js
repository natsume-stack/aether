'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { packagingContext, versionForChannel } = require('./packaging-context');

test('local builds stay dev on any branch and ignore release channel environment values', () => {
    for (const branch of ['dev', 'main', 'staging', 'release']) {
        for (const channel of ['production', 'staging']) {
            const env = {
                GITHUB_REF: `refs/heads/${branch}`,
                BOX_BUILD_CHANNEL: channel,
                PLAYER_BUILD_CHANNEL: channel,
                BOX_BUILD_VERSION: '2026.1.4',
            };
            assert.deepEqual(packagingContext(env, '2026.1.4'), {
                channel: 'dev',
                version: '2026.1.4-dev',
            });
            assert.deepEqual(packagingContext(env, '2026.1.2', 'PLAYER_BUILD_CHANNEL'), {
                channel: 'dev',
                version: '2026.1.2-dev',
            });
        }
    }
    for (const version of ['2026.1.4', '2026.1.4-dev', '2026.1.4-staging']) {
        assert.equal(versionForChannel(version, 'dev'), '2026.1.4-dev');
    }
});

test('GitHub Actions retains staging and production identities', () => {
    for (const branch of ['staging', 'release']) {
        const channel = branch === 'release' ? 'production' : branch;
        const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: `refs/heads/${branch}` };
        assert.equal(packagingContext(env, '2026.1.4').channel, channel);
        assert.equal(
            packagingContext(env, '2026.1.4').version,
            `2026.1.4${branch === 'staging' ? '-staging' : ''}`,
        );
    }
    assert.throws(() => versionForChannel('2026.1.4-dev', 'production'), /cannot enter/);
});

test('Electron builder config carries the actual channel version and application identifier', () => {
    const configFile = path.resolve(
        __dirname,
        '../apps/player-launcher/scripts/electron-builder.cjs',
    );
    const manifest = require('../apps/player-launcher/package.json');
    for (const [env, channel] of [
        [{ GITHUB_ACTIONS: '', PLAYER_BUILD_CHANNEL: 'staging' }, 'dev'],
        [{ GITHUB_ACTIONS: 'true', PLAYER_BUILD_CHANNEL: 'staging' }, 'staging'],
        [{ GITHUB_ACTIONS: 'true', PLAYER_BUILD_CHANNEL: 'production' }, 'production'],
    ]) {
        const result = spawnSync(
            process.execPath,
            ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', configFile],
            {
                env: { ...process.env, ...env },
                encoding: 'utf8',
            },
        );
        assert.equal(result.status, 0, result.stderr);
        const config = JSON.parse(result.stdout);
        assert.equal(config.extraMetadata.version, versionForChannel(manifest.version, channel));
        assert.equal(
            config.appId,
            `com.box.player.launcher${channel === 'production' ? '' : `.${channel}`}`,
        );
        assert.equal(require('../apps/player-launcher/package.json').version, manifest.version);
    }
});
