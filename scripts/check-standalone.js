'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];
const gameNextConfig = fs.readFileSync(path.join(root, 'apps/game/next.config.js'), 'utf8');

function fail(message) {
    failures.push(message);
}

function readRequired(file, label = file) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) {
        fail(`missing ${label}: ${file}`);
        return '';
    }
    return fs.readFileSync(filePath, 'utf8');
}

// This repository is checked out with CRLF endings on Windows and LF endings on
// Linux, so a line-based assertion must ignore the carriage return and reach the
// same verdict under both. Regex-based assertions already tolerate CRLF because
// JS `$` matches before `\r`; only explicit line splitting needs this helper.
function splitLines(text) {
    return text.split(/\r?\n/);
}

function requirePattern(source, file, label, pattern) {
    if (source && !pattern.test(source)) {
        fail(`${file}: missing ${label}`);
    }
}

function forbidPattern(source, file, label, pattern) {
    if (source && pattern.test(source)) {
        fail(`${file}: contains ${label}`);
    }
}

function requireScript(manifest, manifestFile, name, expected) {
    if (manifest.scripts?.[name] !== expected) {
        fail(`${manifestFile}: script ${name} must be ${JSON.stringify(expected)}`);
    }
}

function collectFiles(directory, predicate) {
    if (!fs.existsSync(directory)) {
        return [];
    }
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(target, predicate));
        } else if (predicate(target)) {
            files.push(target);
        }
    }
    return files;
}

function getDockerStage(source, name) {
    const header = new RegExp(`^FROM\\s+[^\\n]+\\s+AS\\s+${name}\\s*$`, 'mi');
    const match = header.exec(source);
    if (!match) {
        return '';
    }
    const remainder = source.slice(match.index + match[0].length);
    const nextStage = /^FROM\s+[^\n]+(?:\s+AS\s+[^\s]+)?\s*$/im.exec(remainder);
    return nextStage ? remainder.slice(0, nextStage.index) : remainder;
}

function getComposeService(source, name) {
    const header = new RegExp(`^ {2}${name}:\\s*$`, 'm');
    const match = header.exec(source);
    if (!match) {
        return '';
    }
    const remainder = source.slice(match.index + match[0].length);
    const nextSection = /^(?: {2}[A-Za-z0-9_-]+:|\S[^\n]*:)\s*$/m.exec(remainder);
    return nextSection ? remainder.slice(0, nextSection.index) : remainder;
}

const requiredFiles = [
    '.dockerignore',
    '.env.docker.example',
    'docker-compose.yml',
    'docs/README.md',
    'docs/developer-guide.md',
    'apps/local-engine/Dockerfile',
    'apps/local-engine/config/local.config.json',
    'apps/local-engine/src/build.js',
    'apps/local-engine/src/asset-distribution.js',
    'apps/local-engine/src/launcher.js',
    'apps/local-engine/src/play-library.js',
    'apps/local-engine/src/play-image.js',
    'apps/local-engine/src/prune-player-build.js',
    'apps/local-engine/src/runtime-data-permissions.js',
    'apps/local-engine/src/runtime-readiness.js',
    'apps/local-engine/src/runtime-storage-namespace.js',
    'apps/local-engine/src/teleport-room-manager.js',
    'apps/server-manager/Dockerfile',
    'apps/server-manager-rust/Cargo.toml',
    'apps/server-manager-rust/src/main.rs',
    'apps/local-engine/src/stage-runtime-data.js',
    'services/game-server/scripts/dev-launch.js',
    'services/game-server/scripts/check-local-derived-content.ts',
    'services/game-server/src/assets/block_info.ts',
    'services/game-server/src/content/local-derived-content.ts',
    'services/game-server/src/player/default-avatar.json',
    'services/game-server/src/player/default-avatar-skin.ts',
];

for (const file of requiredFiles) {
    readRequired(file);
}

// Keep retired single-map and unauthenticated-player knobs out of every
// server-owner-facing configuration surface. Project names now come from the
// project manifest, and Creator/Play identities come from Player Service.
const publicConfigurationFiles = [
    '.env.docker.example',
    'docker-compose.yml',
    'distribution/play/.env.example',
    'apps/local-engine/src/project-manager.js',
    'docs/developer-guide.md',
];
for (const file of publicConfigurationFiles) {
    const source = readRequired(file);
    for (const retiredName of [
        'BOX_MIGRATOR_CREATERA_API_URL',
        'BOX_LOCAL_PLAYER_NAME',
        'BOX_LOCAL_PLAYER_ID',
    ]) {
        forbidPattern(
            source,
            file,
            `retired environment parameter ${retiredName}`,
            new RegExp(`\\b${retiredName}\\b`),
        );
    }
}
forbidPattern(
    readRequired('.env.docker.example'),
    '.env.docker.example',
    'retired single-map BOX_WORLD_NAME parameter',
    /^BOX_WORLD_NAME=/m,
);
forbidPattern(
    readRequired('docs/developer-guide.md'),
    'docs/developer-guide.md',
    'retired single-map BOX_WORLD_NAME parameter',
    /^BOX_WORLD_NAME=/m,
);

// Local deployments must never inherit the online service's 22:00–08:00
// anti-addiction gate. Keep both the page-level redirect and the runtime
// disconnect path out of the distributable sources.
for (const [file, patterns] of Object.entries({
    'apps/game/pages/p/[gameName]/index.tsx': [
        /isWithinPlayTime/,
        /TimeRestriction/,
        /time-restriction/,
    ],
    'services/game-server/src/play/play-server.ts': [
        /startTimeRestrictionCheck/,
        /kickTimeRestrictionUsers/,
        /TimeRestriction/,
    ],
    'apps/game/src/views/components/connect-error/createra.tsx': [
        /TimeRestriction/,
        /time-restriction/,
    ],
})) {
    const source = readRequired(file);
    for (const pattern of patterns) {
        forbidPattern(source, file, 'retired anti-addiction restriction', pattern);
    }
}
if (fs.existsSync(path.join(root, 'apps/game/pages/time-restriction.tsx'))) {
    fail('apps/game/pages/time-restriction.tsx: retired anti-addiction page remains');
}

// Rush projects must stay self-contained and must not point at the old private
// registry. rush.json is the only committed monorepo project inventory.
const rushConfiguration = JSON.parse(readRequired('rush.json'));
const workspaceDirs = rushConfiguration.projects.map(({ projectFolder }) => projectFolder);
const packages = new Map();

for (const parent of ['apps', 'internals', 'packages', 'services', 'tools']) {
    for (const entry of fs.readdirSync(path.join(root, parent), { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const directory = `${parent}/${entry.name}`;
        if (
            fs.existsSync(path.join(root, directory, 'package.json')) &&
            !workspaceDirs.includes(directory)
        ) {
            fail(`rush.json does not register workspace project: ${directory}`);
        }
    }
}

for (const directory of workspaceDirs) {
    const packageFile = path.join(root, directory, 'package.json');
    if (!fs.existsSync(packageFile)) {
        fail(`workspace package is missing: ${directory}/package.json`);
        continue;
    }
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    packages.set(manifest.name, { directory, manifest });
}

for (const { directory, manifest } of packages.values()) {
    const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
    };
    for (const [name, version] of Object.entries(dependencies)) {
        if (name.startsWith('@box/') && !packages.has(name)) {
            fail(`${directory}: missing local package ${name}@${version}`);
        }
    }
    if (manifest.publishConfig?.registry?.includes('box3')) {
        fail(`${directory}: private registry is still configured`);
    }
}

// Root npm scripts are discoverable aliases only. Rush still owns the project
// graph, dependency installation and every repository-level implementation.
const rootManifest = JSON.parse(readRequired('package.json'));
requireScript(rootManifest, 'package.json', 'rush', 'node common/scripts/install-run-rush.js');
for (const [name, command] of Object.entries({
    'install:all': 'install',
    'update:all': 'update',
    'dev': 'dev',
    'verify': 'verify',
    'package:images:amd64': 'package-images --architecture amd64',
    'package:images:arm64': 'package-images --architecture arm64',
    'package:desktop:macos-arm64': 'package-desktop --target macos-arm64',
    'package:web:amd64': 'package-web --architecture amd64',
    'package:web:arm64': 'package-web --architecture arm64',
})) {
    requireScript(
        rootManifest,
        'package.json',
        name,
        `node common/scripts/install-run-rush.js ${command}`,
    );
}
for (const forbiddenFile of ['pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    if (fs.existsSync(path.join(root, forbiddenFile))) {
        fail(`${forbiddenFile}: legacy pnpm Workspace file must be removed`);
    }
}
readRequired('common/config/rush/pnpm-lock.yaml', 'Rush pnpm lockfile');
readRequired('common/config/rush/command-line.json', 'Rush command configuration');

for (const name of [
    'creator',
    'creator:up',
    'play',
    'play:up',
    'voxa',
    'voxa:up',
    'player-service',
    'player-service:up',
    'player-auth-portal',
    'player-auth-portal:up',
    'server-manager',
    'server-manager:up',
    'infra',
    'infra:stop',
    'stop',
    'build:creator',
    'build:play',
    'build:voxa',
    'build:desktop-installer',
    'build:headless-server-package',
    'prepare:assets',
    'sync:avatar',
    'migrator',
    'migrator:up',
    'migrator:dev',
    'project:list',
    'project:create',
    'project:publish',
    'project:package',
    'check:local-control',
    'check:engine',
    'check:distribution',
    'check:integration',
    'check:voxa-map-link',
    'check:voxa-extra-project',
    'check:voxa-render',
    'check:edit-session',
    'check:project-identity',
    'lint:control',
]) {
    if (rootManifest.scripts?.[name]) {
        fail(
            `package.json: repository command must be owned by Rush, not a root npm script: ${name}`,
        );
    }
}

const deployFile = 'apps/local-engine/src/deploy.js';
const deploySource = readRequired(deployFile);
for (const [label, pattern] of [
    ['creator image build', /'build', 'creator'/],
    ['creator builds only the creator image', /'build', 'creator'/],
    ['play uses the external world library', /BOX_PLAY_LIBRARY_DIR/],
    [
        'play accepts no release argument',
        /Rush Play \$\{build \? 'build' : 'start'\} 不接受作品参数/,
    ],
    [
        'play command forces a metadata-labelled image rebuild',
        /build\s*\?\s*ensurePlayImageArchive\(\{[\s\S]*?forceBuild:\s*true,[\s\S]*?buildMetadata:\s*automaticBuildMetadata,[\s\S]*?\}\)/,
    ],
    [
        'player service forwards automatic build metadata',
        /ensurePlayerServiceImageArchive\(\{[\s\S]*?forceBuild:\s*true,[\s\S]*?buildMetadata:\s*automaticBuildMetadata,[\s\S]*?\}\)/,
    ],
    [
        'creator starts without rebuilding',
        /'up',[\s\S]*?'-d',[\s\S]*?'--no-build',[\s\S]*?'creator'/,
    ],
    ['play starts without rebuilding', /'up',[\s\S]*?'-d',[\s\S]*?'--no-build',[\s\S]*?'play'/],
    ['VOXA builds only its Docker target', /'build', 'voxa'/],
    ['VOXA starts without rebuilding', /'up',[\s\S]*?'-d',[\s\S]*?'--no-build',[\s\S]*?'voxa'/],
]) {
    requirePattern(deploySource, deployFile, label, pattern);
}
forbidPattern(
    deploySource,
    deployFile,
    'creator building the play image',
    /deployCreator\([^)]*\)[\s\S]*?ensurePlayImageArchive[\s\S]*?function deployPlay/,
);

