'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { orderPackageManifest } = require('./lib/package-manifest-order.cjs');
const {
    directories,
    configurationFiles,
    documentationFiles,
    documentationDirectories,
    manifests,
} = require('./lib/owned-code-config.cjs');
const root = path.resolve(__dirname, '..');
const prettier = require(
    require.resolve('prettier', { paths: [path.join(root, 'tools/repo-tooling')] }),
);
const write = process.argv.includes('--write');

async function main() {
    const files = execFileSync(
        'git',
        [
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            ...directories,
            ...documentationDirectories,
        ],
        { cwd: root, encoding: 'utf8' },
    )
        .split('\0')
        .filter(
            (file) =>
                file.endsWith('.md') ||
                (/\.(?:js|cjs|mjs|ts|tsx|mts|cts|css|less)$/.test(file) &&
                    directories.some((directory) => file.startsWith(`${directory}/`))),
        )
        .filter((file) => fs.existsSync(path.join(root, file)));
    let changed = 0;
    const entries = [
        ...new Set([...files, ...configurationFiles, ...documentationFiles, ...manifests]),
    ];
    for (const file of entries) {
        const absolute = path.join(root, file);
        const source = fs.readFileSync(absolute, 'utf8');
        const input = file.endsWith('package.json')
            ? JSON.stringify(orderPackageManifest(JSON.parse(source)))
            : source;
        const formatted = await prettier.format(input, {
            ...(await prettier.resolveConfig(absolute)),
            filepath: absolute,
        });
        if (source === formatted) {
            continue;
        }
        changed += 1;
        if (write) {
            fs.writeFileSync(absolute, formatted);
        } else {
            console.error(`Formatting required: ${file}`);
        }
    }
    console.log(
        `Owned formatting: ${entries.length} files, ${changed} ${write ? 'updated' : 'differences'}`,
    );
    if (!write && changed) {
        process.exitCode = 1;
    }
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
