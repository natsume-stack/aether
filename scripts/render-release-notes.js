'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildReleaseManifest } = require('./build-release-manifest');

function renderReleaseNotes(version, date) {
    const release = buildReleaseManifest(version, date);
    return [
        `# v${release.version}`,
        '',
        release.date,
        '',
        release.summary,
        '',
        ...release.sections.flatMap((section) => [
            `## ${section.title}`,
            '',
            ...section.items.map((item) => `- ${item}`),
            '',
        ]),
    ].join('\n');
}

if (require.main === module) {
    const [version, destination, date] = process.argv.slice(2);
    if (!destination || !date) {
        throw new Error(
            'Usage: node scripts/render-release-notes.js <version> <destination.md> <YYYY-MM-DD>',
        );
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, renderReleaseNotes(version, date));
}

module.exports = { renderReleaseNotes };
