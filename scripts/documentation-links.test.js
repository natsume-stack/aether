'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
    markdownFiles,
    repositoryMarkdownFiles,
    assertLocalLinks,
} = require('./lib/documentation-links.cjs');

test('README version is optional but an explicitly displayed version must be current', () => {
    const root = path.resolve(__dirname, '..');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const readme = fs
        .readFileSync(path.join(root, 'README.md'), 'utf8')
        .replace(/当前源码版本：`[^`]+`/g, '');
    for (const [displayed, success] of [
        [null, true],
        [version, true],
        ['0.0.0', false],
    ]) {
        const source = readme + (displayed === null ? '' : `\n当前源码版本：\`${displayed}\``);
        const script = `const fs = require('node:fs');
const original = fs.readFileSync;
fs.readFileSync = (file, ...args) => file === ${JSON.stringify(path.join(root, 'README.md'))} ? ${JSON.stringify(source)} : original(file, ...args);
require(${JSON.stringify(path.join(root, 'scripts/check-documentation.js'))});`;
        const result = spawnSync(process.execPath, ['-e', script], {
            cwd: root,
            encoding: 'utf8',
            timeout: 10_000,
        });
        assert.ifError(result.error);
        if (success) {
            assert.equal(result.status, 0, result.stderr);
        } else {
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /README source version is outdated/);
        }
    }
});

async function withDocument(source, action) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-document-links-'));
    try {
        const document = path.join(root, 'README.md');
        fs.writeFileSync(document, source);
        fs.writeFileSync(path.join(root, 'guide (current).md'), '# Guide\n');
        await action(document, root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('Markdown reference links and escaped path names resolve without parsing code examples', async () => {
    await withDocument(
        '[guide][current]\n\n[current]: <guide (current).md>\n\n```md\n[example](missing.md)\n```\n',
        (document, root) => assertLocalLinks([document], root),
    );
});

test('missing reference-link destinations fail documentation validation', async () => {
    await withDocument('[guide][current]\n\n[current]: missing.md\n', (document, root) =>
        assert.rejects(assertLocalLinks([document], root), /links to missing missing.md/),
    );
});

test('external URLs, local fragments and encoded file names do not look like missing files', async () => {
    await withDocument(
        '## Section\n\n[web](https://example.test/a_(b))\n[section](#section)\n[file](guide%20%28current%29.md#guide)\n',
        (document, root) => assertLocalLinks([document], root),
    );
});

test('real Markdown headings support inline code, Unicode and repeated-title anchors', async () => {
    await withDocument(
        '## Code & `Ops`\n\n## Code & Ops\n\n## 中文 标题\n\n[one](#code--ops)\n[two](#code--ops-1)\n[unicode](#%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98)\n',
        (document, root) => assertLocalLinks([document], root),
    );
});

test('missing same-page and cross-file anchors fail instead of passing as existing paths', async () => {
    for (const link of ['#removed-section', 'guide%20%28current%29.md#removed-section']) {
        await withDocument(`# Guide\n\n[removed](${link})\n`, (document, root) =>
            assert.rejects(assertLocalLinks([document], root), /links to missing anchor/),
        );
    }
    await withDocument('## `createThing()`\n\n[old](#creatething())\n', (document, root) =>
        assert.rejects(assertLocalLinks([document], root), /links to missing anchor/),
    );
});

test('explicit HTML IDs and named anchors count, while comments and data-id do not', async () => {
    await withDocument(
        '<a name="section_2.1"></a>\n<div id="detail"></div>\n\n[section](#section_2.1)\n[detail](#detail)\n',
        (document, root) => assertLocalLinks([document], root),
    );
    for (const html of ['<!-- <a id="ghost"></a> -->', '<div data-id="ghost"></div>']) {
        await withDocument(`${html}\n\n[ghost](#ghost)\n`, (document, root) =>
            assert.rejects(assertLocalLinks([document], root), /links to missing anchor/),
        );
    }
});

test('rendered HTML links and images are checked without reading commented or code examples', async () => {
    await withDocument(
        '<a href="guide%20%28current%29.md#guide">Guide</a>\n\n<!-- <img src="missing.png"> -->\n\n`<img src="missing.png">`\n',
        (document, root) => assertLocalLinks([document], root),
    );
    await withDocument('<img src="missing.png" alt="Missing">\n', (document, root) =>
        assert.rejects(assertLocalLinks([document], root), /links to missing missing.png/),
    );
});

test('repository documentation includes embedded package examples and skips deleted/ignored files', async () => {
    await withDocument('# Guide\n', (document, root) => {
        const git = (...args) => {
            const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        };
        git('init', '--quiet');
        fs.mkdirSync(path.join(root, 'packages/example'), { recursive: true });
        const embedded = path.join(root, 'packages/example/README.md');
        fs.writeFileSync(embedded, '# Embedded example\n');
        fs.writeFileSync(path.join(root, 'deleted.md'), '# Deleted\n');
        fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
        git('add', '.');
        fs.rmSync(path.join(root, 'deleted.md'));
        fs.mkdirSync(path.join(root, 'ignored'));
        fs.writeFileSync(path.join(root, 'ignored/private.md'), '[missing](missing.md)');
        assert.deepEqual(
            repositoryMarkdownFiles(root).sort(),
            [document, path.join(root, 'guide (current).md'), embedded].sort(),
        );
    });
});

test('documentation inventory excludes build products and private runtime data', async () => {
    await withDocument('# Guide\n', (document, root) => {
        for (const directory of [
            'node_modules',
            'dist-electron',
            'release-electron',
            'data',
            'projects',
        ]) {
            fs.mkdirSync(path.join(root, directory));
            fs.writeFileSync(path.join(root, directory, 'private.md'), '[missing](missing.md)');
        }
        assert.deepEqual(
            markdownFiles(root).sort(),
            [document, path.join(root, 'guide (current).md')].sort(),
        );
    });
});
