'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createDevelopmentEnvironment } = require('./dev-environment');
const { prepareDevelopmentData } = require('./dev-data');
const { developmentBuildPlan } = require('./workspace-projects');

const repoRoot = path.resolve(__dirname, '..');
const children = new Set();
const isWindows = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
const creatorOnly = args.has('--creator-only');
const includeAdmin = !args.has('--no-admin');
const gameRoot = path.join(repoRoot, 'apps/game');
const baseGameTsconfig = path.join(gameRoot, 'tsconfig.json');

if (fs.existsSync(path.join(repoRoot, '.env')) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path.join(repoRoot, '.env'));
}

// Ports are overridable so a second (dev) stack can run next to a deployment on
// the same host. Read after .env is loaded: the file itself may define them.
const port = (name, fallback) => Number(process.env[name] || fallback);
const PORTS = {
    playerService: port('BOX_DEV_PLAYER_SERVICE_PORT', 3124),
    creator: port('BOX_DEV_CREATOR_PORT', 3127),
    voxa: port('BOX_DEV_VOXA_PORT', 3123),
    portal: port('BOX_DEV_PORTAL_PORT', 3125),
    play: port('BOX_DEV_PLAY_PORT', 3121),
    playRuntime: port('BOX_DEV_PLAY_RUNTIME_PORT', 9966),
    editRuntime: port('BOX_DEV_EDIT_RUNTIME_PORT', 9967),
};

// Where the dev stack is reachable from. Defaults keep the classic loopback
// setup; a remote dev box sets BOX_DEV_HOST to its LAN/Tailscale IP and
// BOX_DEV_BIND=0.0.0.0 so a browser on another machine can log in.
const DEV_HOST = process.env.BOX_DEV_HOST || '127.0.0.1';
const DEV_BIND = process.env.BOX_DEV_BIND || '127.0.0.1';
const DEV_SCHEME = process.env.BOX_DEV_SCHEME || 'http';
const origin = (servicePort) => `${DEV_SCHEME}://${DEV_HOST}:${servicePort}`;

const sharedEnv = createDevelopmentEnvironment({
    repoRoot,
    inheritedEnv: process.env,
    useInfrastructure: args.has('--infra'),
});
// Public URLs drive cross-site login redirects, so they must point at the
// externally reachable origin, not loopback. Explicit values (for example a
// tunnel hostname) win over the derived host:port origin.
const publicURL = (name, servicePort) => process.env[name] || origin(servicePort);
const loopback = (servicePort) => `http://127.0.0.1:${servicePort}`;
const CREATOR_ORIGIN = publicURL('BOX_CREATOR_PUBLIC_URL', PORTS.creator);
const VOXA_ORIGIN = publicURL('BOX_VOXA_PUBLIC_URL', PORTS.voxa);
const PORTAL_ORIGIN = publicURL('BOX_AUTH_PORTAL_PUBLIC_URL', PORTS.portal);
Object.assign(sharedEnv, {
    BOX_WEB_HOST: DEV_BIND,
    // Internal calls must never fall through to a co-hosted deployment: the
    // default 3121-3127 ports belong to another stack on this host.
    BOX_PLAYER_SERVICE_INTERNAL_URL: loopback(PORTS.playerService),
    VOXA_INTERNAL_URL: loopback(PORTS.voxa),
    VOXA_URL: VOXA_ORIGIN,
    BOX_PLAYER_SERVICE_PUBLIC_URL: publicURL('BOX_PLAYER_SERVICE_PUBLIC_URL', PORTS.playerService),
    BOX_CREATOR_PUBLIC_URL: CREATOR_ORIGIN,
    BOX_PLAY_PUBLIC_URL: publicURL('BOX_PLAY_PUBLIC_URL', PORTS.play),
    BOX_VOXA_PUBLIC_URL: VOXA_ORIGIN,
    BOX_AUTH_PORTAL_PUBLIC_URL: PORTAL_ORIGIN,
    BOX_PLAYER_LOGIN_URL: process.env.BOX_PLAYER_LOGIN_URL || PORTAL_ORIGIN,
    BOX_VOXA_ALLOWED_ORIGINS: process.env.BOX_VOXA_ALLOWED_ORIGINS || [VOXA_ORIGIN, CREATOR_ORIGIN].join(','),
    BOX_RESOURCE_ALLOWED_ORIGINS: process.env.BOX_RESOURCE_ALLOWED_ORIGINS || [VOXA_ORIGIN, CREATOR_ORIGIN].join(','),
    BOX_PLAYER_AUTH_ALLOWED_ORIGINS: process.env.BOX_PLAYER_AUTH_ALLOWED_ORIGINS || PORTAL_ORIGIN,
    BOX_CREATOR_ALLOWED_HOSTS: process.env.BOX_CREATOR_ALLOWED_HOSTS || [DEV_HOST, '127.0.0.1', 'localhost'].join(','),
});