const playImageFile = 'apps/local-engine/src/play-image.js';
const playImageSource = readRequired(playImageFile);
for (const [label, pattern] of [
    ['default amd64 distribution', /'linux\/amd64'/],
    ['platform-aware image build', /BOX_PLAY_PLATFORM:[\s\S]*?'build', 'play'/],
    ['image archive export', /'image', 'save'/],
    ['archive tag validation', /RepoTags\.includes\(image\)/],
    ['multi-world image format validation', /org\.box\.local-engine\.play-format/],
    ['archive platform validation', /imageConfig\.os[\s\S]*?imageConfig\.architecture/],
]) {
    requirePattern(playImageSource, playImageFile, label, pattern);
}

const engineManifest = JSON.parse(readRequired('apps/local-engine/package.json'));
for (const [name, command] of Object.entries({
    'dev': 'node src/launcher.js --creator',
    'build:creator': 'node src/build.js --creator',
    'start:creator': 'node src/launcher.js --production --creator',
    'build:play': 'node src/build.js --play',
    'start:play': 'node src/launcher.js --production --play',
})) {
    requireScript(engineManifest, 'apps/local-engine/package.json', name, command);
}
for (const name of ['build', 'start']) {
    if (engineManifest.scripts?.[name]) {
        fail(`apps/local-engine/package.json: ambiguous script must be removed: ${name}`);
    }
}
for (const name of ['build:client', 'build:server', 'start:client', 'start:server']) {
    if (engineManifest.scripts?.[name]) {
        fail(`apps/local-engine/package.json: legacy public script must be removed: ${name}`);
    }
}

const gameManifest = JSON.parse(readRequired('apps/game/package.json'));
for (const name of ['cdn-upload', 'upload-rusty']) {
    if (gameManifest.scripts?.[name]) {
        fail(`apps/game/package.json: cloud-only script must be removed: ${name}`);
    }
}

// Local production builds must use the same MuDB protocol-validation rule on
// both sides. Using `||` here makes the browser skip validation while the
// local game server expects it, so the first `start ...` packet is parsed as
// JSON and the websocket is closed immediately.
for (const file of ['apps/game/src/client/index.ts', 'apps/game/src/client/play/play-client.ts']) {
    const source = readRequired(file);
    requirePattern(
        source,
        file,
        'local production protocol validation',
        /process\.env\.NODE_ENV !== 'development'\s*&&\s*!clientConfig\.isLocalGameServer/,
    );
    forbidPattern(
        source,
        file,
        'mismatched local production protocol validation',
        /process\.env\.NODE_ENV !== 'development'\s*\|\|\s*!clientConfig\.isLocalGameServer/,
    );
}

const gameServerManifest = JSON.parse(readRequired('services/game-server/package.json'));
requireScript(
    gameServerManifest,
    'services/game-server/package.json',
    'dev',
    'node scripts/dev-launch.js',
);
const gameServerDevLauncher = readRequired('services/game-server/scripts/dev-launch.js');
for (const [label, pattern] of [
    ['local config path', /BOX_LOCAL_CONFIG_PATH/],
    ['local runtime method', /METHOD: 'local'/],
    ['local script VM', /VM: process\.env\.VM \|\| 'local'/],
]) {
    requirePattern(
        gameServerDevLauncher,
        'services/game-server/scripts/dev-launch.js',
        label,
        pattern,
    );
}

