'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { orderDependencyBuilds } = require('./test-dependency-build');

/** Validate the main workspace only; vendored modules and nested examples are not Rush products. */
function workspaceProjects(root) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'rush.json'), 'utf8'));
    const versionsFile = path.join(root, 'common/config/rush/common-versions.json');
    const preferredVersions = fs.existsSync(versionsFile)
        ? JSON.parse(fs.readFileSync(versionsFile, 'utf8')).preferredVersions || {}
        : {};
    const names = new Set();
    const folders = new Set();
    const projects = config.projects.map(({ packageName, projectFolder }) => {
        assert.match(projectFolder, /^(apps|internals|packages|services|tools)\/[^/]+$/);
        assert.ok(!names.has(packageName), `Duplicate Rush package: ${packageName}`);
        assert.ok(!folders.has(projectFolder), `Duplicate Rush folder: ${projectFolder}`);
        names.add(packageName);
        folders.add(projectFolder);
        const manifest = JSON.parse(
            fs.readFileSync(path.join(root, projectFolder, 'package.json'), 'utf8'),
        );
        assert.equal(
            manifest.name,
            packageName,
            `Rush name differs from ${projectFolder}/package.json`,
        );
        // Peer ranges describe library compatibility, not the installed toolchain.
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            for (const [name, version] of Object.entries(manifest[section] || {})) {
                if (preferredVersions[name]) {
                    assert.equal(
                        version,
                        preferredVersions[name],
                        `${packageName} must pin ${name} to ${preferredVersions[name]} (${section})`,
                    );
                }
            }
        }
        return {
            name: packageName,
            folder: projectFolder,
            build: Boolean(manifest.scripts?.build),
            dependencies: [
                ...new Set(
                    Object.keys({
                        ...manifest.dependencies,
                        ...manifest.devDependencies,
                        ...manifest.optionalDependencies,
                    }),
                ),
            ],
            manifest,
        };
    });
    for (const parent of ['apps', 'internals', 'packages', 'services', 'tools']) {
        for (const entry of fs.readdirSync(path.join(root, parent), { withFileTypes: true })) {
            const folder = `${parent}/${entry.name}`;
            if (entry.isDirectory() && fs.existsSync(path.join(root, folder, 'package.json'))) {
                assert.ok(folders.has(folder), `Project is not registered in Rush: ${folder}`);
            }
        }
    }
    for (const project of projects) {
        for (const [name, version] of Object.entries({
            ...project.manifest.dependencies,
            ...project.manifest.devDependencies,
            ...project.manifest.optionalDependencies,
            ...project.manifest.peerDependencies,
        })) {
            if (name.startsWith('@box/') || version.startsWith('workspace:')) {
                assert.ok(
                    names.has(name),
                    `${project.name} references missing workspace package ${name}`,
                );
                assert.ok(
                    version.startsWith('workspace:'),
                    `${project.name} must link ${name} through workspace:`,
                );
            }
        }
    }
    orderDependencyBuilds(projects, [...names]);
    return projects;
}

/** Build compiled dependencies, not production application bundles, before starting source servers. */
function developmentBuildPlan(
    root,
    targets = [
        '@box/game',
        '@box/game-server',
        '@box/voxa',
        '@box/local-engine',
        '@box/player-admin',
        '@box/player-auth-portal',
    ],
) {
    return orderDependencyBuilds(workspaceProjects(root), targets).filter(
        (project) => !targets.includes(project.name),
    );
}

module.exports = { workspaceProjects, developmentBuildPlan };