function prefixLines(prefix) {
    let buffered = '';
    return (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || '';
        for (const line of lines) {
            console.log(`[${prefix}] ${line}`);
        }
    };
}

function start(name, command, commandArgs, options = {}) {
    const child = spawn(command, commandArgs, {
        cwd: options.cwd || repoRoot,
        env: { ...sharedEnv, ...(options.env || {}) },
        stdio: ['inherit', 'pipe', 'pipe'],
    });
    children.add(child);
    child.stdout.on('data', prefixLines(name));
    child.stderr.on('data', prefixLines(name));
    child.once('exit', (code, signal) => {
        children.delete(child);
        if (!shuttingDown && code !== 0) {
            console.error(`[${name}] exited with ${signal || `code ${code}`}; stopping dev stack`);
            shutdown(code || 1);
        }
    });
    return child;
}

function stopChild(child) {
    if (child.exitCode !== null || child.signalCode) {
        return;
    }
    if (isWindows) {
        child.kill();
    } else {
        child.kill('SIGTERM');
    }
}

let shuttingDown = false;
function cleanupDevArtifacts() {
    for (const name of ['player-service', 'creator', 'play']) {
        fs.rmSync(path.join(gameRoot, `.tsconfig.dev-${name}.json`), { force: true });
    }
}

function shutdown(code = 0) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    for (const child of children) {
        stopChild(child);
    }
    setTimeout(() => {
        cleanupDevArtifacts();
        process.exit(code);
    }, 250);
}

function startInfrastructure() {
    if (!args.has('--infra')) {
        return;
    }
    const result = spawnSync(
        'docker',
        ['compose', '--profile', 'infra', 'up', '-d', 'postgres', 'redis'],
        { cwd: repoRoot, env: sharedEnv, stdio: 'inherit' },
    );
    if (result.error?.code === 'ENOENT') {
        throw new Error(
            '未找到 Docker。请安装并启动 Docker Desktop，或直接使用 rush dev 连接已有基础服务',
        );
    }
    if (result.status !== 0) {
        throw new Error('PostgreSQL/Redis 基础服务启动失败');
    }
}

function prepareGameTsconfigs() {
    const source = fs.readFileSync(baseGameTsconfig);
    for (const name of ['player-service', 'creator', 'play']) {
        fs.writeFileSync(path.join(gameRoot, `.tsconfig.dev-${name}.json`), source);
    }
}

