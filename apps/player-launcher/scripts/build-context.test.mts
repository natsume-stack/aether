import assert from 'node:assert/strict';
import { test } from 'node:test';

import { playerBuildContext } from './build-context.mts';
import { artifactName, validateManifest } from './release-contract.mts';
import { cachedInstaller } from './release-cache.mts';
import { createOssClient } from './oss-client.mts';

const commit = 'a'.repeat(40);
const testing = {
    PLAYER_BUILD_CHANNEL: 'staging',
    GITHUB_REF: 'refs/heads/staging',
    GITHUB_SHA: commit,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
};

test('player test builds use staging versions and an isolated immutable upload namespace', async () => {
    const context = playerBuildContext(testing, '0.1.0');
    assert.equal(context.channel, 'staging');
    assert.equal(context.info.version, '0.1.0-staging');
    assert.equal(context.info.tag, 'player-v0.1.0-staging');
    assert.equal(context.prefix, `box-player-launcher-staging/player-v0.1.0-staging/${commit}`);
    const file = artifactName(context.info, 'windows-amd64');
    assert.ok(file.includes('-staging-'));
    assert.equal(
        playerBuildContext({ ...testing, GITHUB_RUN_ATTEMPT: '2' }, '0.1.0').prefix.endsWith(
            commit,
        ),
        true,
    );
    assert.equal(playerBuildContext(testing, '0.2.0-beta.1').info.version, '0.2.0-beta.1.staging');
    const keys:string[] = [];
    await cachedInstaller(
        {
            head: async (key) => {
                keys.push(key);
                return null;
            },
        },
        context.info,
        'windows-amd64',
        context.prefix,
    );
    assert.deepEqual(keys, [`${context.prefix}/${file}`]);
    assert.throws(() =>
        validateManifest(
            {
                formatVersion: 1,
                ...context.info,
                version: '0.1.0',
                target: 'windows-amd64',
                file,
                size: 10,
                sha256: 'b'.repeat(64),
            },
            context.info,
            'windows-amd64',
        ),
    );
});

test('main, tags, unknown channels and invalid run identities cannot enter the player test channel', () => {
    for (const ref of [
        'refs/heads/main',
        'refs/heads/dev',
        'refs/heads/release',
        'refs/heads/player-dev/profile',
        'refs/tags/player-v0.1.0',
    ]) {
        assert.throws(
            () => playerBuildContext({ ...testing, GITHUB_REF: ref }, '0.1.0'),
            /require the staging/,
        );
    }
    assert.throws(
        () => playerBuildContext({ ...testing, PLAYER_BUILD_CHANNEL: 'other' }, '0.1.0'),
        /Unknown/,
    );
    assert.throws(
        () => playerBuildContext({ ...testing, GITHUB_SHA: 'invalid' }, '0.1.0'),
        /commit SHA/,
    );
});

test('production player versions come from their own versioned branch', () => {
    const context = playerBuildContext(
        { GITHUB_REF: 'refs/heads/player-release/v2026.1.3', GITHUB_SHA: commit },
        '2026.1.2',
    );
    assert.equal(context.channel, 'production');
    assert.equal(context.prefix, 'box-player-launcher/player-v2026.1.3');
    assert.equal(context.info.version, '2026.1.3');
    for (const ref of [
        'refs/heads/release',
        'refs/heads/release/v2026.1.3',
        'refs/tags/player-v2026.1.3',
        'refs/heads/player-release/v2026.1.3-staging',
    ]) {
        assert.throws(() =>
            playerBuildContext({ GITHUB_REF: ref, GITHUB_SHA: commit }, '2026.1.2'),
        );
    }
    assert.throws(
        () =>
            playerBuildContext(
                {
                    GITHUB_REF: 'refs/heads/player-release/v2026.1.3',
                    GITHUB_SHA: commit,
                    PLAYER_RELEASE_TAG: 'player-v2026.1.2',
                },
                '2026.1.2',
            ),
        /does not match/,
    );
});

test('a test-scoped OSS client uploads only to its own commit and rejects production destinations', async () => {
    const { prefix } = playerBuildContext(testing, '0.1.0');
    const calls:string[][] = [];
    const client = await createOssClient(
        {
            bucket: 'fixture-bucket',
            endpoint: 'oss.example.test',
            accessKeyId: 'fixture-id',
            accessKeySecret: 'fixture-secret',
        },
        async ({ args }) => {
            calls.push(args);
            return { stdout: '', stderr: '' };
        },
        `${prefix}/`,
    );
    try {
        await client.upload(`${prefix}/installer.exe`, 'fixture.exe');
        assert.ok(calls[0].includes(`s3://fixture-bucket/${prefix}/installer.exe`));
        for (const key of [
            'box-player-launcher/player-v0.1.0/installer.exe',
            `box-player-launcher-staging/player-v0.1.0-staging/${'b'.repeat(40)}/installer.exe`,
            `${prefix}/../installer.exe`,
        ]) {
            await assert.rejects(client.upload(key, 'fixture.exe'), /OSS key/);
        }
        assert.equal(calls.length, 1);
    } finally {
        await client.close();
    }
});