const gameServerConfigFile = 'services/game-server/config/index.ts';
const gameServerConfigSource = readRequired(gameServerConfigFile);
requirePattern(
    gameServerConfigSource,
    gameServerConfigFile,
    'dedicated server script timeout environment variable',
    /scriptTimeout: N\('SCRIPT_TIMEOUT', DEFAULT_SETTINGS\.scriptTimeout\)/,
);
forbidPattern(
    gameServerConfigSource,
    gameServerConfigFile,
    'script timeout wired to heap size',
    /scriptTimeout: N\('SCRIPT_HEAP_MB'/,
);

const gameServerEnvSchemaFile = 'internals/env/src/schemas/game-server.ts';
const gameServerEnvSchemaSource = readRequired(gameServerEnvSchemaFile);
requirePattern(
    gameServerEnvSchemaSource,
    gameServerEnvSchemaFile,
    'large-map ivmp memory limit schema',
    /SCRIPT_MEMORY_LIMIT:\s*\{\s*type:\s*'uint16'\s*\}/,
);

const gameServerEntryFile = 'services/game-server/src/entry.ts';
const gameServerEntrySource = readRequired(gameServerEntryFile);
requirePattern(
    gameServerEntrySource,
    gameServerEntryFile,
    'normalized script timeout passed to isolated process',
    /new IvmpScriptSocketServer\([\s\S]*?spec\.scriptTimeout,[\s\S]*?spec\.SCRIPT_MEMORY_LIMIT/,
);
for (const file of ['apps/game/rusty/.env.prod', 'apps/game/rusty/.env.local.example']) {
    forbidPattern(
        readRequired(file),
        file,
        'legacy BOX online environment URL',
        /(?:dao3|createra|box3)\.fun/i,
    );
}

// One Dockerfile must produce two deliberately different final images.
const dockerFile = 'apps/local-engine/Dockerfile';
const dockerSource = readRequired(dockerFile);
for (const [label, pattern] of [
    ['runtime documentation cleanup', /-iname 'README\*'[\s\S]*?-iname '\*\.md'/],
    ['runtime test directory cleanup', /-name 'test'[\s\S]*?-name '__tests__'/],
    ['runtime TypeScript metadata cleanup', /-name '@types\+\*'/],
    ['pnpm runtime metadata cleanup', /node_modules\/\.modules\.yaml/],
]) {
    requirePattern(dockerSource, dockerFile, label, pattern);
}
for (const [label, pattern] of [
    ['creator build stage', /^FROM engine-build-base AS creator-build$/m],
    [
        'creator build command',
        /install-run-rushx\.js build[\s\S]*?install-run-rushx\.js build:creator/,
    ],
    ['play build stage', /^FROM engine-build-base AS play-build$/m],
    ['play build command', /install-run-rushx\.js build[\s\S]*?install-run-rushx\.js build:play/],
    [
        'workspace runtime dependency build',
        /install-run-rush\.js rebuild[\s\S]*?--to-except @box\/game[\s\S]*?--to-except @box\/player-admin[\s\S]*?--to-except @box\/game-server[\s\S]*?--to-except @box\/local-engine/,
    ],
    [
        'generated API production deploy',
        /install-run-rush-pnpm\.js[\s\S]*?--filter @box\/apis --prod --legacy \/opt\/apis-runtime/,
    ],
    [
        'clean-checkout runtime asset generation',
        /^RUN cd apps\/local-engine && node \.\.\/\.\.\/common\/scripts\/install-run-rushx\.js prepare-assets$/m,
    ],
    ['creator final target', /^FROM runtime-base AS creator$/m],
    ['play final target', /^FROM runtime-base AS play$/m],
    ['VOXA build stage', /^FROM source-base AS voxa-build$/m],
    ['VOXA targeted Rush install', /install-run-rush\.js install --to @box\/voxa/],
    [
        'VOXA build command',
        /^RUN cd apps\/voxa && node \.\.\/\.\.\/common\/scripts\/install-run-rushx\.js build$/m,
    ],
    ['VOXA final target', /^FROM runtime-base AS voxa$/m],
    ['referenced runtime-blob staging', /stage-runtime-data\.js \/opt\/runtime-data/],
    [
        'immutable creator template data',
        /creator[\s\S]*?BOX_LOCAL_TEMPLATE_DATA_PATH=\/opt\/box3-template-data[\s\S]*?COPY --from=creator-build --chown=node:node \/opt\/runtime-data \/opt\/box3-template-data/,
    ],
    [
        'play server editor removal',
        /play-build[\s\S]*?rm -rf[\s\S]*?\/opt\/game-server\/dist\/src\/edit[\s\S]*?\/opt\/game-server\/dist\/src\/deploy/,
    ],
]) {
    requirePattern(dockerSource, dockerFile, label, pattern);
}

for (const extension of [
    "-name '.env'",
    "-name '.env.*'",
    "-name '*.pem'",
    "-name '*.key'",
    "-name '*.map'",
    "-name '*.ts'",
    "-name '*.tsx'",
    "-name '*.nft.json'",
]) {
    const occurrences = dockerSource.split(extension).length - 1;
    if (occurrences < 2) {
        fail(`${dockerFile}: ${extension} must be removed in both build targets`);
    }
}

const creatorDockerStage = getDockerStage(dockerSource, 'creator');
const playDockerStage = getDockerStage(dockerSource, 'play');
const playerServiceBuildStage = getDockerStage(dockerSource, 'player-service-build');
const playerServiceDockerStage = getDockerStage(dockerSource, 'player-service');
const voxaDockerStage = getDockerStage(dockerSource, 'voxa');
const launcherBootstrapSource = readRequired('apps/local-engine/src/launcher.js').split(
    'const packageRoot =',
)[0];
const launcherBootstrapModules = [
    ...launcherBootstrapSource.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g),
].map((match) => `${match[1].slice(2)}.js`);

requirePattern(
    gameNextConfig,
    'apps/game/next.config.js',
    'Player Service root route must target the Player Admin asset directory',
    /source: '\/', destination: '\/player-admin\/index\.html'/,
);
requirePattern(
    playerServiceBuildStage,
    dockerFile,
    'player service preserves the Player Admin public directory',
    /cd apps\/player-admin[\s\S]*?build[\s\S]*?cd \.\.\/\.\.[\s\S]*?BOX_DEPLOYMENT_MODE=player-service/,
);
forbidPattern(
    playerServiceBuildStage,
    dockerFile,
    'player service must not flatten Player Admin static assets into the game public root',
    /cp -a apps\/game\/public\/player-admin\/\. apps\/game\/public\//,
);

for (const [name, stage] of [
    ['creator', creatorDockerStage],
    ['play', playDockerStage],
]) {
    if (!stage.includes('/opt/apis-runtime /app/node_modules/@box/apis')) {
        fail(`${dockerFile}: ${name} target is missing the @box/apis production runtime`);
    }
    for (const moduleFile of launcherBootstrapModules) {
        const imagePath = `/app/apps/local-engine/src/${moduleFile}`;
        if (!stage.includes(`${imagePath} ${imagePath}`)) {
            fail(
                `${dockerFile}: ${name} target is missing launcher bootstrap module ${moduleFile}`,
            );
        }
    }
}
for (const [name, stage] of [
    ['creator', creatorDockerStage],
    ['play', playDockerStage],
    ['player service', playerServiceDockerStage],
    ['VOXA', voxaDockerStage],
]) {
    for (const label of [
        'org.opencontainers.image.version',
        'org.opencontainers.image.revision',
        'org.opencontainers.image.created',
        'org.opencontainers.image.source',
        'org.opencontainers.image.licenses',
    ]) {
        requirePattern(
            stage,
            dockerFile,
            `${name} ${label} label`,
            new RegExp(label.replaceAll('.', '\\.')),
        );
    }
}
for (const [name, stage, flag] of [
    ['creator', creatorDockerStage, '--creator'],
    ['play', playDockerStage, '--play'],
]) {
    if (!stage) {
        fail(`${dockerFile}: cannot inspect ${name} final target`);
        continue;
    }
    requirePattern(stage, dockerFile, `${name} target runs as node`, /^USER node$/m);
    requirePattern(
        stage,
        dockerFile,
        `${name} launcher command`,
        new RegExp(
            `CMD \\["node", "apps/local-engine/src/launcher\\.js", "--production", "${flag}"\\]`,
        ),
    );
    requirePattern(
        stage,
        dockerFile,
        `${name} staged runtime data`,
        name === 'creator'
            ? /COPY --from=[^\s]+ --chown=node:node \/opt\/runtime-data \/opt\/box3-template-data[\s\S]*?cp -al \/opt\/box3-template-data \/app\/apps\/local-engine\/data/
            : /COPY --from=[^\s]+ --chown=node:node \/opt\/runtime-data \/app\/apps\/local-engine\/data/,
    );
    requirePattern(
        stage,
        dockerFile,
        `${name} storage namespace runtime`,
        /COPY --from=[^\s]+ --chown=node:node \/app\/apps\/local-engine\/src\/runtime-storage-namespace\.js \/app\/apps\/local-engine\/src\/runtime-storage-namespace\.js/,
    );
    requirePattern(
        stage,
        dockerFile,
        `${name} teleport room manager runtime`,
        /COPY --from=[^\s]+ --chown=node:node \/app\/apps\/local-engine\/src\/teleport-room-manager\.js \/app\/apps\/local-engine\/src\/teleport-room-manager\.js/,
    );
    forbidPattern(stage, dockerFile, `${name} broad source-tree copy`, /^COPY (?!.*--from=).*$/m);
}
requirePattern(
    creatorDockerStage,
    dockerFile,
    'creator project manager runtime',
    /project-manager\.js/,
);
requirePattern(
    creatorDockerStage,
    dockerFile,
    'creator asset distribution runtime',
    /COPY --from=[^\s]+ --chown=node:node \/app\/apps\/local-engine\/src\/asset-distribution\.js \/app\/apps\/local-engine\/src\/asset-distribution\.js/,
);
requirePattern(
    creatorDockerStage,
    dockerFile,
    'creator play-image cache validator',
    /play-image\.js/,
);
requirePattern(
    creatorDockerStage,
    dockerFile,
    'creator project and export volumes',
    /VOLUME \["\/app\/apps\/local-engine\/projects", "\/app\/apps\/local-engine\/dist"\]/,
);
requirePattern(playDockerStage, dockerFile, 'play deployment runtime', /BOX_DEPLOYMENT_MODE=play/);
forbidPattern(
    playDockerStage,
    dockerFile,
    'creator project manager in play image',
    /project-manager\.js|\/app\/apps\/local-engine\/projects/,
);
requirePattern(
    playerServiceBuildStage,
    dockerFile,
    'player service route pruning',
    /prune-player-build\.js --player-service[\s\S]*?apps\/game\/\.next\/standalone\/apps\/game\/\.next/,
);
requirePattern(
    playerServiceBuildStage,
    dockerFile,
    'player service local-engine source purge',
    /rm -rf apps\/game\/\.next\/standalone\/apps\/local-engine/,
);
const playerServiceBuildCleanup =
    /find\s+([\s\S]*?)\s+-type f \\\(\s*([\s\S]*?)\s*\\\) -delete/.exec(playerServiceBuildStage);
if (!playerServiceBuildCleanup) {
    fail(`${dockerFile}: missing player service build-stage standalone cleanup`);
} else {
    const cleanupTargets = playerServiceBuildCleanup[1];
    for (const target of [
        'apps/game/.next/standalone',
        'apps/game/.next/static',
        'apps/game/public',
    ]) {
        if (!cleanupTargets.includes(target)) {
            fail(`${dockerFile}: player service build-stage cleanup is missing ${target}`);
        }
    }
    const cleanupRules = playerServiceBuildCleanup[2];
    for (const pattern of [
        "-name '.env'",
        "-name '.env.*'",
        "-name '*.pem'",
        "-name '*.key'",
        "-name '*.p12'",
        "-name '*.pfx'",
        "-name '*.map'",
        "-name '*.ts'",
        "-name '*.tsx'",
        "-name '*.nft.json'",
    ]) {
        if (!cleanupRules.includes(pattern)) {
            fail(`${dockerFile}: player service build-stage cleanup is missing ${pattern}`);
        }
    }
}
requirePattern(
    playerServiceBuildStage,
    dockerFile,
    'player service first-party test source purge',
    /find apps\/game\/\.next\/standalone -type f \\\([\s\S]*?-name '\*\.test\.js'[\s\S]*?-name '\*\.spec\.js'[\s\S]*?-not -path '\*\/node_modules\/\*' -delete/,
);
forbidPattern(
    playerServiceDockerStage,
    dockerFile,
    'late player service standalone cleanup that leaves recoverable Docker whiteouts',
    /find \/app\/apps\/game\/\.next\/standalone[\s\S]*?-delete/,
);
for (const [name, stage] of [
    ['creator', getDockerStage(dockerSource, 'creator-build')],
    ['play', getDockerStage(dockerSource, 'play-build')],
]) {
    requirePattern(
        stage,
        dockerFile,
        `${name} first-party runtime JavaScript compaction`,
        /compact-runtime-javascript\.js \/opt\/game-server\/dist \/app\/apps\/local-engine\/src/,
    );
}
requirePattern(
    playerServiceDockerStage,
    dockerFile,
    'player service standalone server',
    /CMD \["node", "apps\/game\/\.next\/standalone\/apps\/game\/server\.js"\]/,
);
requirePattern(
    voxaDockerStage,
    dockerFile,
    'VOXA local data volume',
    /VOLUME \["\/app\/apps\/voxa\/data"\]/,
);
requirePattern(
    voxaDockerStage,
    dockerFile,
    'VOXA standalone server',
    /CMD \["node", "apps\/voxa\/\.next\/standalone\/apps\/voxa\/server\.js"\]/,
);
requirePattern(voxaDockerStage, dockerFile, 'VOXA target runs as node', /^USER node$/m);
requirePattern(
    voxaDockerStage,
    dockerFile,
    'VOXA source and secret file purge',
    /find \/app\/apps\/voxa\/\.next\/standalone[\s\S]*?-name '\*\.map'[\s\S]*?-name '\*\.ts'[\s\S]*?-name '\*\.tsx'/,
);

// Compose exposes the product roles plus isolated optional infrastructure.
// Creator remains localhost-only; play is externally usable.
const composeFile = 'docker-compose.yml';
const composeSource = readRequired(composeFile);
const composeServiceNames = [];
let inServices = false;
for (const line of splitLines(composeSource)) {
    if (line === 'services:') {
        inServices = true;
        continue;
    }
    if (inServices && /^\S/.test(line) && line.trim()) {
        break;
    }
    const match = inServices ? line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/) : null;
    if (match) {
        composeServiceNames.push(match[1]);
    }
}
if (
    composeServiceNames.join(',') !==
    'managed-redis,managed-postgres,postgres,redis,player-service,player-auth-portal,server-manager,creator,creator-storage-init,play-storage-init,play,voxa,voxa-storage-init'
) {
    fail(
        `${composeFile}: unexpected service set (found ${composeServiceNames.join(', ') || 'none'})`,
    );
}

const creatorCompose = getComposeService(composeSource, 'creator');
const creatorStorageInitCompose = getComposeService(composeSource, 'creator-storage-init');
const playCompose = getComposeService(composeSource, 'play');
const playStorageInitCompose = getComposeService(composeSource, 'play-storage-init');
const playerServiceCompose = getComposeService(composeSource, 'player-service');
const playerAuthPortalCompose = getComposeService(composeSource, 'player-auth-portal');
const serverManagerCompose = getComposeService(composeSource, 'server-manager');
const voxaCompose = getComposeService(composeSource, 'voxa');
const voxaStorageInitCompose = getComposeService(composeSource, 'voxa-storage-init');
for (const [name, service] of [
    ['creator', creatorCompose],
    ['play', playCompose],
]) {
    requirePattern(service, composeFile, `${name} profile`, new RegExp(`profiles: \\[${name}\\]`));
    requirePattern(
        service,
        composeFile,
        `${name} unified Dockerfile`,
        /dockerfile: apps\/local-engine\/Dockerfile/,
    );
    requirePattern(service, composeFile, `${name} Docker target`, new RegExp(`target: ${name}`));
    requirePattern(
        service,
        composeFile,
        `${name} deployment mode`,
        new RegExp(`BOX_DEPLOYMENT_MODE: ${name}`),
    );
}
requirePattern(
    playerServiceCompose,
    composeFile,
    'independent player-service profile',
    /profiles: \[player-service\]/,
);
requirePattern(
    playerAuthPortalCompose,
    composeFile,
    'independent player auth portal profile',
    /profiles: \[auth-portal\]/,
);
for (const [label, pattern] of [
    ['dedicated Dockerfile', /dockerfile: apps\/server-manager\/Dockerfile/],
    [
        'loopback-only default port',
        /\$\{BOX_SERVER_MANAGER_BIND_IP:-127\.0\.0\.1\}:\$\{BOX_SERVER_MANAGER_PORT:-3130\}:3130/,
    ],
    ['independent management token', /BOX_SERVER_MANAGER_TOKEN: \$\{BOX_SERVER_MANAGER_TOKEN:-\}/],
    [
        'internal runtime manager token',
        /BOX_RUNTIME_MANAGER_TOKEN: \$\{BOX_RUNTIME_MANAGER_TOKEN:-\}/,
    ],
    ['read-only root filesystem', /read_only: true/],
    ['no-new-privileges', /no-new-privileges:true/],
    ['all capabilities dropped', /cap_drop:\s*\n\s*- ALL/],
    ['backup access to service-owned private files', /cap_add:\s*\n\s*- DAC_OVERRIDE/],
    ['Docker socket mount', /\/var\/run\/docker\.sock/],
]) {
    requirePattern(serverManagerCompose, composeFile, `server manager ${label}`, pattern);
}
forbidPattern(serverManagerCompose, composeFile, 'optional server manager profile', /profiles:/);
for (const [name, service] of [
    ['managed-redis', getComposeService(composeSource, 'managed-redis')],
    ['managed-postgres', getComposeService(composeSource, 'managed-postgres')],
    ['postgres', getComposeService(composeSource, 'postgres')],
    ['redis', getComposeService(composeSource, 'redis')],
    ['player-service', playerServiceCompose],
    ['player-auth-portal', playerAuthPortalCompose],
    ['creator', creatorCompose],
    ['play', playCompose],
    ['VOXA', voxaCompose],
]) {
    forbidPattern(service, composeFile, `${name} Docker socket mount`, /\/var\/run\/docker\.sock/);
}
const serverManagerRustFile = 'apps/server-manager-rust/src/main.rs';
const serverManagerRust = readRequired(serverManagerRustFile);
const managerCoreServices = readRequired('apps/manager-core/src/services.rs');
requirePattern(
    serverManagerRust,
    serverManagerRustFile,
    'fixed service allowlist import',
    /APPLICATION_SERVICES as SERVICES/,
);
requirePattern(
    managerCoreServices,
    'apps/manager-core/src/services.rs',
    'fixed service validation',
    /APPLICATION_SERVICES\.contains\(&service\)/,
);
requirePattern(
    managerCoreServices,
    'apps/manager-core/src/services.rs',
    'operation allowlist',
    /\["start", "stop", "restart"\]/,
);
requirePattern(
    serverManagerRust,
    serverManagerRustFile,
    'authenticated HTTP command route',
    /\/api\/commands\/\{name\}/,
);
requirePattern(
    playerAuthPortalCompose,
    composeFile,
    'player auth portal repository build context',
    /context: \.[\s\S]*?dockerfile: apps\/player-auth-portal\/Dockerfile/,
);
requirePattern(
    playerAuthPortalCompose,
    composeFile,
    'player auth portal server-side API key',
    /AUTH_DEMO_API_KEY: \$\{BOX_PLAYER_AUTH_API_KEY:-\}/,
);
requirePattern(
    playerAuthPortalCompose,
    composeFile,
    'read-only player auth portal',
    /read_only: true[\s\S]*?cap_drop:\s*\n\s*- ALL/,
);
forbidPattern(
    creatorCompose,
    composeFile,
    'creator hard dependency on player-service',
    /depends_on:\s*\n\s{6}player-service:/,
);
forbidPattern(
    playCompose,
    composeFile,
    'play hard dependency on player-service',
    /depends_on:\s*\n(?:\s{6}[A-Za-z0-9_-]+:\s*\n\s{8}condition:[^\n]*\n)*\s{6}player-service:/,
);
requirePattern(
    playStorageInitCompose,
    composeFile,
    'play runtime cache ownership initialization',
    /chown -R 1000:1000 \/app\/play-runtime-cache/,
);
requirePattern(
    playStorageInitCompose,
    composeFile,
    'play storage init only retains CHOWN capability',
    /cap_drop:\s*\n\s*- ALL[\s\S]*?cap_add:\s*\n\s*- CHOWN/,
);
requirePattern(
    playCompose,
    composeFile,
    'play waits for storage initialization',
    /play-storage-init:\s*\n\s*condition: service_completed_successfully/,
);
requirePattern(
    playStorageInitCompose,
    composeFile,
    'play storage initialization owns the writable map library',
    /\/app\/play-worlds[\s\S]*?chown -R 1000:1000[\s\S]*?\/app\/play-worlds/,
);
requirePattern(voxaCompose, composeFile, 'VOXA profile', /profiles: \[voxa\]/);
requirePattern(
    voxaCompose,
    composeFile,
    'VOXA unified Dockerfile',
    /dockerfile: apps\/local-engine\/Dockerfile/,
);
requirePattern(voxaCompose, composeFile, 'VOXA Docker target', /target: voxa/);
for (const name of [
    'BOX_BUILD_VERSION',
    'BOX_BUILD_COMMIT',
    'BOX_BUILD_DATE',
    'BOX_BUILD_SOURCE',
]) {
    requirePattern(
        voxaCompose,
        composeFile,
        `VOXA ${name} build argument`,
        new RegExp(`${name}: \\$\\{${name}:-`),
    );
}
requirePattern(
    voxaCompose,
    composeFile,
    'configurable private VOXA port with a safe loopback default',
    /\$\{BOX_VOXA_BIND_IP:-127\.0\.0\.1\}:\$\{BOX_VOXA_PORT:-3123\}:3001/,
);
requirePattern(
    voxaCompose,
    composeFile,
    'host-backed VOXA data',
    /\$\{BOX_DATA_DIRECTORY:-\.\}\/apps\/voxa\/data:.*\/app\/apps\/voxa\/data/,
);
requirePattern(
    voxaCompose,
    composeFile,
    'VOXA upload size limit',
    /VOXA_MAX_BLOB_BYTES: \$\{VOXA_MAX_BLOB_BYTES:-268435456\}/,
);
requirePattern(
    voxaCompose,
    composeFile,
    'VOXA configured public origin for LAN API writes',
    /BOX_VOXA_PUBLIC_URL: \$\{BOX_VOXA_PUBLIC_URL:-http:\/\/127\.0\.0\.1:3123\}/,
);
requirePattern(
    voxaCompose,
    composeFile,
    'VOXA optional trusted origins for reverse proxies',
    /BOX_VOXA_ALLOWED_ORIGINS: \$\{BOX_VOXA_ALLOWED_ORIGINS:-\}/,
);
for (const [name, service, path] of [
    ['creator', creatorStorageInitCompose, '/app/apps/local-engine/projects'],
    ['VOXA', voxaStorageInitCompose, '/app/apps/voxa/data'],
]) {
    requirePattern(
        service,
        composeFile,
        `${name} storage ownership initialization`,
        new RegExp(`chown -R 1000:1000 ${path.replaceAll('/', '\\/')}`),
    );
    requirePattern(
        service,
        composeFile,
        `${name} storage init has only the minimum write-repair capabilities`,
        /cap_drop:\s*\n\s*- ALL[\s\S]*?cap_add:\s*\n\s*- CHOWN\s*\n\s*- DAC_OVERRIDE/,
    );
}
requirePattern(
    creatorCompose,
    composeFile,
    'creator waits for writable project storage',
    /creator-storage-init:\s*\n\s*condition: service_completed_successfully/,
);
requirePattern(
    voxaCompose,
    composeFile,
    'VOXA waits for writable model storage',
    /voxa-storage-init:\s*\n\s*condition: service_completed_successfully/,
);
requirePattern(
    creatorCompose,
    composeFile,
    'single configurable private creator port with a safe loopback default',
    /ports:\s*\n\s*- "\$\{BOX_CREATOR_BIND_IP:-127\.0\.0\.1\}:\$\{BOX_CREATOR_PORT:-3127\}:3000"/,
);
requirePattern(
    creatorCompose,
    composeFile,
    'host-backed creator projects',
    /\$\{BOX_DATA_DIRECTORY:-\.\}\/apps\/local-engine\/projects:.*\/app\/apps\/local-engine\/projects/,
);
forbidPattern(composeSource, composeFile, 'legacy creator project volume', /box-creator-projects/);
requirePattern(
    creatorCompose,
    composeFile,
    'creator runtime ports with a safe loopback default',
    /127\.0\.0\.1:9966:9966[\s\S]*?127\.0\.0\.1:9967:9967/,
);
requirePattern(
    playCompose,
    composeFile,
    'single configurable play port with safe loopback default',
    /ports:\s*\n\s*- "\$\{BOX_BIND_IP:-127\.0\.0\.1\}:\$\{BOX_PLAY_PORT:-3121\}:3000"/,
);
requirePattern(
    playCompose,
    composeFile,
    'portable amd64 play image',
    /platform: \$\{BOX_PLAY_PLATFORM:-linux\/amd64\}/,
);
requirePattern(
    playCompose,
    composeFile,
    'external writable play library mount',
    /BOX_PLAY_LIBRARY_PATH: \/app\/play-worlds[\s\S]*?source: "\$\{BOX_DATA_DIRECTORY:-\.\}\/apps\/local-engine\/play-worlds"/,
);
forbidPattern(
    playCompose,
    composeFile,
    'separate public play runtime',
    /9966:9966|BOX_PLAY_SERVER|BOX_REMOTE_SERVER_URL/,
);
forbidPattern(
    composeSource,
    composeFile,
    'legacy split Dockerfile reference',
    /apps\/game\/Dockerfile|services\/game-server\/Dockerfile/,
);

// Build and launcher boundaries: creator owns management, while play starts no
// editor and uses the pruned player web build.
const buildFile = 'apps/local-engine/src/build.js';
const buildSource = readRequired(buildFile);
for (const [label, pattern] of [
    ['creator build mode', /process\.argv\.includes\('--creator'\)/],
    ['play build mode', /process\.argv\.includes\('--play'\)/],
    ['play selects play browser build', /const playBuild = playMode/],
    [
        'player route pruning for build and standalone output',
        /prunePlayerBuild\(path\.join\(gameRoot, '\.next'\)\)[\s\S]*?prunePlayerBuild\(path\.join\(standaloneGameRoot, '\.next'\)\)/,
    ],
    ['play-only build marker', /fs\.writeFileSync\(playBuildMarker, 'play-only\\n'\)/],
    [
        'standalone play-only build marker',
        /path\.join\(standaloneGameRoot, '\.next\/BOX_PLAY_BUILD'\)/,
    ],
    ['standalone local-engine removal', /path\.join\(standaloneGameRoot, '\.\.\/local-engine'\)/],
    ['standalone environment removal', /path\.join\(standaloneGameRoot, '\.env\.local'\)/],
    [
        'standalone private-key removal',
        /entry\.name\.endsWith\('\.pem'\)[\s\S]*?entry\.name\.endsWith\('\.key'\)/,
    ],
    [
        'cross-process build lock',
        /acquireBuildLock\(\)[\s\S]*?Another \$\{owner\.mode \|\| 'creator\/play'\} build is already running/,
    ],
]) {
    requirePattern(buildSource, buildFile, label, pattern);
}
forbidPattern(
    buildSource,
    buildFile,
    'legacy client/server build modes',
    /--client\b|--server\b|start:client|start:server/,
);

const launcherFile = 'apps/local-engine/src/launcher.js';
const launcherSource = readRequired(launcherFile);
for (const [label, pattern] of [
    ['creator launch mode', /process\.argv\.includes\('--creator'\)/],
    ['play launch mode', /process\.argv\.includes\('--play'\)/],
    ['creator is the default product', /const creatorMode = !playMode && !runtimeOnly/],
    ['play starts the game runtime', /playMode \|\| \(runtimeOnly && runtimeMode !== 'edit'\)/],
    ['play skips edit runtime', /const startsEditServer = runtimeOnly && runtimeMode !== 'play'/],
    ['play uses player web build', /const usesPlayerWeb = playMode/],
    ['creator project runtime mode', /--runtime-only requires --project <project-id>/],
    ['play rejects editable source projects', /playMode && launchTarget\?\.kind === 'source'/],
    ['product environment flag', /BOX_DEPLOYMENT_MODE: playMode \? 'play' : 'creator'/],
    ['isolated server script runtime', /const scriptVm = process\.env\.BOX_SCRIPT_VM \|\| 'ivmp'/],
    ['server script VM propagation', /VM: scriptVm/],
    ['single product address', /Open: http:\/\/127\.0\.0\.1:\$\{webPort\}\//],
    [
        'standalone build-id validation',
        /fs\.existsSync\(nextBuildId\) \|\| fs\.existsSync\(standaloneBuildId\)/,
    ],
    ['read-only play-world source', /startLibraryRuntime[\s\S]*?STORAGE_PATH: world\.dataRoot/],
    ['persistent derived runtime storage', /BOX_DERIVED_STORAGE_PATH: derivedRuntimePath\(/],
    [
        'mode-specific runtime storage',
        /STORAGE_PATH: mode === 'play' \? playServerDataRoot : dataRoot/,
    ],
    [
        'project-scoped runtime container name',
        /CONTAINER_NAME:\s*projectId\s*\|\|\s*releaseId\s*\|\|\s*process\.env\.BOX_WORLD_ID\s*\|\|\s*process\.env\.BOX_SERVER_CONTENT_ID/,
    ],
]) {
    requirePattern(launcherSource, launcherFile, label, pattern);
}
requirePattern(
    launcherSource,
    launcherFile,
    'same-origin play runtime',
    /BOX_REMOTE_SERVER_URL: ''/,
);
requirePattern(
    readRequired('apps/local-engine/src/project-manager.js'),
    'apps/local-engine/src/project-manager.js',
    'project creation uses explicit readable template copy',
    /function copyReadableDirectorySync[\s\S]*?copyReadableFileSync[\s\S]*?createProject[\s\S]*?copyReadableDirectorySync\(templateDataRoot/,
);
forbidPattern(
    launcherSource,
    launcherFile,
    'full play-world copy on runtime startup',
    /fs\.cpSync\(world\.dataRoot/,
);
forbidPattern(
    launcherSource,
    launcherFile,
    'legacy client/server launch modes',
    /--client-only|--server-only|Player Client|Dedicated Server/,
);

const projectManagerModelsFile = 'apps/local-engine/src/project-manager.js';
const projectManagerModelsSource = readRequired(projectManagerModelsFile);
requirePattern(
    projectManagerModelsSource,
    projectManagerModelsFile,
    'published VOXA model metadata root',
    /state\.extraProjectHash[\s\S]*?getReachableProjectHashes/,
);
for (const [label, pattern] of [
    ['sanitized published permissions', /publishedPermissionHash[\s\S]*?emptyUsersHash/],
    ['private server script manifest', /private-blobs\.json[\s\S]*?privateHashes/],
    [
        'exported private blob manifest',
        /releaseDataRoot, 'private-blobs\.json'[\s\S]*?destinationDataRoot, 'private-blobs\.json'/,
    ],
    ['sensitive content publication guard', /assertNoSensitiveContent/],
    ['published project history removal', /committerId: 0[\s\S]*?prevHash: ''/],
]) {
    requirePattern(projectManagerModelsSource, projectManagerModelsFile, label, pattern);
}

const localProjectStateFile = 'services/game-server/src/project/local-project-state.ts';
const localProjectStateSource = readRequired(localProjectStateFile);
requirePattern(
    localProjectStateSource,
    localProjectStateFile,
    'persisted extra project hash',
    /extraProjectHash/,
);
forbidPattern(
    launcherSource,
    launcherFile,
    'disabled in-process server script runtime',
    /VM: 'local'/,
);

const serverLaunchFile = 'services/game-server/src/launch.ts';
const serverLaunchSource = readRequired(serverLaunchFile);
forbidPattern(
    serverLaunchSource,
    serverLaunchFile,
    'removed CI image-registration deploy server',
    /startDeployServer|CICD_DEPLOY|vb-migration/,
);
forbidPattern(
    serverLaunchSource,
    serverLaunchFile,
    'complete runtime config logging',
    /Game server config from nacos|%o', serverConfig/,
);
for (const file of [
    serverLaunchFile,
    'services/game-server/src/entry.ts',
    'services/game-server/src/createServer.ts',
    'services/game-server/config/server.ts',
]) {
    forbidPattern(
        readRequired(file),
        file,
        'RabbitMQ platform dependency in the local runtime path',
        /RabbitMQ|RABBITMQ_HOST_URL|\.\/mq\/rabbitMQ/,
    );
}

const serverEntryFile = 'services/game-server/src/entry.ts';
const contentHostFile = 'packages/content-server/src/content-host.ts';
const contentHostSource = readRequired(contentHostFile);
for (const [label, pattern] of [
    ['private blob HTTP denial', /deniedHashes\.has\(arg\)/],
    ['restricted resource origins', /requestOriginAllowed/],
    ['read-only play content store', /options\.readOnly/],
]) {
    requirePattern(contentHostSource, contentHostFile, label, pattern);
}
requirePattern(
    readRequired(serverEntryFile),
    serverEntryFile,
    'edit-only local project state persistence',
    /if \(isLocal && spec\.mode === 'edit'\) \{\s*persistLocalProjectState\(hash\)/,
);
requirePattern(
    readRequired('services/game-server/src/createServer.ts'),
    'services/game-server/src/createServer.ts',
    'publish-time editor flush route',
    /internal\/save-local-project[\s\S]*?editServer\.replica\.saveProject\(\)/,
);
requirePattern(
    readRequired('services/game-server/src/createServer.ts'),
    'services/game-server/src/createServer.ts',
    'deployed runtime fails closed when Player Service is unavailable',
    /requiresPlayerService[\s\S]*?!usesPlayerService[\s\S]*?Player Service identity is required for deployed local games/,
);
requirePattern(
    readRequired('apps/game/pages/api/local-projects/[id]/publish.ts'),
    'apps/game/pages/api/local-projects/[id]/publish.ts',
    'flush every map-group editor before local release creation',
    /manager\.listMapGroup\(id\)[\s\S]*?members\.map\(\(member\) => flushActiveEditor\(member\.id\)\)[\s\S]*?manager\.publishMapGroup/,
);
requirePattern(
    readRequired('apps/local-engine/src/play-library.js'),
    'apps/local-engine/src/play-library.js',
    'play release version invalidates runtime',
    /manifest\.version[\s\S]*?manifest\.permissionHash[\s\S]*?state\.extraProjectHash/,
);

// Every project-management API must independently reject a player deployment,
// even before the generated route is physically pruned.
const localProjectApiRoot = path.join(root, 'apps/game/pages/api/local-projects');
const localProjectApiFiles = collectFiles(
    localProjectApiRoot,
    (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
);
if (localProjectApiFiles.length === 0) {
    fail('missing local project management API sources');
}
for (const filePath of localProjectApiFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    const file = path.relative(root, filePath);
    requirePattern(
        source,
        file,
        'authenticated creator API guard import',
        /import\s*\{\s*allowAuthenticatedCreatorApi\s*\}\s*from\s*['"][^'"]*creator-api-security['"];/,
    );
    requirePattern(
        source,
        file,
        'awaited authenticated creator API guard',
        /await\s+allowAuthenticatedCreatorApi\(\s*req,\s*res,\s*/,
    );
}

const playAdminApiRoot = path.join(root, 'apps/game/pages/api/play-admin');
const playAdminApiFiles = collectFiles(
    playAdminApiRoot,
    (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
);
if (playAdminApiFiles.length === 0) {
    fail('missing play host management API sources');
}
for (const filePath of playAdminApiFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    const file = path.relative(root, filePath);
    requirePattern(
        source,
        file,
        'play admin API guard',
        /(?:allowPlay(?:Library)?Admin|authorizePlayerAdmin|allowPlayerAdminRequestOrigin|playLibraryAdminRoute)\(req, res|playerAdminRoute\s*\(|export default playLibraryAdminRoute/,
    );
}

for (const [file, label, pattern] of [
    [
        'apps/game/server/play-admin-security.ts',
        'play admin disabled without a configured token',
        /BOX_PLAY_ADMIN_TOKEN[\s\S]*?mode === 'play'/,
    ],
    [
        'docker-compose.yml',
        'auth portal receives the player registration policy',
        /AUTH_DEMO_REGISTRATION_ENABLED: \$\{BOX_PLAYER_REGISTRATION_ENABLED:-true\}/,
    ],
]) {
    requirePattern(readRequired(file), file, label, pattern);
}

for (const [file, label, pattern] of [
    [
        'apps/game/pages/projects/index.tsx',
        'projects page hidden in play deployments',
        /\['play', 'player-service'\]\.includes\(process\.env\.BOX_DEPLOYMENT_MODE[\s\S]*?notFound: true/,
    ],
    [
        'apps/game/app/e/[container]/page.tsx',
        'editor route redirected in play deployments',
        /BOX_DEPLOYMENT_MODE === 'play'[\s\S]*?redirect\('\/p\/local'\)/,
    ],
    [
        'apps/game/pages/api/createSession.ts',
        'edit session rejected in play deployments',
        /BOX_DEPLOYMENT_MODE === 'play'[\s\S]*?mode !== 'play'[\s\S]*?status\(404\)/,
    ],
    [
        'apps/game/pages/api/getMapInfo.ts',
        'edit map info rejected in play deployments',
        /BOX_DEPLOYMENT_MODE === 'play'[\s\S]*?mode !== 'play'[\s\S]*?status\(404\)/,
    ],
    [
        'apps/game/pages/api/config/[...slug].ts',
        'edit config rejected in play deployments',
        /BOX_DEPLOYMENT_MODE === 'play'[\s\S]*?mode !== 'play'[\s\S]*?status\(404\)/,
    ],
    [
        'apps/game/webpack/index.js',
        'player adapters replace editor and admin entries',
        /BOX_PLAY_BUILD[\s\S]*?player-only[\s\S]*?src\\\/entry\\\/editor-page[\s\S]*?src\\\/entry\\\/admin-client[\s\S]*?src\\\/entry\\\/admin-ui/,
    ],
    [
        'apps/game/webpack/index.js',
        'Monaco excluded from player builds',
        /if \(!isPlayBuild(?: && !isServer)?\) \{[\s\S]*?CopyWebpackPlugin[\s\S]*?monaco-editor\/package\.json/,
    ],
]) {
    requirePattern(readRequired(file), file, label, pattern);
}
for (const file of [
    'apps/game/pages/connect.tsx',
    'apps/game/pages/export-p.tsx',
    'apps/game/pages/p/[gameName]/[num].tsx',
    'apps/game/pages/play-client-demo.tsx',
]) {
    if (fs.existsSync(path.join(root, file))) {
        fail(`${file}: legacy public route must be removed`);
    }
}
const remoteTargetFile = 'apps/game/src/utils/remote-game-server.ts';
const remoteTargetSource = readRequired(remoteTargetFile);
forbidPattern(
    remoteTargetSource,
    remoteTargetFile,
    'query-selected runtime',
    /URLSearchParams[\s\S]*?get\('server'\)/,
);
forbidPattern(
    remoteTargetSource,
    remoteTargetFile,
    'remembered runtime selection',
    /localStorage|rememberRemoteServerURL/,
);
requirePattern(
    remoteTargetSource,
    remoteTargetFile,
    'same-origin WebSocket target',
    /socketServerURL:\s*toWebSocketURL\(baseURL\)/,
);

const browserConfigFile = 'apps/game/configs/client.ts';
const browserConfigSource = readRequired(browserConfigFile);
requirePattern(
    browserConfigSource,
    browserConfigFile,
    'creator and play browser URLs stay on the public origin',
    /BOX_DEPLOYMENT_MODE !== 'creator'[\s\S]*?BOX_DEPLOYMENT_MODE !== 'play'[\s\S]*?localRuntimePath =[\s\S]*?`\/runtime\/play\/\$\{encodeURIComponent\(containerName\)\}`[\s\S]*?runtimeURL =[\s\S]*?ARENA_URL: ''[\s\S]*?BACKEND_SERVER_URL: runtimeURL[\s\S]*?CDN_PATH: runtimeURL[\s\S]*?OSS_CDN_URL: runtimeURL/,
);
requirePattern(
    readRequired('apps/game/server/server-render.ts'),
    'apps/game/server/server-render.ts',
    'browser runtime prefix follows the page mode',
    /extractServerConfigForClient\([\s\S]*?serverConfig,[\s\S]*?mode,[\s\S]*?containerName/,
);
requirePattern(
    readRequired('apps/game/pages/api/createSession.ts'),
    'apps/game/pages/api/createSession.ts',
    'same-origin creator WebSocket URL',
    /deploymentMode === 'creator'[\s\S]*?roomPath = privateRoomId[\s\S]*?json\.data\.socketServerUrl = `\$\{protocol\}:\/\/\$\{requestHost\}\/runtime\/\$\{mode\}\/\$\{encodeURIComponent\(containerName\)\}\$\{roomPath\}`/,
);
requirePattern(
    readRequired('apps/game/pages/api/createSession.ts'),
    'apps/game/pages/api/createSession.ts',
    'same-origin play WebSocket URL',
    /deploymentMode === 'play'[\s\S]*?runtimePath =[\s\S]*?`\/runtime\/play\/\$\{encodeURIComponent\(containerName\)\}\$\{[\s\S]*?privateRoomId[\s\S]*?json\.data\.socketServerUrl/,
);
requirePattern(
    readRequired('apps/game/src/apis/local-api/index.ts'),
    'apps/game/src/apis/local-api/index.ts',
    'local uploads use the writable edit runtime',
    /function runtimeApi\(\)[\s\S]*?baseUrl: getConfig\(\)\.BACKEND_SERVER_URL\.replace\([\s\S]*?upload:[\s\S]*?uploadLocalResource\(runtimeApi\(\), file\)/,
);

requirePattern(
    remoteTargetSource,
    remoteTargetFile,
    'shared WebSocket URL conversion',
    /import\s*\{\s*toWebSocketURL\s*\}\s*from\s*['"]\.\.\/\.\.\/shared\/websocket-url['"]/,
);
requirePattern(
    readRequired('apps/game/src/apis/local-api/resource-upload.ts'),
    'apps/game/src/apis/local-api/resource-upload.ts',
    'resource upload helper preserves the runtime client and plain-text response',
    /uploadLocalResource\(api: ApiClient, file: Blob\)[\s\S]*?api\.postBlockRaw\([\s\S]*?parseAs:\s*'text'/,
);

const nextConfigFile = 'apps/game/next.config.js';
const nextConfigSource = readRequired(nextConfigFile);
for (const [label, pattern] of [
    [
        'internal play runtime target',
        /BOX_PLAY_RUNTIME_PORT[\s\S]*?'9966'[\s\S]*?BOX_INTERNAL_PLAY_RUNTIME/,
    ],
    [
        'internal edit runtime target',
        /BOX_EDIT_RUNTIME_PORT[\s\S]*?'9967'[\s\S]*?BOX_INTERNAL_EDIT_RUNTIME/,
    ],
    ['prefixed play runtime proxy', /source: '\/runtime\/play\/:path\*'[\s\S]*?localPlayRuntime/],
    [
        'play world lifecycle proxy',
        /source: '\/p\/:world\/__local_runtime\/:path\*'[\s\S]*?localPlayRuntime/,
    ],
    ['prefixed edit runtime proxy', /source: '\/runtime\/edit\/:path\*'[\s\S]*?localEditRuntime/],
    ['same-origin session proxy', /source: '\/api\/session'[\s\S]*?\/api\/session/],
    ['same-origin server info proxy', /source: '\/api\/server-info'[\s\S]*?\/api\/server-info/],
    ['same-origin block proxy', /source: '\/block\/:path\*'/],
    ['same-origin WebSocket proxy', /key: 'upgrade', value: 'websocket'/],
    ['extended runtime proxy timeout', /proxyTimeout: 300_000/],
    ['disabled framework disclosure', /poweredByHeader: false/],
    ['content type sniffing protection', /X-Content-Type-Options[\s\S]*?nosniff/],
    ['referrer privacy policy', /Referrer-Policy[\s\S]*?no-referrer/],
    ['same-origin microphone permission', /Permissions-Policy[\s\S]*?microphone=\(self\)/],
]) {
    requirePattern(nextConfigSource, nextConfigFile, label, pattern);
}
forbidPattern(
    nextConfigSource,
    nextConfigFile,
    'a Permissions-Policy that disables the microphone API',
    /microphone=\(\)/,
);
requirePattern(
    readRequired('apps/game/server/dev-server/index.ts'),
    'apps/game/server/dev-server/index.ts',
    'development WebSocket upgrade forwarding',
    /getUpgradeHandler\(\)[\s\S]*?server\.on\('upgrade'/,
);
requirePattern(
    readRequired('apps/game/server/dev-server/index.ts'),
    'apps/game/server/dev-server/index.ts',
    'development creator binds the configured host',
    /BOX_WEB_HOST[\s\S]*?server\.listen\(port, host/,
);

const projectRuntimeApiFile = 'apps/game/pages/api/local-projects/[id]/runtime.ts';
readRequired(projectRuntimeApiFile);
// The per-project Creator runtime no longer re-spawns the launcher with
// `--runtime-only --runtime-mode <mode>`; it boots the game server in-process.
// The invariant is unchanged: production artifacts may only be chosen by the
// single `production` gate, and the project runtime must reach the game server
// through that gate with its own `mode` still carried into the environment.
requirePattern(
    launcherSource,
    'apps/local-engine/src/launcher.js',
    'development project runtime avoids production artifacts',
    /const gameServerLaunchArgs = \(\) =>\s*production\s*\?\s*\[[^\]]*'--useProdBundle'[^\]]*\][\s\S]*?:\s*\[[^\]]*'src\/launch\.ts'[^\]]*\];[\s\S]*?const startProjectRuntime =[\s\S]*?spawnRuntime\(process\.execPath, gameServerLaunchArgs\(\)[\s\S]*?env: gameServerEnv\(runtime, mode, port/,
);
requirePattern(
    launcherSource,
    'apps/local-engine/src/launcher.js',
    'runtime-only game server keeps loading through long prebakes',
    /function waitForGameRuntime[\s\S]*?BOX_RUNTIME_START_TIMEOUT_MS[\s\S]*?startsPlayServer[\s\S]*?waitForGameRuntime[\s\S]*?startsEditServer[\s\S]*?waitForGameRuntime/,
);
requirePattern(
    readRequired('apps/local-engine/src/runtime-data-permissions.js'),
    'apps/local-engine/src/runtime-data-permissions.js',
    'Docker Desktop source-project permission normalization',
    /RECOVERABLE_CHMOD_CODES[\s\S]*?chmodSync\(target, mode\)[\s\S]*?accessSync\(target, accessMode\)/,
);
requirePattern(
    launcherSource,
    'apps/local-engine/src/launcher.js',
    'Docker Desktop permission compatibility is applied before edit startup',
    /require\('\.\/runtime-data-permissions'\)[\s\S]*?startsEditServer[\s\S]*?makeRuntimeDataReadable\(dataRoot\)/,
);
requirePattern(
    readRequired('docker-compose.yml'),
    'docker-compose.yml',
    'persistent creator and play runtime caches',
    /BOX_RUNTIME_CACHE_PATH: \/app\/apps\/local-engine\/projects\/\.runtime-cache[\s\S]*?BOX_RUNTIME_CACHE_PATH: \/app\/play-runtime-cache/,
);
requirePattern(
    readRequired('distribution/play/compose.yml'),
    'distribution/play/compose.yml',
    'persistent distributed play runtime cache',
    /BOX_RUNTIME_CACHE_PATH: \/app\/play-runtime-cache/,
);
forbidPattern(
    readRequired('docker-compose.yml'),
    'docker-compose.yml',
    'obsolete file data storage path in PostgreSQL deployments',
    /BOX_DATA_STORAGE_PATH:/,
);
requirePattern(
    launcherSource,
    'apps/local-engine/src/launcher.js',
    'edit and play project runtimes are managed separately',
    /editLibrary = require\('\.\/edit-library'\)[\s\S]*?mode: 'edit'[\s\S]*?creatorPlayLibrary = require\('\.\/edit-library'\)[\s\S]*?mode: 'play'/,
);

requirePattern(
    playDockerStage,
    dockerFile,
    'Docker-network-reachable private play runtime',
    /BOX_PLAY_RUNTIME_HOST=0\.0\.0\.0/,
);
requirePattern(
    creatorDockerStage,
    dockerFile,
    'docker-reachable creator runtimes',
    /BOX_PLAY_RUNTIME_HOST=0\.0\.0\.0[\s\S]*?BOX_EDIT_RUNTIME_HOST=0\.0\.0\.0/,
);
requirePattern(
    creatorDockerStage,
    dockerFile,
    'creator web and loopback runtime ports',
    /^EXPOSE 3000 9966 9967$/m,
);
requirePattern(playDockerStage, dockerFile, 'single exposed play port', /^EXPOSE 3000$/m);
forbidPattern(playDockerStage, dockerFile, 'public runtime port in play image', /EXPOSE[^\n]*9966/);
requirePattern(
    playDockerStage,
    dockerFile,
    'health check through same-origin proxy',
    /127\.0\.0\.1:3000\/api\/play-worlds/,
);

const projectManagerFile = 'apps/local-engine/src/project-manager.js';
const projectManagerSource = readRequired(projectManagerFile);
requirePattern(
    projectManagerSource,
    projectManagerFile,
    'single public play port in exported package',
    /BOX_WORLD_PATH: \/app\/world\/data[\s\S]*?BOX_WORLD_HASH:[\s\S]*?BOX_PLAY_PORT:-3000\}:3000/,
);
requirePattern(
    projectManagerSource,
    projectManagerFile,
    'one-command exported play deployment',
    /docker compose up -d/,
);
requirePattern(
    projectManagerSource,
    projectManagerFile,
    'exported play package includes the image archive',
    /contents\.push\('play-image\.tar'\)[\s\S]*?includePlayImage/,
);
requirePattern(
    projectManagerSource,
    projectManagerFile,
    'self-preparing play image export',
    /ensurePlayImageArchive\(\)/,
);
requirePattern(
    projectManagerSource,
    projectManagerFile,
    'Docker Desktop safe readable file copies',
    /function copyReadableFileSync[\s\S]*?fs\.openSync\(destination, 'w', 0o644\)/,
);
requirePattern(
    projectManagerSource,
    projectManagerFile,
    'browser-downloadable play bundle export',
    /function exportPlayBundle[\s\S]*?\.boxplay/,
);
forbidPattern(
    projectManagerSource,
    projectManagerFile,
    'Docker Desktop unsafe release tree copy',
    /fs\.cpSync\(releaseRoot/,
);
requirePattern(
    readRequired('apps/game/server/play-admin.ts'),
    'apps/game/server/play-admin.ts',
    'Docker Desktop readable imported play assets',
    /createWriteStream\(target, \{ flags: 'wx', mode: 0o644 \}\)/,
);
requirePattern(
    projectManagerSource,
    projectManagerFile,
    'play package records the image platform',
    /platform: playImageConfig\.platform/,
);
requirePattern(
    projectManagerSource,
    projectManagerFile,
    'release manifest and state validation',
    /manifest\.id !== id[\s\S]*?state\.permissionHash !== manifest\.permissionHash/,
);
requirePattern(
    readRequired('apps/game/pages/api/local-projects/[id]/package.ts'),
    'apps/game/pages/api/local-projects/[id]/package.ts',
    'project UI downloads an importable play bundle',
    /manager\.exportPlayBundle/,
);
forbidPattern(
    projectManagerSource,
    projectManagerFile,
    'redundant exported compose filename flag',
    /docker compose -f compose\.yml/,
);
forbidPattern(
    projectManagerSource,
    projectManagerFile,
    'separate runtime in exported play package',
    /BOX_PLAY_SERVER_PORT|BOX_PLAY_SERVER_URL|BOX_REMOTE_SERVER_URL|BOX_SERVER_DATA_PATH|BOX_PROJECT_STATE_PATH|BOX_PROJECT_HASH/,
);
requirePattern(
    readRequired('apps/game/pages/index.tsx'),
    'apps/game/pages/index.tsx',
    'root route selects creator or play product',
    /BOX_DEPLOYMENT_MODE !== 'play'[\s\S]*?'\/projects'[\s\S]*?getPlayWorlds\(\)/,
);

// Exercise the pruning implementation against a miniature Next build so this
// check verifies behavior, not only source-code wording.
function checkPlayerPruning() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-player-prune-'));
    const write = (file, value = 'fixture') => {
        const target = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
    };
    try {
        write('server/pages/projects.js');
        write('server/pages/api/local-projects/index.js');
        write('server/app/e/[container]/page.js');
        write('server/app/p/[container]/page.js');
        write('static/chunks/pages/projects-fixture.js');
        write('static/chunks/app/e/editor-fixture.js');
        write('static/css/app/e/editor-fixture.css');
        write('server/pages-manifest.json', {
            '/projects': 'pages/projects.js',
            '/api/local-projects': 'pages/api/local-projects.js',
            '/api/local-projects/[id]': 'pages/api/local-projects/[id].js',
            '/': 'pages/index.js',
        });
        write('server/app-paths-manifest.json', {
            '/e/[container]/page': 'app/e/[container]/page.js',
            '/p/[container]/page': 'app/p/[container]/page.js',
        });
        write('routes-manifest.json', {
            dynamicRoutes: [
                { page: '/e/[container]' },
                { page: '/api/local-projects/[id]' },
                { page: '/p/[container]' },
            ],
            staticRoutes: [{ page: '/projects' }, { page: '/' }],
            dataRoutes: [{ page: '/projects' }, { page: '/' }],
        });
        write('app-build-manifest.json', {
            pages: {
                '/e/[container]/page': ['editor.js'],
                '/p/[container]/page': ['player.js'],
            },
        });

        const { prunePlayerBuild } = require(
            path.join(root, 'apps/local-engine/src/prune-player-build.js'),
        );
        prunePlayerBuild(tempRoot);

        for (const file of [
            'server/pages/projects.js',
            'server/pages/api/local-projects',
            'server/app/e',
            'static/chunks/pages/projects-fixture.js',
            'static/chunks/app/e',
            'static/css/app/e',
        ]) {
            if (fs.existsSync(path.join(tempRoot, file))) {
                fail(`prune-player-build.js: did not remove ${file}`);
            }
        }
        if (!fs.existsSync(path.join(tempRoot, 'server/app/p/[container]/page.js'))) {
            fail('prune-player-build.js: removed the player route');
        }

        const pages = JSON.parse(
            fs.readFileSync(path.join(tempRoot, 'server/pages-manifest.json'), 'utf8'),
        );
        if (pages['/projects'] || pages['/api/local-projects/[id]']) {
            fail('prune-player-build.js: project routes remain in pages manifest');
        }
        if (!pages['/']) {
            fail('prune-player-build.js: removed the public product entry');
        }

        const appPaths = JSON.parse(
            fs.readFileSync(path.join(tempRoot, 'server/app-paths-manifest.json'), 'utf8'),
        );
        if (appPaths['/e/[container]/page']) {
            fail('prune-player-build.js: editor route remains in app manifest');
        }
        if (!appPaths['/p/[container]/page']) {
            fail('prune-player-build.js: player route is missing from app manifest');
        }

        const routes = JSON.parse(
            fs.readFileSync(path.join(tempRoot, 'routes-manifest.json'), 'utf8'),
        );
        const routePages = [
            ...(routes.dynamicRoutes || []),
            ...(routes.staticRoutes || []),
            ...(routes.dataRoutes || []),
        ].map(({ page }) => page);
        if (
            routePages.some(
                (page) =>
                    page === '/projects' ||
                    page === '/e/[container]' ||
                    page.startsWith('/api/local-projects'),
            )
        ) {
            fail('prune-player-build.js: private routes remain in routes manifest');
        }
        if (!routePages.includes('/p/[container]')) {
            fail('prune-player-build.js: public play route is missing');
        }
    } catch (error) {
        fail(`prune-player-build.js behavior check failed: ${error.message}`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

checkPlayerPruning();

function checkPlayerServicePruning() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-player-service-prune-'));
    const write = (file, value = 'fixture') => {
        const target = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
    };
    try {
        const pages = {
            '/': 'pages/index.js',
            '/players': 'pages/players.js',
            '/api/health-check': 'pages/api/health-check.js',
            '/api/player-auth/login': 'pages/api/player-auth/login.js',
            '/api/player-auth/login-required': 'pages/api/player-auth/login-required.js',
            '/api/player-internal/logout': 'pages/api/player-internal/logout.js',
            '/api/player-internal/map-library': 'pages/api/player-internal/map-library.js',
            '/api/player-internal/profile': 'pages/api/player-internal/profile.js',
            '/api/play-admin/players': 'pages/api/play-admin/players.js',
            '/api/play-admin/permission-groups': 'pages/api/play-admin/permission-groups/index.js',
            '/api/play-admin/permission-groups/[id]':
                'pages/api/play-admin/permission-groups/[id].js',
            '/projects': 'pages/projects.js',
            '/p/[gameName]': 'pages/p/[gameName].js',
            '/api/local-projects': 'pages/api/local-projects.js',
            '/api/play-worlds': 'pages/api/play-worlds.js',
        };
        for (const relative of Object.values(pages)) {
            write(`server/${relative}`);
        }
        write('server/pages-manifest.json', pages);
        write('server/app/e/[container]/page.js');
        write('static/chunks/app/e/editor.js');
        write('server/app-paths-manifest.json', {
            '/e/[container]/page': 'app/e/[container]/page.js',
        });
        write('routes-manifest.json', {
            dynamicRoutes: [{ page: '/p/[gameName]' }],
            staticRoutes: [{ page: '/' }, { page: '/projects' }],
            dataRoutes: [{ page: '/players' }],
        });
        write('build-manifest.json', {
            pages: Object.fromEntries(Object.keys(pages).map((route) => [route, [`${route}.js`]])),
        });

        const { prunePlayerServiceBuild } = require(
            path.join(root, 'apps/local-engine/src/prune-player-build.js'),
        );
        prunePlayerServiceBuild(tempRoot);
        const pruned = JSON.parse(
            fs.readFileSync(path.join(tempRoot, 'server/pages-manifest.json'), 'utf8'),
        );
        for (const route of [
            '/',
            '/players',
            '/api/health-check',
            '/api/player-auth/login',
            '/api/player-auth/login-required',
            '/api/player-internal/logout',
            '/api/player-internal/map-library',
            '/api/player-internal/profile',
            '/api/play-admin/players',
            '/api/play-admin/permission-groups',
            '/api/play-admin/permission-groups/[id]',
        ]) {
            if (!pruned[route]) {
                fail(`player-service pruning removed ${route}`);
            }
        }
        for (const route of [
            '/projects',
            '/p/[gameName]',
            '/api/local-projects',
            '/api/play-worlds',
        ]) {
            if (pruned[route]) {
                fail(`player-service pruning retained ${route}`);
            }
        }
        if (fs.existsSync(path.join(tempRoot, 'server/app'))) {
            fail('player-service pruning retained App Router engine pages');
        }
    } catch (error) {
        fail(`player-service pruning behavior check failed: ${error.message}`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

checkPlayerServicePruning();

// Local projects, secrets and caches stay outside the Docker build context.
// Source blobs enter the build as a directory; the final image is assembled
// from referenced runtime blobs only.
const dockerIgnoreFile = '.dockerignore';
const dockerIgnoreSource = readRequired(dockerIgnoreFile);
const dockerIgnoreEntries = new Set(
    splitLines(dockerIgnoreSource)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
);
for (const entry of [
    '.git',
    '**/node_modules',
    '**/.next',
    '.env',
    '.env.*',
    '!.env.docker.example',
    'apps/local-engine/projects/',
    'apps/local-engine/dist/',
    'apps/local-engine/.build-lock/',
    'apps/voxa/data/',
]) {
    if (!dockerIgnoreEntries.has(entry)) {
        fail(`${dockerIgnoreFile}: missing ${entry}`);
    }
}

const stageFile = 'apps/local-engine/src/stage-runtime-data.js';
const stageSource = readRequired(stageFile);
requirePattern(stageSource, stageFile, 'shared runtime resource staging', /copyRuntimeData/);
try {
    const { runtimeBlobHashes } = require('../apps/local-engine/src/runtime-assets');
    if (runtimeBlobHashes(root).size === 0) {
        fail('runtime resource closure is empty');
    }
} catch (error) {
    fail(`runtime resource closure: ${error.message}`);
}

const localConfig = JSON.parse(readRequired('apps/local-engine/config/local.config.json')).common;
for (const key of [
    'OSS_CDN_URL',
    'CREATERA_BACKEND_SERVER_URL',
    'INTRANET_CREATERA_BACKEND_SERVER_URL',
]) {
    if (localConfig[key] !== 'http://127.0.0.1:9966') {
        fail(`${key} must use the bundled local runtime by default`);
    }
}

const fullLocalConfig = JSON.parse(readRequired('apps/local-engine/config/local.config.json'));
if ((fullLocalConfig['game-server']?.SCRIPT_MEMORY_LIMIT || 0) < 512) {
    fail(
        'apps/local-engine/config/local.config.json: game-server.SCRIPT_MEMORY_LIMIT must support 512x256x512 maps',
    );
}
function checkEmptySecrets(value, prefix = '') {
    if (!value || typeof value !== 'object') {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        const qualified = prefix ? `${prefix}.${key}` : key;
        if (
            typeof child === 'string' &&
            /(?:PASSWORD|API_KEY|CERTIFICATE|PRIVATE_KEY|TOKEN_SECRET)$/.test(key) &&
            child !== ''
        ) {
            fail(`apps/local-engine/config/local.config.json: ${qualified} must be empty`);
        }
        checkEmptySecrets(child, qualified);
    }
}
checkEmptySecrets(fullLocalConfig);

const dockerEnvSource = readRequired('.env.docker.example');
for (const line of splitLines(dockerEnvSource)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (
        match &&
        /(?:PASSWORD|API_KEY|CERTIFICATE|PRIVATE_KEY|TOKEN_SECRET)$/.test(match[1]) &&
        match[2].trim() !== ''
    ) {
        fail(`.env.docker.example: ${match[1]} must not contain a real secret`);
    }
}

const blobDir = path.join(root, 'apps/local-engine/data/blobs');
if (!fs.existsSync(blobDir)) {
    fail('local runtime blob store is missing');
}
const blobCount = fs.existsSync(blobDir)
    ? fs.readdirSync(blobDir).filter((name) => name !== '.gitkeep').length
    : 0;
if (blobCount === 0) {
    fail('local runtime blob store is empty');
}

const avatarManifestPath = path.join(root, 'services/game-server/src/player/default-avatar.json');
if (fs.existsSync(avatarManifestPath)) {
    const avatarManifest = JSON.parse(fs.readFileSync(avatarManifestPath, 'utf8'));
    const avatarHashes = Object.values(avatarManifest.parts || {});
    if (avatarHashes.length !== 18) {
        fail('default avatar manifest must contain 18 body parts');
    }
    for (const hash of avatarHashes) {
        if (!fs.existsSync(path.join(blobDir, hash))) {
            fail(`missing bundled default avatar blob ${hash}`);
        }
    }
}

if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
} else {
    console.log(
        `Creator/play distribution check passed: ${packages.size} local modules, ${blobCount} bundled blobs`,
    );
}
