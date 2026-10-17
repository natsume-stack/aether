'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkPublicHistory } = require('./check-public-history');

function repository(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-public-history-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) =>
        execFileSync('git', args, {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'History Fixture');
    git('config', 'user.email', 'history-fixture@example.invalid');
    const write = (file, content) => {
        const absolute = path.join(root, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
    };
    const commit = (message) => {
        git('add', '--all');
        git('commit', '--message', message);
    };
    return { root, git, write, commit };
}

test('a clean repository with public heads and tags passes', (t) => {
    const f = repository(t);
    f.write('README.md', '# Public history fixture\n');
    f.commit('Add public fixture');
    f.git('tag', 'v1');
    const result = checkPublicHistory(f.root);
    assert.equal(result.scanned, 1);
    assert.deepEqual(result.problems, []);
});

test('a normal clean clone with remote-tracking branches passes', (t) => {
    const f = repository(t);
    f.write('README.md', '# Public history fixture\n');
    f.commit('Add public fixture');
    const clone = path.join(f.root, 'normal-clone');
    f.git('clone', '--no-local', f.root, clone);
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)'], {
        cwd: clone,
        encoding: 'utf8',
    });
    assert.match(refs, /refs\/remotes\/origin\/main/);
    assert.deepEqual(checkPublicHistory(clone).problems, []);
});

test('a shallow clone cannot claim that deleted private history is clean', (t) => {
    const f = repository(t);
    f.write('README.md', '# Public history fixture\n');
    f.write('.private/old.json', '{}\n');
    f.commit('Add private historical fixture');
    f.git('rm', '.private/old.json');
    f.commit('Delete private fixture');
    const clone = path.join(f.root, 'shallow-clone');
    f.git('clone', '--no-local', '--depth', '1', f.root, clone);
    assert.throws(() => checkPublicHistory(clone), /require a complete clone/);
});

test('ordinary remote-tracking references do not hide their private reachable history', (t) => {
    const f = repository(t);
    f.write('README.md', '# Public history fixture\n');
    f.commit('Add public fixture');
    const clean = f.git('rev-parse', 'HEAD').trim();
    f.write('.private/remote-only.json', '{}\n');
    f.commit('Add private remote fixture');
    f.git('update-ref', 'refs/remotes/origin/retired', 'HEAD');
    f.git('reset', '--hard', clean);
    assert.ok(
        checkPublicHistory(f.root).problems.some((problem) =>
            problem.startsWith('.private/remote-only.json: private-or-runtime-path'),
        ),
    );
});

test('deleting a private key from HEAD does not remove its history finding', (t) => {
    const f = repository(t);
    const { privateKey } = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    f.write('README.md', '# Public history fixture\n');
    f.write('key.pem', privateKey);
    f.commit('Add temporary key fixture');
    f.git('rm', 'key.pem');
    f.commit('Delete key fixture');
    const result = checkPublicHistory(f.root);
    assert.ok(result.problems.some((problem) => problem.includes('private-key-material')));
    assert.ok(result.problems.every((problem) => !problem.includes(privateKey.trim())));
});

test('a non-public reference is rejected even when its commit is otherwise clean', (t) => {
    const f = repository(t);
    f.write('README.md', '# Public history fixture\n');
    f.commit('Add public fixture');
    f.git('update-ref', 'refs/codex-internal/context', 'HEAD');
    assert.ok(
        checkPublicHistory(f.root).problems.includes(
            'refs/codex-internal/context: non-public-reference',
        ),
    );
});

test('a tree-valued reference is rejected even in an ordinary tag namespace', (t) => {
    const f = repository(t);
    f.write('README.md', '# Public history fixture\n');
    f.commit('Add public fixture');
    f.git('update-ref', 'refs/tags/tree-fixture', 'HEAD^{tree}');
    assert.ok(
        checkPublicHistory(f.root).problems.includes(
            'refs/tags/tree-fixture: non-public-reference',
        ),
    );
});

test('renaming unchanged project-state blobs preserves their old resource role', (t) => {
    const f = repository(t);
    const original = 'apps/local-engine/data/blobs/QmFixture';
    f.write(original, JSON.stringify({ owner: 'fixture-owner', users: ['fixture-player'] }));
    f.commit('Add project-state fixture');
    f.git('mv', original, 'state.json');
    f.commit('Rename unchanged fixture');
    assert.ok(
        checkPublicHistory(f.root).problems.some((problem) =>
            problem.startsWith(`${original}: embedded-project-or-user-state`),
        ),
    );
});

test('a deleted or renamed private path is rejected even when its blob is reused publicly', (t) => {
    const f = repository(t);
    const original = '.private/fixture with spaces.json';
    f.write(original, '{}\n');
    f.commit('Add private-path fixture');
    f.git('mv', original, 'public-fixture.json');
    f.commit('Rename unchanged private-path fixture');
    assert.ok(
        checkPublicHistory(f.root).problems.some((problem) =>
            problem.startsWith(`${original}: private-or-runtime-path`),
        ),
    );
});

test('a path added only by a merge is inspected even when its blob already has a public alias', (t) => {
    const f = repository(t);
    const state = JSON.stringify({ owner: 'fixture-owner', users: ['fixture-player'] });
    f.write('aaa-public/state.json', state);
    f.commit('Add public alias fixture');
    f.git('switch', '--create', 'side');
    f.write('side.txt', 'side fixture\n');
    f.commit('Add side fixture');
    f.git('switch', 'main');
    f.write('main.txt', 'main fixture\n');
    f.commit('Add main fixture');
    f.git('merge', '--no-ff', '--no-commit', 'side');
    const original = 'apps/local-engine/data/blobs/QmMergeFixture';
    f.write(original, state);
    f.commit('Add resource alias only during merge');
    assert.ok(
        checkPublicHistory(f.root).problems.some((problem) =>
            problem.startsWith(`${original}: embedded-project-or-user-state`),
        ),
    );
});
