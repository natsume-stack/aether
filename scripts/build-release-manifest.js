'use strict';

const fs = require('node:fs');
const path = require('node:path');
const notes = require('../distribution/release-notes.json');
const targets = ['windows-amd64', 'windows-arm64', 'macos-arm64', 'linux-amd64', 'linux-arm64'];

function buildReleaseManifest(version, date) {
    version = String(version).replace(/^v/, '');
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-staging)?$/.test(version)) {
        throw new Error('Stable release version required');
    }
    const release = notes.find((note) => note.version === version.replace(/-staging$/, ''));
    if (!release) {
        throw new Error(`Missing release notes for ${version}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
        throw new Error('Invalid release date');
    }
    return { schemaVersion: 1, ...release, version, date };
}

if (require.main === module) {
    const [version, destination, date = new Date().toISOString().slice(0, 10)] =
        process.argv.slice(2);
    const manifest = buildReleaseManifest(version, date);
    for (const target of targets) {
        if (
            !fs.existsSync(
                path.join(
                    path.dirname(destination),
                    `BOX-Local-Engine-${manifest.version}-${target}.zip`,
                ),
            )
        ) {
            throw new Error(`Missing installer: ${target}`);
        }
    }
    fs.writeFileSync(destination, JSON.stringify(manifest, null, 2) + '\n');
}

module.exports = { buildReleaseManifest };
