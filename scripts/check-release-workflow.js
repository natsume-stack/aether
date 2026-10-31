'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const yaml = require(
    require.resolve('js-yaml', { paths: [path.join(root, 'tools/repo-tooling')] }),
);
const release = yaml.load(workflow);
assert.deepEqual(release.on.push, { branches: ['staging', 'release/v*'] });
assert.ok(Object.hasOwn(release.on, 'workflow_dispatch'));
assert.equal(Object.hasOwn(release.on, 'create'), false);
const creationRouter = yaml.load(
    fs.readFileSync(path.join(root, '.github/workflows/release-branch-created.yml'), 'utf8'),
);
assert.ok(Object.hasOwn(creationRouter.on, 'create'));
assert.equal(creationRouter.permissions.actions, 'write');
assert.equal(release.jobs['merge-gate'], undefined);
assert.equal(release.jobs['validate-release'].needs, undefined);
assert.match(release.jobs['validate-release'].if, /refs\/heads\/release\/v/);
assert.ok(
    release.jobs['validate-release'].steps.some((step) =>
        step.run?.includes('node scripts/github-build-gate.js release engine'),
    ),
);
for (const job of ['images', 'desktop', 'headless-server', 'publish']) {
    assert.equal(
        release.jobs[job].env.BOX_RELEASE_TAG,
        '${{ needs.validate-release.outputs.tag }}',
    );
    assert.equal(
        release.jobs[job].env.OSS_BUILD_PREFIX,
        '${{ needs.validate-release.outputs.prefix }}',
    );
}
const publication = release.jobs.publish.steps.find(
    (step) => step.uses === 'softprops/action-gh-release@v3',
);
assert.equal(publication.with.tag_name, '${{ env.BOX_RELEASE_TAG }}');
assert.equal(publication.with.target_commitish, '${{ github.sha }}');
const installerBuilder = fs.readFileSync(
    path.join(root, 'scripts/build-desktop-offline-installer.js'),
    'utf8',
);
const serverPackageBuilder = fs.readFileSync(
    path.join(root, 'scripts/build-headless-server-package.js'),
    'utf8',
);
const headlessVerifier = fs.readFileSync(
    path.join(root, 'scripts/verify-headless-server-package.js'),
    'utf8',
);
const { headlessCompose } = require('./build-headless-server-package');

for (const target of [
    'windows-amd64',
    'windows-arm64',
    'macos-arm64',
    'linux-amd64',
    'linux-arm64',
]) {
    assert.match(workflow, new RegExp(`(?:targets|target).*${target}`));
}
assert.doesNotMatch(workflow, /target:\s*macos-amd64/);

assert.match(
    workflow,
    /for service in player-service player-auth-portal server-manager creator play voxa/,
);
const imageBuildLoop = workflow.match(
    /for service in player-service player-auth-portal server-manager creator play voxa; do\n([\s\S]*?)^\s*done/m,
)?.[1];
assert.ok(imageBuildLoop, 'release workflow image build loop is missing');
assert.match(
    imageBuildLoop,
    /docker builder prune --all --force/,
    'BuildKit cache must be pruned between image builds to fit GitHub runner disk limits',
);
assert.match(workflow, /architecture: amd64\s+runner: ubuntu-24\.04/);
assert.match(workflow, /architecture: arm64\s+runner: ubuntu-24\.04-arm/);
assert.match(workflow, /^ {2}validate-release:/m);
assert.equal(release.jobs.images.needs, 'validate-release');
assert.match(workflow, /sync-root-version\.js --check/);
assert.match(release['run-name'], /github\.ref_name/);
assert.doesNotMatch(workflow, /docker\/setup-qemu-action/);
assert.match(
    workflow,
    /box-local-engine-images-\$\{\{ env\.BOX_RELEASE_TAG \}\}-linux-\$\{\{ matrix\.architecture \}\}\.tar\.gz/,
);
assert.match(workflow, /docker builder prune --all --force/);
assert.match(workflow, /export BOX_BUILD_VERSION="\$\{\{ env\.BOX_RELEASE_TAG \}\}"/);
assert.match(workflow, /export BOX_BUILD_COMMIT="\$\{\{ github\.sha \}\}"/);
assert.match(
    workflow,
    /export BOX_BUILD_DATE="\$\(TZ=Asia\/Shanghai date \+'%Y-%m-%dT%H:%M:%S%:z'\)"/,
);
assert.match(workflow, /export BOX_BUILD_SOURCE="github-actions"/);
assert.match(workflow, /test -f "\$archive"/);
assert.match(workflow, /node-version-file: \.node-version/);
assert.match(workflow, /install-run-rush\.js install/);
assert.match(workflow, /install-run-rush\.js package-desktop/);
assert.doesNotMatch(workflow, /pnpm (?:install|package:desktop)/);
assert.match(installerBuilder, /validateCatalog/);
assert.match(
    installerBuilder,
    /const imageTag = local \? localImageTag\(imageManifest\) : imageManifest\.imageTag/,
);
assert.deepEqual(release.jobs['headless-server'].needs, ['images', 'validate-release']);
assert.match(workflow, /node scripts\/build-headless-server-package\.js/);
assert.deepEqual(release.jobs.publish.needs, ['desktop', 'headless-server', 'validate-release']);
assert.match(
    workflow,
    /files:\s*\|[\s\S]*release-files\/BOX-Local-Engine-\*\.zip[\s\S]*release-files\/BOX3-Engine-Server-\*\.zip/,
);
assert.doesNotMatch(workflow, /files:\s*\|[\s\S]*release-files\/\*\.tar\.gz/);
assert.match(serverPackageBuilder, /BOX3-Engine-Server-/);
assert.match(serverPackageBuilder, /function headlessCompose/);
assert.match(serverPackageBuilder, /player-auth-portal:/);
assert.match(serverPackageBuilder, /server-manager:/);
assert.match(serverPackageBuilder, /play-storage-init:/);
assert.match(serverPackageBuilder, /templateRoot, '\.env\.example'/);
assert.match(serverPackageBuilder, /BOX3-IMAGE-CATALOG\.json/);
assert.match(serverPackageBuilder, /BOX3-MANAGER-IMAGE\.json/);
assert.match(headlessVerifier, /BOX3-IMAGE-CATALOG\.json/);
assert.match(headlessVerifier, /server package must not bundle Docker image archives/);
assert.match(workflow, /verify-headless-server-package\.js/);
assert.match(workflow, /Download Server Manager image catalog from Aliyun OSS/);
assert.match(workflow, /--catalog/);