try {
    console.log(`开发数据目录：${sharedEnv.BOX_DEV_DATA_DIRECTORY}`);
    prepareDevelopmentData(repoRoot, sharedEnv);
    for (const project of developmentBuildPlan(repoRoot)) {
        console.log(`准备开发依赖：${project.name}`);
        const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], {
            cwd: path.join(repoRoot, project.folder),
            env: sharedEnv,
            stdio: 'inherit',
            shell: isWindows,
        });
        if (result.error || result.status !== 0) {
            throw result.error || new Error(`开发依赖构建失败：${project.name}`);
        }
    }
    startInfrastructure();

    const localEngineRoot = path.join(repoRoot, 'apps/local-engine');
    const voxaRoot = path.join(repoRoot, 'apps/voxa');
    const portalRoot = path.join(repoRoot, 'apps/player-auth-portal');
    prepareGameTsconfigs();

    // Player Service uses the same Next source as Creator/Play, but an isolated
    // Next output directory prevents three dev servers from corrupting .next.
    start(
        'player-service',
        process.execPath,
        ['-r', 'ts-node/register', 'server/dev-server/index.ts', '--http', '--port', String(PORTS.playerService)],
        {
            cwd: gameRoot,
            env: {
                BOX_DEPLOYMENT_MODE: 'player-service',
                BOX_WEB_HOST: DEV_BIND,
                NEXT_PUBLIC_APP_ENV: 'development',
                NEXT_PUBLIC_APP_EDITION: 'createra',
                NEXT_PUBLIC_APP_REGION: 'cn',
                NEXT_DIST_DIR: '.next-player-service',
                NEXT_TSCONFIG_PATH: '.tsconfig.dev-player-service.json',
            },
        },
    );

    start(
        'creator',
        process.execPath,
        [path.join(localEngineRoot, 'src/launcher.js'), '--creator'],
        {
            env: {
                BOX_WEB_PORT: String(PORTS.creator),
                BOX_PLAY_RUNTIME_PORT: String(PORTS.playRuntime),
                BOX_EDIT_RUNTIME_PORT: String(PORTS.editRuntime),
                NEXT_DIST_DIR: '.next-creator',
                NEXT_TSCONFIG_PATH: '.tsconfig.dev-creator.json',
                BOX_DEPLOYMENT_MODE: 'creator',
            },
        },
    );

    if (!creatorOnly) {
        start('play', process.execPath, [path.join(localEngineRoot, 'src/launcher.js'), '--play'], {
            env: {
                BOX_WEB_PORT: String(PORTS.play),
                BOX_PLAY_RUNTIME_PORT: String(PORTS.playRuntime + 5),
                BOX_EDIT_RUNTIME_PORT: String(PORTS.editRuntime + 5),
                NEXT_DIST_DIR: '.next-play',
                NEXT_TSCONFIG_PATH: '.tsconfig.dev-play.json',
                BOX_DEPLOYMENT_MODE: 'play',
            },
        });
    }

    const nextExecutable = require.resolve('next/dist/bin/next', { paths: [voxaRoot] });
    start('voxa', process.execPath, [nextExecutable, 'dev', '-p', String(PORTS.voxa)], {
        cwd: voxaRoot,
        env: {
            BOX_PLAYER_SERVICE_INTERNAL_URL: loopback(PORTS.playerService),
            NEXT_DIST_DIR: '.next-voxa',
            PORT: String(PORTS.voxa),
        },
    });

    start(
        'auth-portal',
        process.execPath,
        ['--watch', '--import', 'tsx', 'scripts/tasks.ts', 'dev', '--live'],
        {
            cwd: portalRoot,
            env: {
                HOST: DEV_BIND,
                PORT: String(PORTS.portal),
                AUTH_DEMO_PLAYER_SERVICE_URL: origin(PORTS.playerService),
                AUTH_DEMO_PUBLIC_URL: PORTAL_ORIGIN,
                AUTH_DEMO_CREATOR_URL: CREATOR_ORIGIN,
                AUTH_DEMO_PLAY_URL: publicURL('BOX_PLAY_PUBLIC_URL', PORTS.play),
                AUTH_DEMO_API_KEY: sharedEnv.BOX_PLAYER_AUTH_API_KEY,
                AUTH_DEMO_REGISTRATION_ENABLED: 'true',
            },
        },
    );

    if (includeAdmin) {
        const adminRoot = path.join(repoRoot, 'apps/player-admin');
        const executable = path.join(
            path.dirname(require.resolve('@umijs/max/package.json', { paths: [adminRoot] })),
            'bin/max.js',
        );
        start('player-admin', process.execPath, [executable, 'dev'], {
            cwd: adminRoot,
            env: { PORT: '8000', PLAYER_ADMIN_DEV_API_URL: 'http://127.0.0.1:3124' },
        });
    }

    console.log('\n开发服务已启动：');
    console.log('  Creator        http://127.0.0.1:3127/');
    if (!creatorOnly) {
        console.log('  Play           http://127.0.0.1:3121/');
    }
    console.log('  VOXA           http://127.0.0.1:3123/');
    console.log('  Player Service http://127.0.0.1:3124/');
    console.log('  Auth Portal    http://127.0.0.1:3125/');
    if (includeAdmin) {
        console.log('  Player Admin   http://127.0.0.1:8000/');
    }
    console.log(
        '\n按 Ctrl-C 停止源码服务。默认不会启动或停止 Docker 基础服务；需要时使用 rush dev --infra。',
    );
} catch (error) {
    console.error(`开发服务启动失败：${error.message}`);
    shutdown(1);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
