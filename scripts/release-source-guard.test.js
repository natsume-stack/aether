'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require(
    require.resolve('js-yaml', { paths: [path.join(__dirname, '../tools/repo-tooling')] }),
);

test('release workflows accept a clean source snapshot with private historical files and reject current private files', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-release-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Release Source Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    fs.mkdirSync(path.join(root, 'scripts'));
    for (const file of ['check-public-history.js', 'check-public-repository.js']) {
        fs.copyFileSync(path.join(__dirname, file), path.join(root, 'scripts', file));
    }
    fs.writeFileSync(path.join(root, 'README.md'), '# Release fixture\n');
    fs.mkdirSync(path.join(root, '.private'));
    fs.writeFileSync(path.join(root, '.private/old.json'), '{}\n');
    git('add', '.');
    git('commit', '-m', 'Add historical private fixture');
    git('rm', '.private/old.json');
    git('commit', '-m', 'Remove private file from release snapshot');

    const checks = [
        ['release.yml', 'validate-release'],
        ['player-launcher-release.yml', 'validate'],
        ['package-server.yml', 'validate'],
    ].map(([file, job]) => {
        const workflow = yaml.load(
            fs.readFileSync(path.join(__dirname, '../.github/workflows', file), 'utf8'),
        );
        const step = workflow.jobs[job].steps.find((item) =>
            /^node scripts\/check-public-(?:history|repository)\.js$/.test(item.run || ''),
        );
        assert.ok(step, `${file} must check release source`);
        return { file, args: step.run.split(/\s+/).slice(1) };
    });
    for (const check of checks) {
        const result = spawnSync(process.execPath, check.args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, `${check.file}: ${result.stderr}`);
        assert.match(result.stdout, /0 findings/);
    }

    fs.mkdirSync(path.join(root, '.private'), { recursive: true });
    fs.writeFileSync(path.join(root, '.private/current.json'), '{}\n');
    git('add', '.');
    git('commit', '-m', 'Add current private fixture');
    for (const check of checks) {
        const result = spawnSync(process.execPath, check.args, { cwd: root, encoding: 'utf8' });
        assert.notEqual(result.status, 0, `${check.file} must reject current private source`);
        assert.match(result.stderr, /\.private\/current\.json: private-or-runtime-path/);
    }
});