const headlessComposeSource = headlessCompose();
for (const requiredService of [
    'managed-postgres',
    'managed-redis',
    'player-service',
    'player-auth-portal',
    'server-manager',
    'creator',
    'creator-storage-init',
    'play-storage-init',
    'play',
    'voxa',
    'voxa-storage-init',
]) {
    assert.match(headlessComposeSource, new RegExp(`^  ${requiredService}:`, 'm'));
}
for (const forbiddenService of ['postgres', 'redis', 'migrator']) {
    assert.doesNotMatch(headlessComposeSource, new RegExp(`^  ${forbiddenService}:`, 'm'));
}
assert.match(headlessComposeSource, /BOX_CREATOR_PUBLIC_URL/);
assert.match(headlessComposeSource, /AUTH_DEMO_CREATOR_URL/);
assert.match(headlessComposeSource, /^ {2}box-managed-postgres-data:\s*$/m);
assert.match(headlessComposeSource, /^ {2}box-managed-redis-data:\s*$/m);
assert.match(headlessComposeSource, /^ {2}box-play-runtime-cache:\s*$/m);
assert.doesNotMatch(headlessComposeSource, /box-play-storage/);

// Build outputs are exchanged through Aliyun OSS rather than GitHub Actions
// artifacts. Keep this contract in sync with release.yml so the workflow check
// catches accidental regressions to the quota-limited artifact service.
for (const step of [
    'Upload images to Aliyun OSS',
    'Download desktop image catalog from Aliyun OSS',
    'Download Server Manager image catalog from Aliyun OSS',
    'Upload desktop installer to Aliyun OSS',
    'Upload server package to Aliyun OSS',
    'Download release packages from Aliyun OSS',
]) {
    assert.match(workflow, new RegExp(step));
}
const desktopJob = workflow.slice(
    workflow.indexOf('  desktop:'),
    workflow.indexOf('  headless-server:'),
);
assert.match(desktopJob, /box-local-engine-images-[^\n]*\.json/);
assert.doesNotMatch(desktopJob, /\.tar(?:\.gz)?(?:["'\s]|$)/);
assert.match(desktopJob, /name: Build lightweight desktop launcher/);
const headlessJob = workflow.slice(
    workflow.indexOf('  headless-server:'),
    workflow.indexOf('  publish:'),
);
assert.match(headlessJob, /box-local-engine-images-[^\n]*\.json/);
assert.doesNotMatch(headlessJob, /\.tar\.gz/);
assert.match(workflow, /ossutil\s+config/);
assert.match(workflow, /OSS_BUCKET:\s*\$\{\{\s*secrets\.ALIYUN_OSS_BUCKET\s*\}\}/);
assert.match(workflow, /OSS_ENDPOINT:\s*\$\{\{\s*secrets\.ALIYUN_OSS_ENDPOINT\s*\}\}/);
assert.match(workflow, /OSS_ACCESS_KEY_ID:\s*\$\{\{\s*secrets\.ALIYUN_OSS_ACCESS_KEY_ID\s*\}\}/);
assert.match(
    workflow,
    /OSS_ACCESS_KEY_SECRET:\s*\$\{\{\s*secrets\.ALIYUN_OSS_ACCESS_KEY_SECRET\s*\}\}/,
);
assert.equal(
    release.jobs.publish.env.OSS_SERVER_RELEASE_PREFIX,
    '${{ needs.validate-release.outputs.releasePrefix }}',
);
assert.equal(publication.if, "startsWith(github.ref, 'refs/heads/release/v')");
assert.match(workflow, /ALIYUN_OSS_BUCKET must contain only the bucket name/);
assert.match(workflow, /ALIYUN_OSS_ENDPOINT must be an OSS endpoint hostname/);
assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact@/);
assert.doesNotMatch(
    workflow,
    /(?:access[_-]?key[_-]?id|access[_-]?key[_-]?secret)\s*:\s*['"][^$]/i,
);
assert.match(workflow, /release-files\/BOX-Local-Engine-\*\.zip/);
assert.match(workflow, /release-files\/BOX3-Engine-Server-\*\.zip/);
assert.match(workflow, /render-bootstrap-installer\.js release-files\/install\.sh/);
assert.match(workflow, /release-files\/install\.sh/);
assert.match(workflow, /for architecture in amd64 arm64/);
assert.match(
    workflow,
    /for target in windows-amd64 windows-arm64 macos-arm64 linux-amd64 linux-arm64/,
);
assert.doesNotMatch(
    workflow,
    /ossutil cp "oss:\/\/\$OSS_BUCKET\/\$OSS_BUILD_PREFIX\/" \.\/release-files\/ --recursive/,
);
assert.match(workflow, /oss:\/\/\$OSS_BUCKET\/\$OSS_SERVER_RELEASE_PREFIX\/" --update/);
assert.match(workflow, /oss:\/\/\$OSS_BUCKET\/\$OSS_SERVER_RELEASE_PREFIX\/install\.sh/);
assert.match(workflow, /oss:\/\/\$OSS_BUCKET\/\$OSS_SERVER_RELEASE_PREFIX\/latest\.txt/);
assert.match(workflow, /Publish latest\.txt last/);
assert.doesNotMatch(workflow, /release-files\/\*\.tar\.gz/);
assert.match(workflow, /BOX_BUILD_COMMIT: \$\{\{ github\.sha \}\}/);
assert.match(workflow, /BOX_BUILD_SOURCE: github-actions/);
assert.match(
    workflow,
    /- name: Install desktop dependencies\n\s+if: steps\.desktop-cache\.outputs\.cache-hit != 'true'\n\s+run: node common\/scripts\/install-run-rush\.js install --to '@box\/deployment-manager'/,
    'desktop runners must not install unrelated native Game Server dependencies',
);
assert.ok(
    workflow.indexOf('name: Check cached desktop installer in Aliyun OSS') <
        workflow.indexOf('name: Install desktop dependencies'),
    'desktop dependency installation must be skipped when OSS already has the installer',
);
assert.ok(
    workflow.indexOf('name: Publish GitHub Release') <
        workflow.indexOf('name: Publish channel packages and latest pointers to OSS'),
    'GitHub Release must exist before the CDN latest pointer is updated',
);
for (const requiredTemplateFile of [
    'README.md',
    'install.sh',
    'status.sh',
    'logs.sh',
    'stop.sh',
    'verify.sh',
]) {
    assert.ok(
        fs.existsSync(path.join(root, 'distribution/server', requiredTemplateFile)),
        `missing headless server template file: ${requiredTemplateFile}`,
    );
}

const bootstrapInstaller = fs.readFileSync(
    path.join(root, 'distribution/server/bootstrap.sh'),
    'utf8',
);
assert.match(bootstrapInstaller, /uname -m/);
assert.doesNotMatch(bootstrapInstaller, /ifishcool\/box-local-engine/);
assert.match(bootstrapInstaller, /BOX3_RELEASE_CDN_URL/);
assert.match(bootstrapInstaller, /https:\/\/assets\.box3\.fun\/local-engine/);
assert.match(bootstrapInstaller, /latest\.txt/);
assert.match(bootstrapInstaller, /无法从 CDN 下载服务器发行包/);
assert.doesNotMatch(bootstrapInstaller, /REPOSITORY_URL|resolve_github_version|github_package_url/);
assert.match(bootstrapInstaller, /BOX3-Engine-Server-\$version-linux-\$architecture/);
assert.doesNotMatch(bootstrapInstaller, /get\.docker\.com|raw\.githubusercontent\.com/);
assert.match(bootstrapInstaller, /mirrors\.aliyun\.com\/docker-ce\/linux/);
assert.doesNotMatch(
    bootstrapInstaller,
    /install_alibaba_cloud_linux_docker|install_ubuntu_docker_from_aliyun_mirror|install_compose_plugin_binary/,
);
assert.match(bootstrapInstaller, /"\$package_directory\/verify\.sh"/);
assert.match(bootstrapInstaller, /\.\/install\.sh/);
assert.doesNotMatch(bootstrapInstaller, /rm -rf "?\/opt/);

console.log('release workflow image-tag contract check passed');
