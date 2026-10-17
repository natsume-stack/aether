'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { frontendSource, querySelectorCallback } = require('./lib/deployment-manager-source');

const root = path.resolve(__dirname, '..');
const rootVersion = require(path.join(root, 'package.json')).version;
const manager = path.join(root, 'apps/deployment-manager');
const frontend = frontendSource(root);
const backendSourceDirectory = path.join(manager, 'src-tauri/src');
const desktopBackend = fs
    .readdirSync(backendSourceDirectory)
    .filter((file) => file.endsWith('.rs'))
    .sort()
    .map((file) => fs.readFileSync(path.join(backendSourceDirectory, file), 'utf8'))
    .join('\n');
const sharedDirectory = path.join(root, 'apps/manager-core/src');
const sharedBackend = fs
    .readdirSync(sharedDirectory)
    .filter((file) => file.endsWith('.rs'))
    .sort()
    .map((file) => fs.readFileSync(path.join(sharedDirectory, file), 'utf8'))
    .join('\n');
const backend = desktopBackend + '\n' + sharedBackend;
const serverManagerSourceDirectory = path.join(root, 'apps/server-manager-rust/src');
const serverManager = fs
    .readdirSync(serverManagerSourceDirectory, { recursive: true })
    .filter((file) => file.endsWith('.rs'))
    .sort()
    .map((file) => fs.readFileSync(path.join(serverManagerSourceDirectory, file), 'utf8'))
    .join('\n');
const defaults = fs.readFileSync(path.join(manager, 'src-tauri/defaults.env'), 'utf8');
const styles = frontendSource(root, '.css');
const tauriConfig = fs.readFileSync(path.join(manager, 'src-tauri/tauri.conf.json'), 'utf8');
const tauriEntry = fs.readFileSync(path.join(manager, 'src-tauri/src/main.rs'), 'utf8');
const tauriBuild = fs.readFileSync(path.join(manager, 'src-tauri/build.rs'), 'utf8');
const tauriConfiguration = JSON.parse(tauriConfig);
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'apps/local-engine/src/launcher.js'), 'utf8');
const builder = fs.readFileSync(
    path.join(root, 'scripts/build-desktop-offline-installer.js'),
    'utf8',
);
const headlessBuilder = fs.readFileSync(
    path.join(root, 'scripts/build-headless-server-package.js'),
    'utf8',
);
const packageVerifier = fs.readFileSync(
    path.join(root, 'scripts/verify-desktop-offline-package.js'),
    'utf8',
);
const creatorWorkCenter = fs.readFileSync(
    path.join(root, 'apps/game/pages/projects/index.tsx'),
    'utf8',
);
const playWorkCenter = fs.readFileSync(path.join(root, 'apps/game/pages/index.tsx'), 'utf8');
const localEngineLauncher = fs.readFileSync(
    path.join(root, 'apps/local-engine/src/launcher.js'),
    'utf8',
);
const projectManager = fs.readFileSync(
    path.join(root, 'apps/local-engine/src/project-manager.js'),
    'utf8',
);
const playerIdentity = fs.readFileSync(
    path.join(root, 'apps/game/server/local-player-identity.ts'),
    'utf8',
);
const authPortalServer = fs
    .readdirSync(path.join(root, 'apps/player-auth-portal/server'), { recursive: true })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => fs.readFileSync(path.join(root, 'apps/player-auth-portal/server', file), 'utf8'))
    .join('\n');

for (const file of [
    'package.json',
    'index.html',
    'src/main.js',
    'src/styles.css',
    'src-tauri/Cargo.toml',
    'src-tauri/tauri.conf.json',
    'src-tauri/src/config.rs',
    'src-tauri/src/commands.rs',
    'src-tauri/src/docker.rs',
    'src-tauri/src/lib.rs',
    'src-tauri/build.rs',
    'src-tauri/defaults.env',
]) {
    assert.ok(
        fs.statSync(path.join(manager, file)).isFile(),
        `missing deployment manager file: ${file}`,
    );
}

assert.match(tauriBuild, /BOX_ROOT_VERSION/);
assert.match(desktopBackend, /BOX3 Engine Launcher v\{ROOT_VERSION\}/);
assert.equal(tauriConfiguration.version, rootVersion);

