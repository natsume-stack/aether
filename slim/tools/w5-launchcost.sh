#!/bin/bash
# W5 measurement: how much per-map pre-flight work the recursive supervisor
# currently absorbs, and what a "direct game-server spawn" would move onto the
# front-door event loop. Live project data is mounted READ-ONLY and copied into
# the throwaway container first; nothing under /root/box3 is written.
set -u
P=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine/projects
IMG=box-local-engine-creator:v2026.1.4-linux-amd64

cat > /tmp/w5launch-cost.js <<'EOF'
const fs = require('fs');
const path = require('path');
const pm = require('/app/apps/local-engine/src/project-manager.js');
const root = process.env.BOX_LOCAL_PROJECTS_PATH;
const ids = fs
    .readdirSync(root)
    .filter((entry) => fs.existsSync(path.join(root, entry, 'project.json')));
const time = (label, fn) => {
    const started = process.hrtime.bigint();
    let out;
    let err = '';
    try {
        out = fn();
    } catch (error) {
        err = error.message;
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`    ${label.padEnd(34)} ${ms.toFixed(1).padStart(9)} ms ${err ? `ERR ${err}` : ''}`);
    return { ms, out, err };
};
console.log(`projects root: ${root}`);
for (const id of ids) {
    const sourceRoot = path.join(root, id, 'source');
    const blobCount = fs.existsSync(path.join(sourceRoot, 'blobs'))
        ? fs.readdirSync(path.join(sourceRoot, 'blobs')).length
        : 0;
    const size = pm.getProject(id).mapSize || [];
    console.log(`\n  project ${id}  blobs=${blobCount}  mapSize=${size.join('x')}`);
    time('mapGroupManager.materialize', () => pm.materializeMapGroupState(id));
    time('validateProjectSource', () => pm.validateProjectSource(sourceRoot));
    const cold = time('createProjectSnapshot (cold tar)', () => pm.createProjectSnapshot(id, 'launch'));
    time('createProjectSnapshot (warm)', () => pm.createProjectSnapshot(id, 'launch'));
    const target = time('getLaunchTarget (warm pool)', () => pm.getLaunchTarget({ project: id, release: '' }));
    const voxels = (target.out?.initialMapSize || []).reduce((a, b) => a * Number(b), 1);
    const tier = voxels > 64 * 1024 * 1024 ? 2048 : voxels > 16 * 1024 * 1024 ? 1024 : 512;
    console.log(
        `    -> cold snapshot=${cold.out?.created ? 'tar written' : 'skipped'} ` +
            `voxels=${voxels} isolate tier=${tier}MB ` +
            `snapshotKB=${cold.out?.archivePath ? Math.round(fs.statSync(cold.out.archivePath).size / 1024) : 0}`
    );
}
EOF
docker run --rm --user root --memory=6g --cpus=4 -v "$P:/from:ro" -v /tmp/w5launch-cost.js:/cost.js:ro "$IMG" \
  sh -c 'mkdir -p /tmp/work/projects && cp -r /from/. /tmp/work/projects/ && chmod -R u+rwX /tmp/work && du -sb /tmp/work/projects && BOX_LOCAL_PROJECTS_PATH=/tmp/work/projects node /cost.js'
echo "[done]"
