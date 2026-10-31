'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { frontendSource } = require('./lib/deployment-manager-source');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const dockerfile = read('apps/server-manager/Dockerfile');
const adapter = read('apps/server-manager-rust/src/main.rs');
const collectRust = (directory) =>
    fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                return collectRust(target);
            }
            return entry.name.endsWith('.rs') ? [fs.readFileSync(target, 'utf8')] : [];
        });
const serverManager = collectRust(path.join(root, 'apps/server-manager-rust/src')).join('\n');
const sharedDirectory = path.join(root, 'apps/manager-core/src');
const sharedBackend = fs
    .readdirSync(sharedDirectory)
    .filter((file) => file.endsWith('.rs'))
    .sort()
    .map((file) => fs.readFileSync(path.join(sharedDirectory, file), 'utf8'))
    .join('\n');
const service = serverManager + '\n' + sharedBackend;
const transport = read('apps/deployment-manager/src/infrastructure/transport.js');
const consoleSource = frontendSource(root);
const serverEnvExample = read('distribution/server/.env.example');
const serverInstall = read('distribution/server/install.sh');
const compose = read('docker-compose.yml');

assert.match(dockerfile, /FROM \$\{RUST_IMAGE\} AS rust-build/);
assert.match(dockerfile, /COPY --from=rust-build \/server-manager \/app\/server-manager/);
assert.match(dockerfile, /CMD \["\/app\/server-manager"\]/);
assert.doesNotMatch(dockerfile, /CMD \["node", "server\.js"\]/);
assert.match(dockerfile, /CMD \["\/app\/server-manager", "--healthcheck"\]/);
assert.match(dockerfile, /apt-get install .*ca-certificates curl unzip/);
assert.match(dockerfile, /COPY distribution\/server\/bootstrap\.sh \/app\/bootstrap\.sh/);
assert.equal(
    (dockerfile.match(/COPY --from=docker-cli .*docker-compose/g) || []).length,
    1,
    'the Compose plugin must not be duplicated in the runtime image',
);
assert.match(adapter, /#\[tokio::main\(flavor = "current_thread"\)\]/);
assert.match(transport, /postApiCommandsNameRaw\([\s\S]*?path: \{ name: command \}/);
assert.match(transport, /postApiBackupsUploadRaw\(/);
assert.match(transport, /getApiDiagnosticsArchiveDownloadRaw\([\s\S]*?path: \{ archive \}/);
assert.match(consoleSource, /id="web-logout"/, 'Web console must expose an explicit logout action');
assert.match(consoleSource, /navItem\('web-login', 'device', '管理登录'\)/);
assert.match(consoleSource, /<h1>Box Engine 管理界面<\/h1>/);
assert.match(
    consoleSource,
    /managementAvailable \? `<div class="about-content-layout"><article class="about-card"><div class="about-card-heading"><h2>更新日志/,
);
assert.match(consoleSource, /const protectedDocuments = managementAvailable/);
assert.match(serverManager, /if name != "get_legal_notices"/);
assert.match(transport, /managerApi\(command !== 'get_legal_notices'\)/);
assert.match(
    consoleSource,
    /#web-logout'[\s\S]*setWebManagerToken\(''\)[\s\S]*state\.page = 'web-login'/,
    'Web logout must clear the session token and return to the login gate',
);
for (const command of [
    'get_system_status',
    'get_install_config',
    'save_configuration_command',
    'start_services',
    'control_service',
    'list_backups',
    'create_backup',
    'inspect_backup',
    'restore_backup',
    'get_performance_status',
    'destroy_project_runtime',
    'get_owner_secrets',
    'get_raw_nginx_config',
    'save_raw_nginx_config',
    'test_remote_connection',
    'export_diagnostics',
    'prepare_managed_database',
    'prepare_managed_redis',
    'get_managed_service_info',
    'start_managed_service',
]) {
    assert.match(serverManager, new RegExp(`"${command}"`), `Rust manager must support ${command}`);
}
const browserHandledCommands = new Set([
    'open_service',
    'open_community_group',
    'open_docker_desktop_download',
    'start_docker_desktop',
    'choose_data_storage_directory',
    'import_backup',
    'export_backup',
    'export_ssl_configuration',
]);
const invokedCommands = [...consoleSource.matchAll(/invoke\('([a-z_]+)'/g)].map(
    (match) => match[1],
);
// These operations replace the native launcher itself; the Web manager has
// no local launcher binary and must not expose them as server commands.
const desktopOnlyCommands = new Set(['download_launcher_update', 'apply_launcher_update']);
const desktopHandlers = fs.readFileSync(
    path.join(root, 'apps/deployment-manager/src-tauri/src/commands.rs'),
    'utf8',
);
for (const command of invokedCommands) {
    if (desktopOnlyCommands.has(command)) {
        assert.match(desktopHandlers, new RegExp(`crate::launcher_update::${command}\\b`));
        continue;
    }
    if (!browserHandledCommands.has(command)) {
        assert.match(
            serverManager,
            new RegExp(`"${command}"`),
            `Rust manager must support UI command ${command}`,
        );
    }
}
assert.match(service, /拒绝跨站管理请求/);
assert.match(service, /DefaultBodyLimit::max\(512 \* 1024 \* 1024\)/);

// Parity with the desktop launcher backend. The headless manager must derive
// the Docker runtime environment instead of handing the raw .env to Compose,
// must preserve the running Web manager when starting services, and must expose the same
// configuration keys the launcher writes.
assert.match(service, /fn generate_runtime_environment\(app: &App\)/);
assert.match(service, /fn runtime_env_path\(app: &App\)/);
assert.match(service, /let environment = generate_runtime_environment\(app\)\?;/);
assert.match(service, /BOX_CREATOR_ALLOWED_HOSTS/);
assert.match(service, /BOX_PLAYER_AUTH_ALLOWED_ORIGINS/);
assert.match(service, /BOX_PLAYER_LOGIN_URL/);
assert.match(service, /BOX_PLAYER_SERVICE_INTERNAL_URL/);
assert.match(
    sharedBackend,
    /let mut args = vec!\["up", "-d", "--no-build", "--no-deps"\];/,
    'bulk starts must preserve the running Web manager dependency',
);
assert.match(service, /desktop-postgres/);
assert.match(service, /desktop-redis/);
assert.match(service, /BOX_SCRIPT_HEAP_MB/);
assert.match(service, /"lanIp": detect_lan_ip\(\)/);
assert.match(service, /fn validate_raw_environment\(content: &str\)/);
assert.match(service, /fn validate_configuration\(/);
assert.match(service, /fn check_remote_endpoint\(label: &str, host: &str, port: u16\)/);
assert.match(service, /fn is_sensitive_env_key\(key: &str\)/);
assert.match(service, /compose\(app, &\["logs", "--tail", "500", "--no-color"\]\)/);
// A fresh deployment must still produce a backup instead of refusing because
// no map data exists yet (the desktop launcher writes a README-only archive).
assert.doesNotMatch(service, /没有可备份的数据目录/);
assert.match(service, /BACKUP-README\.txt/);
// Archive integrity and empty-backup behavior belong to core backup tests,
// not the old GNU tar warning flag or desktop ZIP command implementation.
// The manager container cannot see the host LAN address, so the operator (or
// install.sh) supplies it and the container never guesses from its own netns.
assert.match(service, /fn configured_lan_ip\(\)/);
assert.match(service, /fn in_container\(\)/);
assert.match(service, /BOX_LAN_IP/);
assert.match(serverEnvExample, /^BOX_LAN_IP=/m);
assert.match(serverInstall, /BOX_LAN_IP=\$lan_ip/);
assert.match(compose, /BOX_LAN_IP: \$\{BOX_LAN_IP:-\}/);
assert.match(serverInstall, /--remove-orphans --wait server-manager/);
assert.match(serverEnvExample, /^BOX_DOCKER_SOCKET=\/var\/run\/docker\.sock$/m);
assert.match(serverEnvExample, /^BOX_MANAGED_POSTGRES_MEMORY_LIMIT=512m$/m);
assert.match(serverEnvExample, /^BOX_MANAGED_REDIS_MEMORY_LIMIT=256m$/m);
assert.match(serverEnvExample, /^BOX_VOXA_MEMORY_LIMIT=1g$/m);

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

const webAdapter = productionRust(serverManager);
assert.match(webAdapter, /use box_manager_core::configuration as shared_config;/);
assert.match(webAdapter, /shared_config::runtime_environment\(/);
assert.match(webAdapter, /use shared_config::\{[\s\S]*?validate_configuration/);
assert.match(webAdapter, /validate_configuration\(config\)\?;/);
assert.match(webAdapter, /use shared_config::\{[\s\S]*?validate_raw_environment/);
assert.match(webAdapter, /validate_raw_environment\(s\)\?;/);
assert.match(webAdapter, /web_manager:\s*true/);
assert.match(
    webAdapter,
    /private\(&path, &runtime\)\?;/,
    'derived environment must be written privately',
);
assert.match(webAdapter, /use box_manager_core::services::\{/);
assert.match(webAdapter, /impl ServiceRuntime for WebRuntime/);
assert.match(webAdapter, /services::statuses\(/);
assert.match(webAdapter, /services::enabled\(/);
for (const operation of ['start', 'control', 'stop']) {
    assert.ok(
        webAdapter.includes(`services::${operation}(&WebRuntime(`),
        `Web must delegate ${operation} to core services`,
    );
}
if (core.lib.includes('pub mod backup;')) {
    // Accept direct and flat grouped imports, including module aliases. Match
    // complete members so backup_store alone cannot satisfy the backup import.
    const coreImports = new Map();
    for (const [, name, alias] of webAdapter.matchAll(
        /use\s+box_manager_core::(\w+)(?:\s+as\s+(\w+))?\s*;/g,
    )) {
        coreImports.set(name, alias || name);
    }
    for (const [, members] of webAdapter.matchAll(/use\s+box_manager_core::\{([^{}]+)\}\s*;/g)) {
        for (const member of members.split(',')) {
            const binding = member.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
            if (binding) {
                coreImports.set(binding[1], binding[2] || binding[1]);
            }
        }
    }
    for (const module of ['backup', 'backup_store']) {
        assert.ok(coreImports.has(module), 'Web must import core ' + module);
        assert.ok(core.lib.includes(`pub mod ${module};`), `core must export ${module}`);
    }
    const backupName = coreImports.get('backup');
    const storeName = coreImports.get('backup_store');
    assert.ok(
        webAdapter.includes(`${backupName}::restore_archive(`) ||
            webAdapter.includes(`${backupName}::restore_archive_with_env(`),
        'Web must use shared backup restore_archive',
    );
    for (const operation of ['list', 'resolve', 'create', 'import_bytes']) {
        assert.ok(
            webAdapter.includes(`${storeName}::${operation}(`),
            `Web must use shared backup_store ${operation}`,
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
    console.log('Web backup: core contract checked; adapter integration pending pub mod backup');
}

console.log('headless Rust manager checks passed');

assert.doesNotMatch(
    frontendSource(root),
    /get_license_status|install_license|hasValidLicense|许可证管理/,
);
assert.doesNotMatch(core.services, /require_license/);
