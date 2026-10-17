'use strict';

const fs = require('node:fs');
const path = require('node:path');

const targets = [
    '@box/build-system',
    '@box/apis',
    '@box/env',
    '@box/player-policy',
    '@box/realtime-client',
    '@box/deployment-routing',
];

function orderDependencyBuilds(projects, selected = targets) {
    const byName = new Map(projects.map((project) => [project.name, project]));
    const visiting = new Set();
    const complete = new Set();
    const ordered = [];
    function visit(name) {
        if (complete.has(name)) {
            return;
        }
        if (visiting.has(name)) {
            throw new Error(`Circular test dependency: ${name}`);
        }
        const project = byName.get(name);
        if (!project) {
            throw new Error(`Unknown test dependency: ${name}`);
        }
        visiting.add(name);
        for (const dependency of project.dependencies.filter((name) => byName.has(name)).sort()) {
            visit(dependency);
        }
        visiting.delete(name);
        complete.add(name);
        if (project.build) {
            ordered.push(project);
        }
    }
    for (const name of selected) {
        visit(name);
    }
    return ordered;
}

function testDependencyBuildPlan(root) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'rush.json'), 'utf8'));
    const projects = config.projects.map((project) => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(root, project.projectFolder, 'package.json'), 'utf8'),
        );
        return {
            name: project.packageName,
            folder: project.projectFolder,
            build: Boolean(manifest.scripts?.build),
            dependencies: [
                ...new Set([
                    ...Object.keys(manifest.dependencies || {}),
                    ...Object.keys(manifest.devDependencies || {}),
                    ...Object.keys(manifest.optionalDependencies || {}),
                ]),
            ],
        };
    });
    return orderDependencyBuilds(projects);
}

module.exports = { orderDependencyBuilds, testDependencyBuildPlan };
