'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-create-project-'));
const projectsRoot = path.join(root, 'projects');
const templateRoot = path.join(root, 'template');
fs.mkdirSync(path.join(templateRoot, 'blobs'), { recursive: true });
fs.writeFileSync(path.join(templateRoot, 'blobs', 'QmTemplate'), 'template', { mode: 0o644 });
fs.writeFileSync(path.join(templateRoot, 'runtime-blobs.json'), '{"hashes":[]}');

process.env.BOX_LOCAL_PROJECTS_PATH = projectsRoot;
process.env.BOX_LOCAL_TEMPLATE_DATA_PATH = templateRoot;
const manager = require('../src/project-manager');

try {
    const project = manager.createProject({ id: 'bind-mount-project', name: '绑定目录测试' });
    const blob = path.join(projectsRoot, project.id, 'source', 'blobs', 'QmTemplate');
    assert.equal(fs.readFileSync(blob, 'utf8'), 'template');
    assert.equal(fs.statSync(blob).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.dirname(blob)).mode & 0o777, 0o755);
    console.log('create project bind-mount regression passed');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