for (const value of [
    '总览',
    '数据配置',
    '性能监控',
    '关于',
    '数据服务',
    '访问设置',
    '运行容量',
    'PostgreSQL',
    'Redis',
]) {
    assert.ok(frontend.includes(value), `deployment UI is missing ${value}`);
}
assert.match(frontend, /内置数据库/);
assert.match(frontend, /外部数据库/);
assert.match(
    frontend,
    /async function copyText\(value\)/,
    'deployment manager needs a Web-compatible clipboard helper',
);
assert.match(frontend, /document\.execCommand\('copy'\)/);
assert.match(frontend, /databaseMode/);
assert.match(frontend, /启用并启动/);
assert.match(frontend, /PostgreSQL 16/);
assert.match(frontend, /内置 Redis/);
assert.match(frontend, /外部 Redis/);
assert.match(frontend, /不启用/);
assert.match(frontend, /立即下载/);
const databaseModeHandler = querySelectorCallback(frontend, '[data-database-mode]');
assert.ok(databaseModeHandler, 'missing database mode switch handler');
assert.doesNotMatch(databaseModeHandler, /databaseHost\s*=(?!=)/);
const redisModeHandler = querySelectorCallback(frontend, '[data-redis-mode]');
assert.ok(redisModeHandler, 'missing Redis mode switch handler');
assert.doesNotMatch(redisModeHandler, /redisHost\s*=(?!=)/);
assert.match(
    styles,
    /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\):not\(\[data-theme='dark'\]\) \{\s*color-scheme: dark;/,
);
assert.match(backend, /database_mode/);
assert.match(backend, /has_managed_database_image/);
assert.match(backend, /prepare_managed_database/);
assert.match(backend, /redis_mode/);
assert.match(backend, /has_managed_redis_image/);
assert.match(backend, /prepare_managed_redis/);
assert.match(frontend, /prepare_managed_redis/);
assert.match(frontend, /get_managed_service_info/);
assert.match(frontend, /start_managed_service/);
assert.match(frontend, /managed-postgres/);
assert.match(frontend, /managed-redis/);
assert.match(frontend, /async function refreshManagedServiceInfo\(\)/);
assert.match(frontend, /if \(state\.page === 'setup'\) \{\s*refreshManagedServiceInfo\(\)/);
assert.match(backend, /MANAGED_SERVICE_NAMES\.contains\(&service\)/);
assert.match(backend, /managed_service_installed\(app, service\)/);
assert.match(backend, /fn managed_database_identity\(/);
assert.match(backend, /format!\("box_db_\{\}", random_hex\(8\)\)/);
assert.match(backend, /format!\("box_user_\{\}", random_hex\(8\)\)/);
assert.match(backend, /managed_database_volume_exists\(\)/);
assert.match(frontend, /stage: 'managed-preflight'/);
assert.match(frontend, /progress-backdrop/);
assert.match(frontend, /这可能需要几分钟，请耐心等待/);
assert.match(styles, /@keyframes managed-download-progress/);
assert.doesNotMatch(frontend, /managedDatabaseConfigured/);
assert.doesNotMatch(frontend, /managed-pool-field/);
assert.match(backend, /if database_mode == "managed" \{\s*10\s*\} else/);
assert.doesNotMatch(frontend, /managedRedisConfigured/);
assert.doesNotMatch(frontend, /managed-redis-allocation/);
assert.match(frontend, /\['业务 DB', info\.database\]/);
assert.match(frontend, /\['缓存 DB', '1'\]/);
assert.doesNotMatch(styles, /\.managed-redis-allocation/);
assert.match(backend, /if redis_mode == "managed" \{\s*\(0, 1, 240\)/);
const installConfigInput = desktopBackend.match(/struct InstallConfigInput \{[\s\S]*?\n\}/)?.[0];
assert.ok(installConfigInput, 'missing InstallConfigInput contract');
const normalizedConfigBody = frontend.match(/function normalizedConfig\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(normalizedConfigBody, 'missing normalizedConfig implementation');
assert.match(normalizedConfigBody, /for \(const key of numericConfigFields\)/);
assert.match(frontend, /function normalizeInactiveServicePorts\(config\)/);
assert.match(
    frontend,
    /if \(config\.databaseMode !== 'external'\) \{\s*config\.databasePort = '5432'/,
);
assert.match(frontend, /if \(config\.redisMode !== 'external'\) \{\s*config\.redisPort = '6379'/);
assert.match(normalizedConfigBody, /normalizeInactiveServicePorts\(config\)/);
const saveConfigurationBody = frontend.match(
    /async function saveConfiguration\(event\) \{[\s\S]*?\n\}/,
)?.[0];
assert.ok(saveConfigurationBody, 'missing saveConfiguration implementation');
assert.match(saveConfigurationBody, /normalizeInactiveServicePorts\(config\)/);
assert.match(
    backend,
    /config\.creator_host = public_host\.clone\(\)/,
    'the backend must derive the shared host from the explicit public address',
);
const numericConfigFields = frontend.match(/const numericConfigFields = \[[\s\S]*?\n\]/)?.[0];
assert.ok(numericConfigFields, 'missing numericConfigFields contract');
const snakeToCamel = (value) => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
for (const [, field] of installConfigInput.matchAll(/^\s+(\w+): (?:u8|u16|u32|f64),$/gm)) {
    const frontendField = snakeToCamel(field);
    assert.match(
        numericConfigFields,
        new RegExp(`['"]${frontendField}['"]`),
        `normalizedConfig must convert numeric field ${frontendField}`,
    );
}
assert.match(compose, /managed-redis:/);
assert.match(compose, /profiles: \[desktop-redis\]/);
assert.match(compose, /docker\.m\.daocloud\.io\/library\/redis:7-alpine/);
assert.match(backend, /docker\.m\.daocloud\.io\/library\/redis:7-alpine/);
assert.match(compose, /box-managed-redis-data:\/data/);
assert.match(
    compose.match(/ {2}managed-redis:[\s\S]*?\n {2}managed-postgres:/)?.[0] || '',
    /127\.0\.0\.1:\$\{BOX_MANAGED_REDIS_HOST_PORT:-6379\}:6379/,
);
assert.match(compose, /BOX_MANAGED_REDIS_MEMORY_LIMIT:-256m/);
assert.match(compose, /managed-postgres:/);
assert.match(compose, /profiles: \[desktop-postgres\]/);
assert.match(compose, /docker\.m\.daocloud\.io\/library\/postgres:16-alpine/);
assert.match(backend, /docker\.m\.daocloud\.io\/library\/postgres:16-alpine/);
assert.match(compose, /box-managed-postgres-data:\/var\/lib\/postgresql\/data/);
assert.match(
    compose.match(/ {2}managed-postgres:[\s\S]*?\n {2}postgres:/)?.[0] || '',
    /127\.0\.0\.1:\$\{BOX_MANAGED_POSTGRES_HOST_PORT:-5432\}:5432/,
);
assert.match(compose, /BOX_MANAGED_POSTGRES_MEMORY_LIMIT:-512m/);
assert.match(
    compose.match(/ {2}play:[\s\S]*?\n {2}voxa:/)?.[0] || '',
    /apps\/local-engine\/data:\/app\/apps\/local-engine\/data(?:"|\s)/,
    'Play must mount the Desktop-managed runtime data directory',
);
const playService = compose.match(/ {2}play:[\s\S]*?\n {2}voxa:/)?.[0] || '';
assert.match(playService, /server-manager:[\s\S]*?condition: service_healthy/);
assert.match(playService, /BOX_RUNTIME_MANAGER_URL:/);
assert.match(playService, /BOX_RUNTIME_MANAGER_TOKEN:/);
assert.match(serverManager, /box-local-engine-play:\{tag\}/);
assert.match(serverManager, /\/app\/world:ro/);
assert.match(serverManager, /--cpus/);
assert.match(serverManager, /--memory/);
assert.match(serverManager, /runtime_network\(\)/);
assert.doesNotMatch(
    serverManager.match(
        /async fn ensure_runtime_container[\s\S]*?async fn delete_runtime_container/,
    )?.[0] || '',
    /box-local-engine-creator:/,
    'published Play isolation must never start a Creator image',
);
assert.match(compose, /PGPASSWORD=.*psql .*SELECT 1/);
assert.match(compose, /BOX_VOXA_MEMORY_LIMIT:-1g/);
// The headless package builder extracts the managed services from the shared
// docker-compose.yml, so its source legitimately references those section names.
assert.match(headlessBuilder, /function serviceSection\(source, start, end\)/);
assert.match(
    headlessBuilder,
    /const source = fs\.readFileSync\(path\.join\(repoRoot, 'docker-compose\.yml'\), 'utf8'\)/,
);
assert.doesNotMatch(builder, /postgres:16-alpine/);
assert.match(builder, /--norsrc/);
assert.match(defaults, /^BOX_PLAY_PUBLIC_HOST=127\.0\.0\.1$/m);
assert.match(defaults, /^BOX_CREATOR_HOST=127\.0\.0\.1$/m);
assert.match(defaults, /^BOX_DATABASE_HOST=$/m);
assert.match(defaults, /^BOX_DATABASE_MODE=managed$/m);
assert.match(defaults, /^BOX_DATABASE_PASSWORD=$/m);
assert.doesNotMatch(defaults, /^COMPOSE_PROFILES=/m);
assert.doesNotMatch(defaults, /^BOX_DATABASE_URL=/m);
assert.doesNotMatch(defaults, /^BOX_IMAGE_TAG=/m);
assert.doesNotMatch(defaults, /^BOX_.*PUBLIC_URL=/m);
assert.doesNotMatch(defaults, /^BOX_CREATOR_PLAY_PREWARM_RUNTIMES=/m);
assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'distribution/server/.env.example'), 'utf8'),
    /^BOX_CREATOR_PLAY_PREWARM_RUNTIMES=/m,
);
assert.match(defaults, /^REDIS_HOST=$/m);
assert.match(defaults, /^BOX_REDIS_MODE=disabled$/m);
for (const [name, value] of [
    ['BOX_LOCAL_PLAYER_LIMIT', '70'],
    ['BOX_CREATOR_EDIT_PREWARM_RUNTIMES', '0'],
    ['BOX_PLAY_PREWARM_RUNTIMES', '0'],
    ['BOX_SCRIPT_HEAP_MB', '512'],
    ['BOX_SCRIPT_MEMORY_MB', '512'],
    ['BOX_RUNTIME_IDLE_TIMEOUT_MS', '900000'],
    ['BOX_RUNTIME_START_TIMEOUT_MS', '1800000'],
    ['BOX_TELEPORT_MAX_ROOMS', '64'],
    ['BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS', '900000'],
    ['BOX_PLAYER_REGISTRATION_ENABLED', 'true'],
    ['BOX_PLAYER_SERVICE_MEMORY_LIMIT', '1g'],
    ['BOX_PLAYER_SERVICE_CPU_LIMIT', '1.0'],
    ['BOX_AUTH_PORTAL_MEMORY_LIMIT', '128m'],
    ['BOX_AUTH_PORTAL_CPU_LIMIT', '0.5'],
    ['BOX_CREATOR_MEMORY_LIMIT', '6g'],
    ['BOX_CREATOR_CPU_LIMIT', '2.0'],
    ['BOX_PLAY_MEMORY_LIMIT', '4g'],
    ['BOX_PLAY_CPU_LIMIT', '2.0'],
    ['BOX_DATABASE_POOL_SIZE', '4'],
    ['STORAGE_CACHE_REDIS_TTL', '240'],
]) {
    assert.match(defaults, new RegExp(`^${name}=${value}$`, 'm'));
    assert.match(backend, new RegExp(`"${name}"`));
}

// A setting appearing in the manager backend is not enough: it must also
// cross the Compose boundary and reach code that uses it. Keep this table
// explicit so a newly added UI option cannot silently become a no-op.
for (const [name, composePattern, consumer, consumerPattern] of [
    [
        'BOX_LOCAL_PLAYER_LIMIT',
        /BOX_LOCAL_PLAYER_LIMIT: \$\{BOX_LOCAL_PLAYER_LIMIT:-70\}/,
        localEngineLauncher,
        /process\.env\.BOX_LOCAL_PLAYER_LIMIT/,
    ],
    [
        'BOX_PLAY_MAX_RUNTIMES',
        /BOX_PLAY_MAX_RUNTIMES: \$\{BOX_PLAY_MAX_RUNTIMES:-8\}/,
        localEngineLauncher,
        /process\.env\.BOX_PLAY_MAX_RUNTIMES/,
    ],
    [
        'BOX_CREATOR_EDIT_MAX_RUNTIMES',
        /BOX_CREATOR_EDIT_MAX_RUNTIMES: \$\{BOX_CREATOR_EDIT_MAX_RUNTIMES:-6\}/,
        localEngineLauncher,
        /process\.env\.BOX_CREATOR_EDIT_MAX_RUNTIMES/,
    ],
    [
        'BOX_CREATOR_PLAY_MAX_RUNTIMES',
        /BOX_CREATOR_PLAY_MAX_RUNTIMES: \$\{BOX_CREATOR_PLAY_MAX_RUNTIMES:-4\}/,
        localEngineLauncher,
        /process\.env\.BOX_CREATOR_PLAY_MAX_RUNTIMES/,
    ],
    [
        'BOX_CREATOR_EDIT_PREWARM_RUNTIMES',
        /BOX_CREATOR_EDIT_PREWARM_RUNTIMES: \$\{BOX_CREATOR_EDIT_PREWARM_RUNTIMES:-0\}/,
        localEngineLauncher,
        /['"]BOX_CREATOR_EDIT_PREWARM_RUNTIMES['"]/,
    ],
    [
        'BOX_PLAY_PREWARM_RUNTIMES',
        /BOX_PLAY_PREWARM_RUNTIMES: \$\{BOX_PLAY_PREWARM_RUNTIMES:-0\}/,
        localEngineLauncher,
        /['"]BOX_PLAY_PREWARM_RUNTIMES['"]/,
    ],
    [
        'BOX_SCRIPT_HEAP_MB',
        /BOX_SCRIPT_HEAP_MB: \$\{BOX_SCRIPT_HEAP_MB:-512\}/,
        localEngineLauncher,
        /process\.env\.BOX_SCRIPT_HEAP_MB/,
    ],
    [
        'BOX_SCRIPT_MEMORY_MB',
        /SCRIPT_MEMORY_LIMIT: \$\{BOX_SCRIPT_MEMORY_MB:-512\}/,
        localEngineLauncher,
        /process\.env\.BOX_SCRIPT_MEMORY_MB/,
    ],
    [
        'BOX_RUNTIME_IDLE_TIMEOUT_MS',
        /BOX_RUNTIME_IDLE_TIMEOUT_MS: \$\{BOX_RUNTIME_IDLE_TIMEOUT_MS:-900000\}/,
        localEngineLauncher,
        /process\.env\.BOX_RUNTIME_IDLE_TIMEOUT_MS/,
    ],
    [
        'BOX_RUNTIME_START_TIMEOUT_MS',
        /BOX_RUNTIME_START_TIMEOUT_MS: \$\{BOX_RUNTIME_START_TIMEOUT_MS:-1800000\}/,
        localEngineLauncher,
        /process\.env\.BOX_RUNTIME_START_TIMEOUT_MS/,
    ],
    [
        'BOX_TELEPORT_MAX_ROOMS',
        /BOX_TELEPORT_MAX_ROOMS: \$\{BOX_TELEPORT_MAX_ROOMS:-64\}/,
        localEngineLauncher,
        /process\.env\.BOX_TELEPORT_MAX_ROOMS/,
    ],
    [
        'BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS',
        /BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS: \$\{BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS:-900000\}/,
        localEngineLauncher,
        /process\.env\.BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS/,
    ],
    [
        'BOX_DATABASE_POOL_SIZE',
        /BOX_DATABASE_POOL_SIZE: \$\{BOX_DATABASE_POOL_SIZE:-4\}/,
        playerIdentity,
        /process\.env\.BOX_DATABASE_POOL_SIZE/,
    ],
    [
        'BOX_AUTO_BACKUP_ENABLED',
        /BOX_AUTO_BACKUP_ENABLED: \$\{BOX_AUTO_BACKUP_ENABLED:-false\}/,
        projectManager,
        /process\.env\.BOX_AUTO_BACKUP_ENABLED/,
    ],
    [
        'BOX_AUTO_BACKUP_INTERVAL_MINUTES',
        /BOX_AUTO_BACKUP_INTERVAL_MINUTES: \$\{BOX_AUTO_BACKUP_INTERVAL_MINUTES:-60\}/,
        projectManager,
        /process\.env\.BOX_AUTO_BACKUP_INTERVAL_MINUTES/,
    ],
    [
        'BOX_AUTO_BACKUP_RETENTION_COUNT',
        /BOX_AUTO_BACKUP_RETENTION_COUNT: \$\{BOX_AUTO_BACKUP_RETENTION_COUNT:-24\}/,
        projectManager,
        /process\.env\.BOX_AUTO_BACKUP_RETENTION_COUNT/,
    ],
    [
        'BOX_AUTO_BACKUP_RETENTION_DAYS',
        /BOX_AUTO_BACKUP_RETENTION_DAYS: \$\{BOX_AUTO_BACKUP_RETENTION_DAYS:-30\}/,
        projectManager,
        /process\.env\.BOX_AUTO_BACKUP_RETENTION_DAYS/,
    ],
    [
        'BOX_PLAYER_REGISTRATION_ENABLED',
        /BOX_PLAYER_REGISTRATION_ENABLED: \$\{BOX_PLAYER_REGISTRATION_ENABLED:-true\}/,
        playerIdentity,
        /process\.env\.BOX_PLAYER_REGISTRATION_ENABLED/,
    ],
    [
        'AUTH_DEMO_REGISTRATION_ENABLED',
        /AUTH_DEMO_REGISTRATION_ENABLED: \$\{BOX_PLAYER_REGISTRATION_ENABLED:-true\}/,
        authPortalServer,
        /AUTH_DEMO_REGISTRATION_ENABLED/,
    ],
]) {
    assert.match(compose, composePattern, `${name} is not forwarded by Compose`);
    assert.match(consumer, consumerPattern, `${name} has no runtime consumer`);
}

for (const [name, pattern] of [
    ['BOX_PLAYER_SERVICE_MEMORY_LIMIT', /mem_limit: \$\{BOX_PLAYER_SERVICE_MEMORY_LIMIT:-1g\}/],
    ['BOX_PLAYER_SERVICE_CPU_LIMIT', /cpus: \$\{BOX_PLAYER_SERVICE_CPU_LIMIT:-1\.0\}/],
    ['BOX_AUTH_PORTAL_MEMORY_LIMIT', /mem_limit: \$\{BOX_AUTH_PORTAL_MEMORY_LIMIT:-128m\}/],
    ['BOX_AUTH_PORTAL_CPU_LIMIT', /cpus: \$\{BOX_AUTH_PORTAL_CPU_LIMIT:-0\.5\}/],
    ['BOX_CREATOR_MEMORY_LIMIT', /mem_limit: \$\{BOX_CREATOR_MEMORY_LIMIT:-6g\}/],
    ['BOX_CREATOR_CPU_LIMIT', /cpus: \$\{BOX_CREATOR_CPU_LIMIT:-2\.0\}/],
    ['BOX_PLAY_MEMORY_LIMIT', /mem_limit: \$\{BOX_PLAY_MEMORY_LIMIT:-4g\}/],
    ['BOX_PLAY_CPU_LIMIT', /cpus: \$\{BOX_PLAY_CPU_LIMIT:-2\.0\}/],
]) {
    assert.match(compose, pattern, `${name} does not control a Docker resource limit`);
}
for (const field of [
    'playerLimit',
    'runtimeIdleMinutes',
    'runtimeStartTimeoutMinutes',
    'teleportMaxRooms',
    'teleportRoomIdleMinutes',
    'creatorEditPrewarmRuntimes',
    'playPrewarmRuntimes',
    'scriptMemoryMb',
    'databasePoolSize',
    'storageCacheRedisTtl',
    'playerServiceMemoryMb',
    'playerServiceCpuLimit',
    'authPortalMemoryMb',
    'authPortalCpuLimit',
    'creatorMemoryMb',
    'creatorCpuLimit',
    'playMemoryMb',
    'playCpuLimit',
]) {
    assert.match(frontend, new RegExp(`(?:input|field)\\('${field}'`));
}
assert.match(frontend, /运行时空闲回收（分钟）/);
assert.match(frontend, /Teleport 私有房间上限/);
assert.match(backend, /fn minutes_to_milliseconds/);
assert.match(frontend, /允许新玩家注册/);
assert.match(backend, /"BOX_SCRIPT_HEAP_MB"[\s\S]*?"BOX_SCRIPT_MEMORY_MB"/);
assert.match(frontend, /PostgreSQL<\/h2>/);
assert.match(backend, /外部 PostgreSQL 模式必须配置数据库地址后才能启动服务/);
assert.match(
    backend,
    /if database_mode == "external"[\s\S]*?check_remote_endpoint\(" PostgreSQL", &database_host, database_port\)/,
);
assert.match(
    backend,
    /if redis_mode == "external"[\s\S]*?check_remote_endpoint\(" Redis", &redis_host, redis_port\)/,
);
assert.match(backend, /Applications\/Docker\.app\/Contents\/Resources\/bin\/docker/);
assert.ok(backend.includes(String.raw`r"C:\Program Files\Docker\Docker\resources\bin\docker.exe"`));
assert.match(backend, /fn unavailable_message/);
assert.match(backend, /fn synchronize_runtime_image_tag/);
assert.match(backend, /fn runtime_env_path/);
assert.match(backend, /fn generate_runtime_environment/);
assert.match(backend, /runtime_env_path\(app\)/);
assert.match(backend, /synchronize_runtime_image_tag\(app\)\?;/);
assert.doesNotMatch(
    backend,
    /请把 box-local-engine-images-\*-\{expected\}\.tar\.gz 与程序放在同一目录/,
);
assert.doesNotMatch(backend, /Command::new\("docker"\)\.args/);
assert.match(frontend, /data-setup-section/);
assert.match(frontend, /captureSetupForm/);
// A setup-tab click is registered after the raw .env handlers. Keep those
// handlers top-level: nesting either in saveConfiguration makes bindEvents
// throw a ReferenceError and leaves every later setup tab inert.
assert.match(
    frontend,
    /async function saveConfiguration\(event\)[\s\S]*?\n}\n\n(?:export )?async function saveRawEnvironment\(\)/,
);
assert.match(frontend, /function switchSetupSection\(section\)/);
for (const mode of ['local', 'lan', 'public-shared', 'public-independent']) {
    assert.ok(frontend.includes(`['${mode}',`), `access selector must include ${mode}`);
}
assert.equal(
    (frontend.match(/data-network-mode=/g) || []).length,
    1,
    'access scope must use one generated selector for all modes',
);
assert.doesNotMatch(frontend, /data-(?:play|creator)-network-mode=/);
assert.match(
    frontend,
    /name="creatorNetworkMode" type="hidden" value="\$\{state\.accessMode \? accessMode : config\.creatorNetworkMode \|\| accessMode\}"/,
);
assert.match(frontend, /config\.creatorHost = config\.publicHost/);
assert.match(frontend, /name="publicAddressMode" type="hidden"/);
assert.match(frontend, /config\.publicAddress = primaryAddress/);
assert.doesNotMatch(frontend, /创作端访问地址/);
assert.doesNotMatch(frontend, /不建议直接向公网开放创作端/);
assert.match(frontend, /name="playNetworkMode" type="hidden" value="\$\{accessMode\}"/);
assert.match(frontend, /state\.config\.playNetworkMode = isPublicMode\(mode\) \? 'public' : mode/);
assert.match(
    frontend,
    /state\.config\.creatorNetworkMode = isPublicMode\(mode\) \? 'public' : mode/,
);
assert.match(frontend, /creatorNetworkMode: isPublicMode\(state\.accessMode\)/);
assert.match(frontend, /function accessChoice\(/);
assert.doesNotMatch(sharedBackend, /游玩端与创作端必须使用相同的访问范围/);
assert.match(backend, /fn detect_lan_ip/);
for (const port of ['playPort', 'voxaPort', 'creatorPort', 'playerServicePort', 'authPortalPort']) {
    assert.match(frontend, new RegExp(`portInput\\('${port}'`));
}
assert.match(backend, /不能使用同一个端口/);
assert.match(backend, /BOX_AUTH_PORTAL_PORT/);
assert.match(compose, /VOXA_URL: \$\{BOX_VOXA_PUBLIC_URL/);
assert.match(compose, /\n {6}BOX_VOXA_PUBLIC_URL: \$\{BOX_VOXA_PUBLIC_URL/);
assert.match(compose, /BOX_RESOURCE_ALLOWED_ORIGINS: \$\{BOX_RESOURCE_ALLOWED_ORIGINS:-\}/);
assert.match(launcher, /process\.env\.VOXA_URL/);
assert.match(backend, /只允许打开当前配置中的 BOX 服务地址/);
assert.doesNotMatch(backend, /只允许打开本机 BOX 服务地址/);
assert.match(frontend, /box-manager-theme/);
assert.match(frontend, /跟随系统/);
assert.match(frontend, /发行许可/);
assert.match(frontend, /发行许可证/);
assert.match(frontend, /get_legal_notices/);
assert.match(backend, /fn get_legal_notices/);
assert.match(backend, /include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/distribution\/LICENSE\.txt"\)/);
assert.match(frontend, /data-open-legal-document/);
assert.match(frontend, /function legalDocumentDialog\(\)/);
assert.match(styles, /\.about-document-row/);
assert.match(styles, /\.legal-dialog/);
assert.match(frontend, /data-theme-choice/);
assert.match(frontend, /get_performance_status/);
assert.match(frontend, /choose-data-storage/);
assert.match(frontend, /relocate_data_storage/);
assert.doesNotMatch(frontend, /环境检查/);
assert.doesNotMatch(frontend, /managementPage/);
assert.doesNotMatch(frontend, /navItem\('projects'/);
assert.doesNotMatch(frontend, /navItem\('players'/);
assert.doesNotMatch(styles, /\.embedded-page/);
assert.doesNotMatch(frontend, /run_environment_checks/);
assert.match(frontend, /test_remote_connection/);
assert.match(frontend, /data-service-action/);
assert.match(frontend, /export_diagnostics/);
assert.match(backend, /fn is_sensitive_env_key/);
assert.match(backend, /\[REDACTED\]/);
assert.match(backend, /async fn control_service/);
assert.match(backend, /async fn relocate_data_storage/);
assert.match(backend, /请先在服务总览停止全部服务，再迁移数据目录/);
assert.match(frontend, /OVERVIEW_POLL_MS = 10000/);
assert.match(frontend, /OVERVIEW_HIDDEN_POLL_MS = 60000/);
assert.match(frontend, /PERFORMANCE_POLL_MS = 5000/);
assert.match(frontend, /PERFORMANCE_HIDDEN_POLL_MS = 30000/);
assert.match(backend, /"stats",\s*"--no-stream"/);
assert.match(styles, /:root\[data-theme='light'\]/);
assert.match(styles, /:root\[data-theme='dark'\]/);
assert.doesNotMatch(creatorWorkCenter, /href="\/system"/);
assert.doesNotMatch(playWorkCenter, /href="\/play-system"/);
assert.match(styles, /html,\s*body,\s*#app[\s\S]*overflow: hidden/);
assert.match(styles, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
assert.doesNotMatch(styles, /\.help-layout/);
assert.doesNotMatch(defaults, /^BOX_POSTGRES_/m);
assert.doesNotMatch(defaults, /^BOX_REDIS_IMAGE=/m);
assert.match(backend, /REDIS_HOST/);
assert.match(backend, /BOX_DATABASE_URL/);
assert.match(backend, /Random|OsRng/);
assert.match(builder, /windows-amd64/);
assert.match(builder, /windows-arm64/);
assert.match(builder, /macos-amd64/);
assert.match(builder, /macos-arm64/);
assert.match(builder, /linux-amd64/);
assert.match(builder, /linux-arm64/);
assert.match(builder, /platform\.endsWith\('arm64'\) \? 'arm64' : 'amd64'/);
assert.match(builder, /validateCatalog/);
assert.match(builder, /const packageMode = \{\s*mode: local \? 'local' : 'slim'/);
assert.match(builder, /BOX-OFFLINE-IMAGE\.json/);
assert.match(builder, /const imageDetails = imageManifest\.images/);
assert.match(builder, /Contents\/Resources\/payload\/metadata/);
assert.match(builder, /ensureMacApplicationSignature/);
assert.match(builder, /CodeResources/);
assert.match(builder, /generateDistributionMetadata\(metadataRoot/);
assert.match(builder, /Metadata must become a resource[\s\S]*?before that step/);
assert.doesNotMatch(builder, /开始使用\.txt/);
assert.match(builder, /BOX_ALLOW_DIRTY_RELEASE/);
assert.match(builder, /BOX_BUILD_COMMIT/);
assert.match(builder, /BOX_BUILD_DATE/);
assert.match(builder, /verify-desktop-offline-package\.js/);
assert.match(packageVerifier, /BOX-OFFLINE-IMAGE\.json/);
assert.match(packageVerifier, /CodeResources/);
assert.match(packageVerifier, /BOX_DESKTOP_REQUIRE_SIGNING/);
assert.match(packageVerifier, /THIRD-PARTY-NOTICES\.json/);
assert.match(packageVerifier, /SHA-256 不匹配/);
assert.match(packageVerifier, /function findMetadataRoot/);
assert.match(packageVerifier, /codesign', \['--verify', '--deep', '--strict'/);
assert.match(builder, /if \(local && spec\.bundle\) \{[\s\S]*?fs\.copyFileSync\(archive/);
assert.match(
    builder,
    /BOX_MANAGER_REMOTE_IMAGE: local \? undefined : JSON\.stringify\(imageManifest\)/,
);
assert.match(builder, /BOX_MANAGER_REMOTE_IMAGE/);
assert.match(packageVerifier, /rejectEmbeddedArchives/);
assert.deepEqual(tauriConfiguration.bundle.resources, ['payload']);
assert.deepEqual(tauriConfiguration.bundle.icon, ['icons/icon.ico', 'icons/icon.icns']);
assert.match(tauriEntry, /windows_subsystem = "windows"/);
const windowsIcon = path.join(manager, 'src-tauri/icons/icon.ico');
assert.ok(fs.statSync(windowsIcon).isFile(), 'missing Windows application icon');
assert.deepEqual(fs.readFileSync(windowsIcon).subarray(0, 4), Buffer.from([0, 0, 1, 0]));
assert.ok(
    fs.statSync(path.join(manager, 'src-tauri/icons/icon.png')).isFile(),
    'missing Tauri runtime icon',
);
assert.ok(
    fs.statSync(path.join(manager, 'src-tauri/icons/icon.icns')).isFile(),
    'missing macOS application icon',
);
assert.match(builder, /--no-bundle/);
assert.match(compose, /BOX_BIND_IP:-127\.0\.0\.1/);
assert.match(compose, /BOX_CREATOR_BIND_IP:-127\.0\.0\.1}:\$\{BOX_CREATOR_PORT/);
assert.match(compose, /BOX_VOXA_BIND_IP:-127\.0\.0\.1}:\$\{BOX_VOXA_PORT/);
assert.doesNotMatch(frontend, /name="bindIp"/);
// Saving data configuration must be a non-disruptive operation. It keeps the
// user on the current setup page; starting containers remains an explicit
// choice from the overview page.
assert.match(frontend, /保存配置/);
assert.match(frontend, /已保存在当前页面，服务不会自动启动/);
assert.match(frontend, /class="toast success"/);
assert.doesNotMatch(frontend, /state\.page = 'overview'\s*\n\s*state\.notice/);
assert.match(frontend, /function getServiceUrl\(/);
assert.match(frontend, /function captureScrollPositions\(\)/);
assert.match(frontend, /function restoreScrollPositions\(positions\)/);
assert.match(frontend, /const scrollPositions = captureScrollPositions\(\)/);
assert.match(frontend, /restoreScrollPositions\(scrollPositions\)/);
assert.match(frontend, /data-rendered-page="\$\{state\.page\}"/);
assert.match(frontend, /shell\.dataset\.renderedPage !== state\.page/);
assert.match(frontend, /setupPanel\?\.dataset\.setupPanel === state\.setupSection/);
assert.match(frontend, /function startScopeDialog\(/);
assert.match(frontend, /class="dialog-backdrop"/);
assert.match(frontend, /data-start-scope="play"/);
assert.match(frontend, /data-start-scope="creator"/);
assert.match(frontend, /id="confirm-start-scopes"/);
assert.match(frontend, /service-more-menu/);
assert.match(frontend, /running && url \? `<button data-copy-url/);
assert.match(frontend, /function closeServiceMenuOnOutside\(/);
assert.match(frontend, /target\.closest\('\.service-more'\)/);
assert.match(styles, /\.start-dialog/);
assert.match(styles, /\.dialog-backdrop/);
assert.doesNotMatch(frontend, /function overviewNextStep\(/);
assert.doesNotMatch(styles, /\.next-step-card/);
assert.doesNotMatch(frontend, /install_and_start/);
assert.match(backend, /async fn save_configuration_command/);
assert.match(backend, /async fn start_services\(app: AppHandle, scope: String\)/);
for (const scope of ['"all"', '"creator"', '"play"']) {
    assert.match(backend, new RegExp(scope));
}
assert.doesNotMatch(backend, /async fn install_and_start/);
assert.match(backend, /fn validate_creator_host/);
assert.match(backend, /fn enforce_creator_network_policy/);
assert.match(backend, /enforce_creator_network_policy\(app\)\?;/);
assert.match(backend, /BOX_CREATOR_PUBLIC_URL/);
assert.match(backend, /BOX_VOXA_ALLOWED_ORIGINS/);
assert.match(
    compose,
    /VOXA_URL: \$\{BOX_VOXA_PUBLIC_URL[^\n]*\n\s*BOX_VOXA_PUBLIC_URL: \$\{BOX_VOXA_PUBLIC_URL/,
    'Creator must receive the VOXA public origin so its child runtimes expose the required CORS header',
);
assert.match(frontend, /服主与安全/);
assert.match(frontend, /原始 \.env/);
assert.match(frontend, /配置说明：这些服务用来做什么？/);
assert.match(frontend, /业务 DB \/ 缓存 DB/);
assert.match(styles, /\.setup-explainer/);
assert.match(frontend, /secretCard\('playAdminToken'/);
assert.match(frontend, /首次保存配置时[^。]*自动生成/);
assert.match(frontend, /data-secret-edit=/);
assert.match(frontend, /data-secret-save=/);
assert.match(frontend, /data-secret-copy=/);
assert.match(frontend, /async function toggleOwnerSecretEditor\(name\)/);
assert.match(frontend, /async function copyOwnerSecret\(name\)/);
assert.doesNotMatch(frontend, /id="toggle-owner-secrets"/);
assert.doesNotMatch(frontend, /data-secret-toggle=/);
assert.match(backend, /fn get_owner_secrets\(app: AppHandle\)/);
assert.match(backend, /OwnerSecretsView/);
assert.match(frontend, /data-save-raw-environment/);
assert.doesNotMatch(frontend, /运行日志|查看运行日志|syncLogPolling|loadLogs/);
assert.doesNotMatch(backend, /fn get_logs|fn get_service_logs/);
assert.match(frontend, /服主交流群/);
assert.match(frontend, /QQ群 1107448537/);
assert.match(frontend, /open_community_group/);
assert.match(backend, /fn open_community_group\(\)/);
assert.match(frontend, /addEventListener\('contextmenu', \(event\) => event\.preventDefault\(\)\)/);
assert.match(backend, /fn get_raw_environment/);
assert.match(backend, /fn save_raw_environment/);
assert.match(backend, /fn get_about_info/);
assert.match(backend, /source_revision/);
assert.match(frontend, /function about\(\)/);
assert.match(frontend, /get_about_info/);
assert.match(styles, /\.about-page/);
assert.match(backend, /normalize_owner_environment/);
assert.match(backend, /BOX_DEPLOYMENT_MANAGER_DATABASE_PASSWORD/);
assert.match(backend, /remove_env\(&mut normalized, legacy\)/);
assert.match(backend, /fn write_private_file/);
assert.match(backend, /fn verify_offline_image_archive/);
assert.match(backend, /fn offline_image_digest_path/);
assert.match(backend, /let archive_digest = verify_offline_image_archive\(app, &archive\)/);
assert.match(backend, /imported_digest\.as_deref\(\) == Some\(archive_digest\.as_str\(\)\)/);
assert.match(backend, /write_private_file\(\s*&digest_path,\s*format!\("\{archive_digest\}\\n"\)/);
assert.match(backend, /SHA-256 校验失败/);
assert.match(backend, /BOX-OFFLINE-IMAGE\.json/);
const saveConfigurationCommand = desktopBackend.match(
    /async fn save_configuration_command[\s\S]*?(?=\n#\[tauri::command\]\nasync fn start_services)/,
)?.[0];
assert.ok(saveConfigurationCommand, 'missing save configuration command body');
assert.doesNotMatch(saveConfigurationCommand, /ensure_images|compose_output/);
assert.match(frontend, /overview-start-options/);
assert.match(frontend, /Docker 服务未连接/);
assert.match(frontend, /启动 Docker 服务/);
assert.match(frontend, /data-start-scope="all"/);
assert.match(frontend, /data-start-scope="play"/);
assert.match(frontend, /data-start-scope="creator"/);
assert.match(frontend, /数据库还没有配置/);
// The Web manager gate must reuse the launcher shell and panels. A bespoke
// full-screen form (and its undefined CSS variables) made the headless console
// look like a different product.
assert.match(frontend, /function webLogin\(\)/);
assert.match(frontend, /state\.page === 'web-login'/);
// A stale Web token must fall back to the gate instead of an empty console.
assert.match(frontend, /setWebManagerToken\(''\);\s*state\.page = 'web-login'/);
assert.match(frontend, /<form id="web-login-form" class="manager-login-form">/);
assert.match(frontend, /<h1>Box Engine 管理界面<\/h1>/);
assert.match(frontend, /navItem\('web-login', 'device', '管理登录'\)/);
assert.match(frontend, /!\['web-login', 'about'\]\.includes\(state\.page\)/);
assert.doesNotMatch(frontend, /HEADLESS OPERATIONS/);
assert.doesNotMatch(frontend, /class="web-login"/);
assert.doesNotMatch(styles, /\.web-login\b/);
assert.match(styles, /#web-login-error/);
// The setup form must accept everything the backends accept. A hidden panel
// holding an out-of-range default made the browser block saving with an
// unfocusable "invalid form control" warning.
assert.match(
    frontend,
    /'账号服务内存', config\.playerServiceMemoryMb \?\? 1024, 'number', '推荐 1024 MiB', false, \{ min: 128, max: 262144 \}/,
);
assert.match(
    frontend,
    /'登录页面内存', config\.authPortalMemoryMb \?\? 128, 'number', '推荐 128 MiB', false, \{ min: 64, max: 262144 \}/,
);
assert.match(
    frontend,
    /'Creator 内存', config\.creatorMemoryMb \?\? 6144, 'number', '推荐 6144 MiB', false, \{ min: 512, max: 262144 \}/,
);
assert.doesNotMatch(frontend, /step: 0\.1 \}/);
assert.match(frontend, /<form id="setup-form" novalidate/);
assert.match(frontend, /function revealInvalidSetupField\(form\)/);
assert.match(frontend, /state\.page = 'overview';\s*render\(\);\s*await refreshStatus\(\)/);
assert.doesNotMatch(frontend, /onboardingStep|onboarding-shell|onboarding-next/);
assert.match(frontend, /async function recheckDocker\(\)/);
assert.match(frontend, /正在检测 \$\{dockerPlatform\(\)\.name\}/);
assert.match(frontend, /Promise\.race\(\[invoke\('get_docker_check'\), timeout\]\)/);
assert.match(frontend, /dockerPlatform\(\)\.name\} 未在 8 秒内响应/);
assert.doesNotMatch(frontend, /id="recheck-docker"/);
assert.match(frontend, /const startsDockerWork =/);
assert.match(frontend, /state\.error = dockerPlatform\(\)\.hint/);
assert.match(frontend, /id="connect-docker"/);
assert.match(frontend, /async function startDockerDesktop\(\)/);
assert.match(frontend, /invoke\('start_docker_desktop'\)/);
assert.match(frontend, /function scheduleDockerStartupCheck\(\)/);
assert.match(frontend, /window\.setTimeout\(async \(\) => \{/);
assert.match(frontend, /id="connect-docker"/);
assert.match(frontend, /projectRuntimesLoaded: false/);
assert.match(
    frontend,
    /const hasProjects = state\.projectRuntimes\.creator\?\.length \|\| state\.projectRuntimes\.play\?\.length/,
);
assert.match(
    frontend,
    /if \(!hasProjects\) \{\s*if \(!state\.projectRuntimesLoaded && !projectRuntimeLoading\) \{\s*scheduleProjectRuntimeRefresh\(\)/,
);
assert.match(frontend, /const PROJECT_RUNTIME_POLL_MS = 3000/);
assert.match(frontend, /const PROJECT_RUNTIME_HIDDEN_POLL_MS = 10000/);
assert.match(frontend, /function scheduleProjectRuntimeRefresh\(\)/);
assert.match(frontend, /clearTimeout\(projectRuntimeRefreshTimer\)/);
assert.match(frontend, /previousRuntimes !== JSON\.stringify\(state\.projectRuntimes\)/);
assert.match(frontend, /function scheduleProgressRender\(\)/);
assert.match(frontend, /state\.projectRuntimesLoaded = true/);
assert.match(backend, /fn open_docker_desktop_download\(\)/);
assert.match(backend, /open_docker_desktop_download,/);
assert.match(backend, /async fn get_docker_check\(\) -> Result<DockerCheck, String>/);
assert.match(backend, /fn start_docker_desktop\(\) -> Result<\(\), String>/);
assert.match(backend, /\["desktop", "start"\]/);
assert.match(backend, /get_docker_check,/);
assert.match(backend, /docker_cli_available: bool/);
// The main shell is intentionally fixed-height. The log pane therefore needs
// to reserve space for the page header and filters, then expose its own
// vertical scrollbar instead of being clipped below the viewport.
assert.doesNotMatch(styles, /\.logs-page|\.log-card|\.log-live-status/);

// Check production adapter wiring separately from the aggregated feature text.
// Test fixtures/comments must not make a disconnected core implementation pass.
const productionRust = (source) =>
    source
        // Top-level test modules end at an unindented brace in these Rust files.
        // Remove the whole module, preserving production items declared after it.
        .replace(/^#\[cfg\(test\)\]\s*mod \w+\s*\{[\s\S]*?^\}/gm, '')
        .replace(/^\s*\/\/.*$/gm, '');
const core = Object.fromEntries(
    ['lib', 'configuration', 'services', 'backup'].map((name) => [
        name,
        productionRust(fs.readFileSync(path.join(sharedDirectory, `${name}.rs`), 'utf8')),
    ]),
);
for (const module of ['configuration', 'services']) {
    assert.ok(core.lib.includes(`pub mod ${module};`), `core must export ${module}`);
}
// Core owns policies; native filesystem/network/UI adapters must stay outside
// configuration. Backup filesystem I/O remains in the dedicated backup module.
assert.doesNotMatch(core.configuration, /\b(?:tauri|axum)::/);
assert.doesNotMatch(core.configuration, /\b(?:std::env|env)::(?:var|var_os)\(/);
for (const name of [
    'validate_raw_environment',
    'validate_configuration',
    'runtime_environment',
    'database_url',
]) {
    assert.ok(
        core.configuration.includes(`pub fn ${name}(`),
        `missing shared configuration API ${name}`,
    );
}
for (const key of [
    'BOX_CREATOR_ALLOWED_HOSTS',
    'BOX_RESOURCE_ALLOWED_ORIGINS',
    'BOX_VOXA_ALLOWED_ORIGINS',
    'BOX_PLAYER_AUTH_ALLOWED_ORIGINS',
    'BOX_PLAYER_LOGIN_URL',
    'BOX_PLAYER_SERVICE_INTERNAL_URL',
    'BOX_DATABASE_QUERY',
]) {
    assert.ok(
        core.configuration.includes(`"${key}"`),
        `shared runtime must derive/preserve ${key}`,
    );
}
assert.match(core.services, /pub const MANAGED_SERVICES:/);
for (const serviceName of [
    'managed-postgres',
    'managed-redis',
    'creator',
    'play',
    'voxa',
    'player-service',
    'player-auth-portal',
]) {
    assert.ok(
        core.services.includes(`"${serviceName}"`),
        `core service catalog is missing ${serviceName}`,
    );
}
for (const name of ['start', 'control', 'stop', 'statuses', 'compose_rows', 'enabled']) {
    assert.ok(
        core.services.includes(`pub fn ${name}(`),
        `missing shared service operation ${name}`,
    );
}
assert.match(
    core.services,
    /start_applications\(runtime, &\[service\]\)\?;/,
    'individual application starts must preserve the Web manager dependency',
);
assert.doesNotMatch(
    core.services,
    /COMPOSE_PROFILES/,
    'service enablement must not depend on stale owner profiles',
);

// Backup migration is staged: until lib.rs exports backup, check the new core
// contract without requiring desktop's soon-to-be-deleted ZIP/tar helpers.
// Once exported, adapters must use backup_store for creation/import validation
// and backup for restoration; check both links in that shared call chain.
assert.match(core.backup, /pub fn create_archive\(/);
assert.match(core.backup, /pub fn validate_archive\(/);
assert.match(core.backup, /pub fn restore_archive\b/);
assert.match(core.backup, /pub const DATA_DIRECTORIES:/);
assert.ok(core.backup.includes('".tar.gz"'), 'new backups must use .tar.gz');
assert.ok(
    core.backup.includes('"BACKUP-README.txt"'),
    'empty installations must have a valid README-only backup',
);
// Rejecting traversal/links, validating before stopping writers, ZIP/TAR legacy
// import and rollback belong in the core backup behavior suite.
// No check here requires an archive shell command or a particular parser.

const desktopCommands = productionRust(
    fs.readFileSync(path.join(backendSourceDirectory, 'commands.rs'), 'utf8'),
);
const desktopConfig = productionRust(
    fs.readFileSync(path.join(backendSourceDirectory, 'config.rs'), 'utf8'),
);
assert.match(desktopCommands, /use box_manager_core::configuration as shared_config;/);
assert.match(desktopCommands, /shared_config::runtime_environment\(/);
assert.match(desktopCommands, /shared_config::validate_configuration\(/);
assert.match(desktopCommands, /validate_install_configuration\(&config\)\?;/);
assert.match(desktopConfig, /use box_manager_core::configuration::validate_raw_environment;/);
assert.match(desktopCommands, /validate_raw_environment\(&content\)\?;/);
assert.match(desktopCommands, /web_manager:\s*false/);
assert.match(
    desktopCommands,
    /write_private_file\(&runtime_path, runtime, "运行时配置"\)\?/,
    'derived environment must be written privately',
);
assert.match(desktopCommands, /use box_manager_core::services::\{/);
assert.match(desktopCommands, /MANAGED_SERVICES as MANAGED_SERVICE_NAMES/);
assert.match(desktopCommands, /impl ServiceRuntime for DesktopRuntime/);
assert.match(desktopCommands, /services::statuses\(/);
const desktopModels = productionRust(
    fs.readFileSync(path.join(backendSourceDirectory, 'models.rs'), 'utf8'),
);
for (const model of ['ServiceStatus', 'InstallProgress']) {
    assert.ok(
        desktopModels.includes(`use box_manager_core::services::${model};`),
        `desktop must re-export shared ${model}`,
    );
    assert.ok(!desktopModels.includes(`struct ${model} {`), `desktop must not duplicate ${model}`);
}
for (const operation of ['start', 'control', 'stop']) {
    assert.ok(
        desktopCommands.includes(`services::${operation}(&DesktopRuntime(`),
        `desktop must delegate ${operation} to core services`,
    );
}
if (core.lib.includes('pub mod backup;')) {
    // Accept direct and flat grouped imports, including module aliases. Match
    // complete members so backup_store alone cannot satisfy the backup import.
    const coreImports = new Map();
    for (const [, name, alias] of desktopCommands.matchAll(
        /use\s+box_manager_core::(\w+)(?:\s+as\s+(\w+))?\s*;/g,
    )) {
        coreImports.set(name, alias || name);
    }
    for (const [, members] of desktopCommands.matchAll(
        /use\s+box_manager_core::\{([^{}]+)\}\s*;/g,
    )) {
        for (const member of members.split(',')) {
            const binding = member.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
            if (binding) {
                coreImports.set(binding[1], binding[2] || binding[1]);
            }
        }
    }
    // Rustfmt may keep flat modules and a nested module tree in the same grouped
    // import. The simple flat-group matcher above intentionally does not parse
    // nested braces, so recover the two required top-level bindings here.
    for (const module of ['backup', 'backup_store']) {
        if (coreImports.has(module)) {
            continue;
        }
        const grouped = desktopCommands.match(
            new RegExp(
                `use\\s+box_manager_core::\\{[\\s\\S]*?\\b${module}\\b(?:\\s+as\\s+(\\w+))?`,
            ),
        );
        if (grouped) {
            coreImports.set(module, grouped[1] || module);
        }
    }
    for (const module of ['backup', 'backup_store']) {
        assert.ok(coreImports.has(module), 'desktop must import core ' + module);
        assert.ok(core.lib.includes(`pub mod ${module};`), `core must export ${module}`);
    }
    const backupName = coreImports.get('backup');
    const storeName = coreImports.get('backup_store');
    assert.ok(
        desktopCommands.includes(`${backupName}::restore_archive(`) ||
            desktopCommands.includes(`${backupName}::restore_archive_with_env(`),
        'desktop must use shared backup restore_archive',
    );
    for (const operation of ['list', 'resolve', 'create', 'import_file']) {
        assert.ok(
            desktopCommands.includes(`${storeName}::${operation}(`),
            `desktop must use shared backup_store ${operation}`,
        );
    }
    const backupStore = productionRust(
        fs.readFileSync(path.join(sharedDirectory, 'backup_store.rs'), 'utf8'),
    );
    assert.match(backupStore, /use crate::backup::\{self, Limits\};/);
    for (const operation of ['create_archive', 'validate_archive']) {
        assert.ok(
            backupStore.includes(`backup::${operation}(`),
            `backup_store must delegate ${operation} to shared backup`,
        );
    }
} else {
    console.log(
        'Desktop backup: core contract checked; adapter integration pending pub mod backup',
    );
}

console.log('Desktop deployment manager checks passed');

assert.doesNotMatch(
    frontendSource(root),
    /get_license_status|install_license|hasValidLicense|许可证管理/,
);
assert.doesNotMatch(core.services, /require_license/);
