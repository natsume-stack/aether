'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    markdownFiles,
    repositoryMarkdownFiles,
    assertLocalLinks,
} = require('./lib/documentation-links.cjs');
const { documentationDirectories, documentationFiles } = require('./lib/owned-code-config.cjs');

const root = path.resolve(__dirname, '..');
const docsRoot = path.join(root, 'docs');
const coreFiles = [
    path.join(root, 'README.md'),
    path.join(root, 'CONTRIBUTING.md'),
    ...markdownFiles(docsRoot),
];
const files = [
    ...new Set([
        ...coreFiles,
        ...repositoryMarkdownFiles(root),
        ...documentationFiles.map((file) => path.join(root, file)),
        ...documentationDirectories
            .filter((directory) => directory !== 'docs')
            .flatMap((directory) => markdownFiles(path.join(root, directory))),
    ]),
];

const index = fs.readFileSync(path.join(docsRoot, 'README.md'), 'utf8');
for (const file of markdownFiles(docsRoot)) {
    if (file === path.join(docsRoot, 'README.md')) {
        continue;
    }
    const reference = `./${path.relative(docsRoot, file).split(path.sep).join('/')}`;
    assert.ok(index.includes(reference), `docs/README.md does not index ${reference}`);
}

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const displayedVersion = /当前源码版本：`([^`]+)`/.exec(readme)?.[1];
if (displayedVersion !== undefined) {
    assert.equal(displayedVersion, version, 'README source version is outdated');
}
for (const required of ['MIT', 'npm run install:all', 'npm run verify', 'CONTRIBUTING.md']) {
    assert.ok(readme.includes(required), `README is missing ${required}`);
}
const contributors = fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8');
for (const required of [
    'git clone ',
    'git remote add upstream ',
    'git fetch upstream',
    'Pull Request',
]) {
    assert.ok(contributors.includes(required), `CONTRIBUTING.md is missing ${required}`);
}
const published = coreFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
for (const obsolete of ['先接受仓库邀请', '邀请制', 'pnpm install', 'pnpm --filter']) {
    assert.ok(
        !published.includes(obsolete),
        `documentation contains obsolete guidance: ${obsolete}`,
    );
}

assertLocalLinks(files, root)
    .then(() => console.log(`documentation checks passed: ${files.length} Markdown files`))
    .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
