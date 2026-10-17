'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { services, sourceFingerprint } = require('./server-image-plan');

const repoRoot = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/package-server.yml'),
    'utf8',
);
const block = workflow
    .split('      - name: Build Web manager image and reuse published application images\n')[1]
    .split('        run: |\n')[1]
    .split('      - name:')[0]
    .replace(/^ {10}/gm, '');

for (const scenario of ['build', 'reuse', 'missing catalog', 'missing application archive']) {
    test(`server workflow ${scenario}: only the Web manager may build`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-manager-workflow-'));
        try {
            for (const file of [
                'scripts/server-image-plan.js',
                'scripts/build-image-downloads.js',
                '.env.docker.example',
                'package.json',
            ]) {
                fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
                fs.copyFileSync(path.join(repoRoot, file), path.join(root, file));
            }
            execFileSync('git', ['init', '-q'], { cwd: root });
            execFileSync('git', ['add', '.'], { cwd: root });
            const architecture = 'arm64';
            const version = require('../package.json').version;
            const imageTag = `v${version}-linux-${architecture}`;
            const digest = 'a'.repeat(64);
            const catalog = {
                formatVersion: 2,
                platform: `linux/${architecture}`,
                imageTag,
                images: services.map((service) => ({
                    formatVersion: 1,
                    image: `box-local-engine-${service}`,
                    imageId: `sha256:${digest}`,
                    imageIds: [`sha256:${digest}`],
                    imageTag,
                    platform: `linux/${architecture}`,
                    sha256: digest,
                    size: 100,
                    archive: `box-local-engine-image-${service}-${architecture}-${digest}.tar.gz`,
                })),
            };
            const manager = catalog.images.find(
                (image) => image.image === 'box-local-engine-server-manager',
            );
            if (scenario === 'reuse') {
                manager.sourceFingerprint = sourceFingerprint(root, 'server-manager');
            }
            const catalogPath = path.join(
                root,
                `apps/local-engine/dist/images/box-local-engine-images-${imageTag}.json`,
            );
            fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
            if (scenario !== 'missing catalog') {
                fs.writeFileSync(catalogPath, JSON.stringify(catalog));
            }
            fs.writeFileSync(path.join(root, 'manager-fixture.json'), JSON.stringify(manager));
            const bin = path.join(root, 'bin');
            fs.mkdirSync(bin);
            // No network or Docker daemon is involved. Execute the actual workflow
            // shell with recording substitutes for external build/publication tools.
            fs.writeFileSync(
                path.join(bin, 'docker'),
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_DOCKER_LOG"\n',
                { mode: 0o755 },
            );
            fs.writeFileSync(
                path.join(bin, 'ossutil'),
                `#!/bin/sh
if [ "$1" = stat ] && [ "$TEST_MISSING_ARCHIVE" = yes ]; then
  echo NoSuchKey >&2
  exit 1
fi
`,
                { mode: 0o755 },
            );
            fs.writeFileSync(
                path.join(bin, 'python3'),
                `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const image = JSON.parse(fs.readFileSync('manager-fixture.json', 'utf8'));
const destination = process.argv[5];
fs.writeFileSync(destination, JSON.stringify({ images: [image] }));
fs.writeFileSync(path.join(path.dirname(destination), image.archive), 'fixture');
`,
                { mode: 0o755 },
            );
            const log = path.join(root, 'docker.log');
            const result = spawnSync(
                'bash',
                [
                    '-eo',
                    'pipefail',
                    '-c',
                    block
                        .replaceAll('${{ inputs.version }}', version)
                        .replaceAll('${{ matrix.architecture }}', architecture),
                ],
                {
                    cwd: root,
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
                        BOX_IMAGE_TAG: imageTag,
                        OSS_BUCKET: 'test-bucket',
                        OSS_BUILD_PREFIX: `local-engine/v${version}`,
                        OSS_SERVER_RELEASE_PREFIX: 'local-engine',
                        TEST_DOCKER_LOG: log,
                        TEST_MISSING_ARCHIVE:
                            scenario === 'missing application archive' ? 'yes' : 'no',
                    },
                },
            );
            const dockerCalls = fs.existsSync(log)
                ? fs.readFileSync(log, 'utf8').trim().split('\n')
                : [];
            if (scenario.startsWith('missing')) {
                assert.notEqual(result.status, 0);
                assert.match(result.stderr, /Run the release workflow/);
                assert.deepEqual(dockerCalls, []);
            } else {
                assert.equal(result.status, 0, result.stderr);
                assert.deepEqual(
                    dockerCalls.filter((call) => call.startsWith('compose build')),
                    scenario === 'build' ? ['compose build server-manager'] : [],
                );
                const merged = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
                assert.deepEqual(
                    merged.images.filter((image) => image.image !== manager.image),
                    catalog.images.filter((image) => image.image !== manager.image),
                );
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}
