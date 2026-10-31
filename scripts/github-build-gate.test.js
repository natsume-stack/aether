'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    githubContext,
    githubGet,
    releaseIdentity,
    checkRelease,
    createTag,
    reserveRelease,
} = require('./github-build-gate');

const commit = 'a'.repeat(40);
const context = {
    repository: 'fixture/engine',
    commit,
    token: 'fixture-token',
    ref: 'refs/heads/staging',
};
const pull = {
    merged_at: '2026-10-13T00:00:00Z',
    merge_commit_sha: commit,
    base: { ref: 'staging', repo: { full_name: context.repository } },
};

test('version reservation creates only the current immutable commit tag', async () => {
    const selected = { ...context, ref: 'refs/heads/release/v2026.1.0' };
    const identity = releaseIdentity('engine', '2026.1.0');
    let creates = 0;
    assert.deepEqual(
        await reserveRelease(
            selected,
            identity,
            async () => null,
            async () => {
                creates++;
                return true;
            },
        ),
        identity,
    );
    assert.equal(creates, 1);
    await reserveRelease(
        selected,
        identity,
        async () => ({ object: { type: 'commit', sha: commit } }),
        async () => {
            throw new Error('must not recreate tag');
        },
    );
    await assert.rejects(
        reserveRelease(
            selected,
            identity,
            async () => ({ object: { type: 'commit', sha: 'b'.repeat(40) } }),
            async () => {
                throw new Error('must not move tag');
            },
        ),
        /new versioned release branch/,
    );
    assert.equal(
        await createTag(selected, identity, async (url, options) => {
            assert.equal(url, 'https://api.github.com/repos/fixture/engine/git/refs');
            assert.equal(options.method, 'POST');
            assert.deepEqual(JSON.parse(options.body), { ref: 'refs/tags/v2026.1.0', sha: commit });
            return { status: 201, ok: true };
        }),
        true,
    );
    assert.equal(
        await createTag(selected, identity, async () => ({ status: 422, ok: false })),
        false,
    );
});

test('tag creation races are resolved against GitHub, never by trusting a cache', async () => {
    const selected = { ...context, ref: 'refs/heads/player-release/v0.1.0' };
    const identity = releaseIdentity('player', '0.1.0');
    let reads = 0;
    await reserveRelease(
        selected,
        identity,
        async () => (++reads === 1 ? null : { object: { type: 'commit', sha: commit } }),
        async () => false,
    );
    assert.equal(reads, 2);
    await assert.rejects(
        reserveRelease(
            selected,
            identity,
            async () => null,
            async () => false,
        ),
        /not confirmed/,
    );
    await assert.rejects(
        createTag(selected, identity, async () => ({ status: 403, ok: false })),
        /reservation failed/,
    );
});

test('GitHub requests are authenticated, bounded and fail closed without echoing tokens', async () => {
    assert.throws(() => githubContext({}), /requires/);
    const valid = githubContext({
        GITHUB_REPOSITORY: context.repository,
        GITHUB_SHA: commit,
        GH_TOKEN: context.token,
        GITHUB_REF: context.ref,
    });
    assert.deepEqual(valid, context);
    const result = await githubGet(context, 'commits/example/pulls', async (url, options) => {
        assert.equal(url, 'https://api.github.com/repos/fixture/engine/commits/example/pulls');
        assert.equal(options.headers.Authorization, 'Bearer fixture-token');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal);
        return { status: 200, ok: true, json: async () => [pull] };
    });
    assert.deepEqual(result, [pull]);
    await assert.rejects(
        githubGet(context, 'example', async () => ({ status: 403, ok: false })),
        /failed \(403\)/,
    );
    assert.equal(await githubGet(context, 'example', async () => ({ status: 404 })), null);
});

test('branch releases derive independent engine and player identities from resolved versions', () => {
    assert.deepEqual(releaseIdentity('engine', '2026.1.0'), {
        version: '2026.1.0',
        tag: 'v2026.1.0',
        prefix: 'local-engine/v2026.1.0',
    });
    assert.deepEqual(releaseIdentity('player', '0.1.0'), {
        version: '0.1.0',
        tag: 'player-v0.1.0',
        prefix: 'box-player-launcher/player-v0.1.0',
    });
    for (const version of ['release', '../unsafe', '0.3.0\ninjected=true', '01.0.0']) {
        assert.throws(() => releaseIdentity('engine', version));
    }
});

test('published version identity cannot be moved to a different commit', async () => {
    const selected = { ...context, ref: 'refs/heads/release/v0.3.0' };
    const identity = releaseIdentity('engine', '0.3.0');
    assert.deepEqual(await checkRelease(selected, identity, async () => null), identity);
    assert.deepEqual(
        await checkRelease(selected, identity, async () => ({
            object: { type: 'commit', sha: commit },
        })),
        identity,
    );
    await assert.rejects(
        checkRelease(selected, identity, async () => ({
            object: { type: 'commit', sha: 'b'.repeat(40) },
        })),
        /new versioned release branch/,
    );
    await assert.rejects(
        checkRelease(context, identity, async () => null),
        /v<version> branch/,
    );
    let requests = 0;
    assert.deepEqual(
        await checkRelease(selected, identity, async () => ({
            object:
                ++requests === 1
                    ? { type: 'tag', sha: 'c'.repeat(40) }
                    : { type: 'commit', sha: commit },
        })),
        identity,
    );
    assert.equal(requests, 2);
});
