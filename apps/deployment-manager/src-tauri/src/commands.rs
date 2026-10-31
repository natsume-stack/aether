use box_manager_core::configuration as shared_config;
use box_manager_core::configuration_migration::{
    clear_overrides_on_configuration_change, migrate_document,
};
use box_manager_core::{
    backup, backup_store,
    map_runtime_profiles::{
        valid_permanent_map_id, validate_map_runtime_profile, MapRuntimeProfile,
        MapRuntimeProfilesFile,
    },
};
use postgres::NoTls;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

#[path = "config.rs"]
mod config;
#[path = "docker.rs"]
mod docker;

#[path = "external_links.rs"]
mod external_links;

use config::{
    compose_path, default_runtime_root, detect_lan_ip, ensure_runtime_files, env_path, parse_env,
    random_hex, remove_env, resolve_secret, runtime_env_path, runtime_location_file, runtime_root,
    set_env, validate_raw_environment, write_private_file, IMAGE_TAG, ROOT_VERSION, SERVICE_NAMES,
};
use docker::{
    command as docker_command, hide_window, output as docker_output, run_command,
    unavailable_message as docker_message,
};

#[path = "models.rs"]
mod models;

#[path = "ssl.rs"]
mod ssl_commands;

use models::*;


const ENV_TEMPLATE: &str = include_str!("../defaults.env");
const IMAGE_INFO: &str = include_str!("../payload/IMAGE-INFO.json");
// Keep the desktop launcher's containers and named volumes separate from a
// source checkout or a headless server installed on the same machine. Both
// products generate their managed database credentials independently; sharing
// `box-local-engine_*` volumes makes PostgreSQL retain the other product's
// password and causes Player Service authentication to fail.
const PROJECT_NAME: &str = env!("BOX_MANAGER_PROJECT_NAME");
const MANAGED_DATABASE_IMAGE: &str = "docker.m.daocloud.io/library/postgres:16-alpine";
const MANAGED_REDIS_IMAGE: &str = "docker.m.daocloud.io/library/redis:7-alpine";
use box_manager_core::services::{
    self, Runtime as ServiceRuntime, MANAGED_SERVICES as MANAGED_SERVICE_NAMES,
};
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallConfigView {
    database_mode: String,
    database_host: String,
    database_port: String,
    database_name: String,
    database_user: String,
    database_ssl: bool,
    has_database_password: bool,
    has_permission_token_secret: bool,
    has_player_auth_api_key: bool,
    has_play_admin_token: bool,
    redis_mode: String,
    redis_host: String,
    redis_port: String,
    has_redis_password: bool,
    redis_db: u8,
    storage_cache_redis_db: u8,
    database_pool_size: u32,
    storage_cache_redis_ttl: u8,
    auto_backup_enabled: bool,
    auto_backup_interval_minutes: u32,
    auto_backup_retention_count: u32,
    auto_backup_retention_days: u32,
    public_host: String,
    public_address: String,
    public_address_mode: String,
    shared_public_address: String,
    public_service_paths: BTreeMap<String,String>,
    #[serde(default)]
    public_ssl_configured: BTreeMap<String,bool>,
    play_public_address_override: String,
    creator_public_address_override: String,
    voxa_public_address_override: String,
    player_service_public_address_override: String,
    auth_portal_public_address_override: String,
    play_network_mode: String,
    creator_network_mode: String,
    creator_host: String,
    lan_ip: String,
    play_port: u16,
    voxa_port: u16,
    creator_port: u16,
    player_service_port: u16,
    auth_portal_port: u16,
    auth_portal_image: String,
    play_runtimes: u32,
    creator_edit_runtimes: u32,
    creator_play_runtimes: u32,
    creator_edit_prewarm_runtimes: u32,
    play_prewarm_runtimes: u32,
    player_limit: u32,
    script_memory_mb: u32,
    runtime_idle_minutes: u32,
    runtime_start_timeout_minutes: u32,
    teleport_max_rooms: u32,
    teleport_room_idle_minutes: u32,
    registration_enabled: bool,
    player_service_memory_mb: u32,
    player_service_cpu_limit: f64,
    auth_portal_memory_mb: u32,
    auth_portal_cpu_limit: f64,
    creator_memory_mb: u32,
    creator_cpu_limit: f64,
    play_memory_mb: u32,
    play_cpu_limit: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnerSecretsView {
    permission_token_secret: String,
    player_auth_api_key: String,
    play_admin_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedServiceInfo {
    image_available: bool,
    configured: bool,
    running: bool,
    host: String,
    port: String,
    database: String,
    user: String,
    password: String,
    connection_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataStorageInfo {
    path: String,
    using_default: bool,
}

impl Default for InstallConfigView {
    fn default() -> Self {
        Self {
            database_mode: default_database_mode(),
            database_host: String::new(),
            database_port: "5432".into(),
            database_name: "box".into(),
            database_user: "box".into(),
            database_ssl: false,
            has_database_password: false,
            has_permission_token_secret: false,
            has_player_auth_api_key: false,
            has_play_admin_token: false,
            redis_mode: default_redis_mode(),
            redis_host: String::new(),
            redis_port: "6379".into(),
            has_redis_password: false,
            redis_db: 0,
            storage_cache_redis_db: 1,
            database_pool_size: 10,
            storage_cache_redis_ttl: 240,
            auto_backup_enabled: false,
            auto_backup_interval_minutes: 60,
            auto_backup_retention_count: 24,
            auto_backup_retention_days: 30,
            public_host: "127.0.0.1".into(),
            public_address: "127.0.0.1".into(),
            public_address_mode: "independent".into(),
            shared_public_address: String::new(),
            public_service_paths: BTreeMap::new(),
            public_ssl_configured: BTreeMap::new(),
            play_public_address_override: String::new(),
            creator_public_address_override: String::new(),
            voxa_public_address_override: String::new(),
            player_service_public_address_override: String::new(),
            auth_portal_public_address_override: String::new(),
            play_network_mode: "local".into(),
            creator_network_mode: "local".into(),
            creator_host: "127.0.0.1".into(),
            lan_ip: detect_lan_ip().unwrap_or_default(),
            play_port: 3121,
            voxa_port: 3123,
            creator_port: 3127,
            player_service_port: 3124,
            auth_portal_port: 3125,
            auth_portal_image: String::new(),
            play_runtimes: 8,
            creator_edit_runtimes: 6,
            creator_play_runtimes: 4,
            creator_edit_prewarm_runtimes: 0,
            play_prewarm_runtimes: 0,
            player_limit: 70,
            script_memory_mb: 512,
            runtime_idle_minutes: 15,
            runtime_start_timeout_minutes: 30,
            teleport_max_rooms: 64,
            teleport_room_idle_minutes: 15,
            registration_enabled: true,
            player_service_memory_mb: 1024,
            player_service_cpu_limit: 1.0,
            auth_portal_memory_mb: 128,
            auth_portal_cpu_limit: 0.5,
            creator_memory_mb: 6144,
            creator_cpu_limit: 2.0,
            play_memory_mb: 4096,
            play_cpu_limit: 2.0,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallConfigInput {
    #[serde(default)]
    external_nginx_manual: bool,
    #[serde(default = "default_database_mode")]
    database_mode: String,
    #[serde(default)]
    database_host: String,
    #[serde(default = "default_database_port")]
    database_port: String,
    #[serde(default = "default_database_name")]
    database_name: String,
    #[serde(default = "default_database_user")]
    database_user: String,
    #[serde(default)]
    database_password: String,
    #[serde(default)]
    database_ssl: bool,
    #[serde(default)]
    permission_token_secret: String,
    #[serde(default)]
    player_auth_api_key: String,
    #[serde(default)]
    play_admin_token: String,
    #[serde(default = "default_redis_mode")]
    redis_mode: String,
    #[serde(default)]
    redis_host: String,
    #[serde(default = "default_redis_port")]
    redis_port: String,
    #[serde(default)]
    redis_password: String,
    #[serde(default)]
    redis_db: u8,
    #[serde(default = "default_storage_cache_redis_db")]
    storage_cache_redis_db: u8,
    #[serde(default = "default_database_pool_size")]
    database_pool_size: u32,
    #[serde(default = "default_storage_cache_redis_ttl")]
    storage_cache_redis_ttl: u8,
    #[serde(default)]
    auto_backup_enabled: bool,
    #[serde(default = "default_auto_backup_interval_minutes")]
    auto_backup_interval_minutes: u32,
    #[serde(default = "default_auto_backup_retention_count")]
    auto_backup_retention_count: u32,
    #[serde(default = "default_auto_backup_retention_days")]
    auto_backup_retention_days: u32,
    #[serde(default = "default_public_host")]
    public_host: String,
    #[serde(default)]
    public_address: String,
    #[serde(default = "default_public_address_mode")]
    public_address_mode: String,
    #[serde(default)]
    shared_public_address: String,
    #[serde(default)]
    public_service_paths: BTreeMap<String,String>,
    #[serde(default)]
    public_ssl_configured: BTreeMap<String,bool>,
    #[serde(default)]
    independent_public_addresses: BTreeMap<String,String>,
    #[serde(default)]
    play_public_address_override: String,
    #[serde(default)]
    creator_public_address_override: String,
    #[serde(default)]
    voxa_public_address_override: String,
    #[serde(default)]
    player_service_public_address_override: String,
    #[serde(default)]
    auth_portal_public_address_override: String,
    #[serde(default = "default_play_network_mode")]
    play_network_mode: String,
    #[serde(default = "default_creator_host")]
    creator_host: String,
    #[serde(default = "default_creator_network_mode")]
    creator_network_mode: String,
    #[serde(default = "default_play_port")]
    play_port: u16,
    #[serde(default = "default_voxa_port")]
    voxa_port: u16,
    #[serde(default = "default_creator_port")]
    creator_port: u16,
    #[serde(default = "default_player_service_port")]
    player_service_port: u16,
    #[serde(default = "default_auth_portal_port")]
    auth_portal_port: u16,
    #[serde(default)]
    auth_portal_image: String,
    #[serde(default = "default_play_runtimes")]
    play_runtimes: u32,
    #[serde(default = "default_creator_edit_runtimes")]
    creator_edit_runtimes: u32,
    #[serde(default = "default_creator_play_runtimes")]
    creator_play_runtimes: u32,
    #[serde(default = "default_creator_edit_prewarm_runtimes")]
    creator_edit_prewarm_runtimes: u32,
    #[serde(default = "default_play_prewarm_runtimes")]
    play_prewarm_runtimes: u32,
    #[serde(default = "default_player_limit")]
    player_limit: u32,
    #[serde(default = "default_script_memory_mb")]
    script_memory_mb: u32,
    #[serde(default = "default_runtime_idle_minutes")]
    runtime_idle_minutes: u32,
    #[serde(default = "default_runtime_start_timeout_minutes")]
    runtime_start_timeout_minutes: u32,
    #[serde(default = "default_teleport_max_rooms")]
    teleport_max_rooms: u32,
    #[serde(default = "default_teleport_room_idle_minutes")]
    teleport_room_idle_minutes: u32,
    #[serde(default = "default_true")]
    registration_enabled: bool,
    #[serde(default = "default_player_service_memory_mb")]
    player_service_memory_mb: u32,
    #[serde(default = "default_player_service_cpu_limit")]
    player_service_cpu_limit: f64,
    #[serde(default = "default_auth_portal_memory_mb")]
    auth_portal_memory_mb: u32,
    #[serde(default = "default_auth_portal_cpu_limit")]
    auth_portal_cpu_limit: f64,
    #[serde(default = "default_creator_memory_mb")]
    creator_memory_mb: u32,
    #[serde(default = "default_creator_cpu_limit")]
    creator_cpu_limit: f64,
    #[serde(default = "default_play_memory_mb")]
    play_memory_mb: u32,
    #[serde(default = "default_play_cpu_limit")]
    play_cpu_limit: f64,
}

fn default_database_mode() -> String {
    "managed".into()
}

use shared_config::validate_database_mode;

fn default_database_port() -> String {
    "5432".into()
}
fn default_database_name() -> String {
    "box".into()
}
fn default_database_user() -> String {
    "box".into()
}
fn default_redis_port() -> String {
    "6379".into()
}
fn default_redis_mode() -> String {
    "disabled".into()
}
use shared_config::validate_redis_mode;
fn default_storage_cache_redis_db() -> u8 {
    1
}
fn default_database_pool_size() -> u32 {
    10
}
fn default_storage_cache_redis_ttl() -> u8 {
    240
}
fn default_auto_backup_interval_minutes() -> u32 {
    60
}
fn default_auto_backup_retention_count() -> u32 {
    24
}
fn default_auto_backup_retention_days() -> u32 {
    30
}
fn default_public_host() -> String {
    "127.0.0.1".into()
}
fn default_play_network_mode() -> String {
    "local".into()
}
fn default_creator_host() -> String {
    "127.0.0.1".into()
}
fn default_creator_network_mode() -> String {
    "local".into()
}
fn default_play_port() -> u16 {
    3121
}
fn default_voxa_port() -> u16 {
    3123
}
fn default_creator_port() -> u16 {
    3127
}
fn default_player_service_port() -> u16 {
    3124
}
fn default_auth_portal_port() -> u16 {
    3125
}
fn default_play_runtimes() -> u32 {
    8
}
fn default_creator_edit_runtimes() -> u32 {
    6
}
fn default_creator_play_runtimes() -> u32 {
    4
}
fn default_creator_edit_prewarm_runtimes() -> u32 {
    0
}
fn default_play_prewarm_runtimes() -> u32 {
    0
}
fn default_player_limit() -> u32 {
    70
}
fn default_script_memory_mb() -> u32 {
    512
}
fn default_runtime_idle_minutes() -> u32 {
    15
}
fn default_runtime_start_timeout_minutes() -> u32 {
    30
}
fn default_teleport_max_rooms() -> u32 {
    64
}
fn default_teleport_room_idle_minutes() -> u32 {
    15
}
fn default_true() -> bool {
    true
}
fn default_player_service_memory_mb() -> u32 {
    1024
}
fn default_player_service_cpu_limit() -> f64 {
    1.0
}
fn default_auth_portal_memory_mb() -> u32 {
    128
}
fn default_auth_portal_cpu_limit() -> f64 {
    0.5
}
fn default_creator_memory_mb() -> u32 {
    6144
}
fn default_creator_cpu_limit() -> f64 {
    2.0
}
fn default_play_memory_mb() -> u32 {
    4096
}
fn default_play_cpu_limit() -> f64 {
    2.0
}

fn compose_output(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    if box_manager_core::ssl::routing_settings(&runtime_root(app)?)?.is_none() { if let Some(result) = services::control_existing(args, PROJECT_NAME, docker_output) {
        return result;
    }}
    ensure_runtime_files(app)?;
    let root = runtime_root(app)?;
    // Regenerate on every invocation. The owner can edit .env directly, but
    // Docker only ever consumes the policy-checked derived configuration.
    generate_runtime_environment(app)?;
    let env = runtime_env_path(app)?;
    let original = compose_path(app)?;
    let source=fs::read_to_string(original).map_err(|error|error.to_string())?;
    let compose=root.join(".runtime-compose.yml");
    write_private_file(&compose,box_manager_core::ssl::compose_source(&root,&source)?,"公网运行配置")?;
    let mut command = docker_command();
    command
        .current_dir(&root)
        .args(["compose", "--project-name", PROJECT_NAME, "--project-directory"]).arg(&root).arg("--env-file");
    for key in parse_env(&fs::read_to_string(&env).map_err(|error| error.to_string())?).keys() {
        command.env_remove(key);
    }
    command.arg(env).arg("-f").arg(compose).args(args);
    let output = if args.first() == Some(&"ps") {
        docker::run_probe(command, Duration::from_secs(15))?
    } else {
        run_command(command)?
    };
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn compose_file_output(app:&AppHandle,file:&Path,args:&[String]) -> Result<String,String> {
    generate_runtime_environment(app)?;
    let root=runtime_root(app)?;
    let env=runtime_env_path(app)?;
    let mut command=docker_command();
    command.current_dir(&root).args(["compose","--project-name",PROJECT_NAME,"--project-directory"]).arg(&root).arg("--env-file").arg(&env).arg("-f").arg(file).args(args);
    for key in parse_env(&fs::read_to_string(&env).map_err(|error|error.to_string())?).keys() {command.env_remove(key);}
    run_command(command).map(|output|String::from_utf8_lossy(&output.stdout).into())
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            stage: stage.into(),
            message: message.into(),
            percent,
            downloads: None,
        },
    );
}

use shared_config::validate_host;

use shared_config::validate_creator_host;

use shared_config::validate_network_mode as validate_creator_network_mode;

use shared_config::host_from_http_url;

// Display-only fallback; the shared runtime derivation rejects invalid ports.
fn env_port(values: &BTreeMap<String, String>, key: &str, fallback: u16) -> u16 {
    shared_config::env_port(values, key, fallback).unwrap_or(fallback)
}

const GENERATED_ENV_KEYS: [&str; 16] = [
    "COMPOSE_PROFILES",
    "BOX_IMAGE_TAG",
    "BOX_PLAY_PLATFORM",
    "BOX_BIND_IP",
    "BOX_CREATOR_BIND_IP",
    "BOX_VOXA_BIND_IP",
    "BOX_PLAY_PUBLIC_URL",
    "BOX_VOXA_PUBLIC_URL",
    "BOX_CREATOR_PUBLIC_URL",
    "BOX_PLAYER_SERVICE_PUBLIC_URL",
    "BOX_AUTH_PORTAL_PUBLIC_URL",
    "BOX_PLAYER_LOGIN_URL",
    "BOX_PLAYER_AUTH_ALLOWED_ORIGINS",
    "BOX_CREATOR_ALLOWED_HOSTS",
    "BOX_VOXA_ALLOWED_ORIGINS",
    "BOX_RESOURCE_ALLOWED_ORIGINS",
];

/// Best-effort support for a pre-manager installation that only has the
/// standard DATABASE_URL. The manager itself always writes the clearer split
/// fields, but this prevents an upgrade from silently disabling accounts.
fn legacy_database_url_fields(value: &str) -> Option<(String, String, String, String, String)> {
    let fields = shared_config::parse_database_url(value).ok()?;
    Some((
        fields.host,
        fields.port.to_string(),
        fields.database,
        fields.user,
        fields.password,
    ))
}

/// Convert installations created by earlier manager releases to the compact
/// operator configuration. Derived fields are discarded; they are recreated
/// in .runtime.env every time Docker Compose is invoked.
fn normalize_owner_environment(content: &str) -> Result<String, String> {
    let mut normalized = migrate_document(content)?;
    let values = parse_env(&normalized);

    let play_host = values
        .get("BOX_PLAY_PUBLIC_HOST")
        .cloned()
        .or_else(|| {
            values
                .get("BOX_PLAY_PUBLIC_URL")
                .and_then(|url| host_from_http_url(url))
        })
        .or_else(|| values.get("BOX_BIND_IP").cloned())
        .filter(|host| validate_host(host, "游玩端访问地址").is_ok())
        .unwrap_or_else(default_public_host);
    let creator_host = values
        .get("BOX_CREATOR_HOST")
        .cloned()
        .or_else(|| {
            values
                .get("BOX_CREATOR_PUBLIC_URL")
                .and_then(|url| host_from_http_url(url))
        })
        .or_else(|| values.get("BOX_CREATOR_BIND_IP").cloned())
        .filter(|host| validate_creator_host(host).is_ok())
        .unwrap_or_else(default_creator_host);
    let creator_network_mode = values
        .get("BOX_CREATOR_NETWORK_MODE")
        .map(String::as_str)
        .filter(|mode| validate_creator_network_mode(mode).is_ok())
        .unwrap_or("local");

    set_env(&mut normalized, "BOX_PLAY_PUBLIC_HOST", &play_host)?;
    set_env(&mut normalized, "BOX_CREATOR_HOST", &creator_host)?;
    set_env(
        &mut normalized,
        "BOX_CREATOR_NETWORK_MODE",
        creator_network_mode,
    )?;

    // Old versions duplicated the database password in five manager-only
    // variables. Move it to the standard database fields once and remove the
    // duplicate copies.
    for (target, legacy) in [
        ("BOX_DATABASE_HOST", "BOX_DEPLOYMENT_MANAGER_DATABASE_HOST"),
        ("BOX_DATABASE_PORT", "BOX_DEPLOYMENT_MANAGER_DATABASE_PORT"),
        ("BOX_DATABASE_NAME", "BOX_DEPLOYMENT_MANAGER_DATABASE_NAME"),
        ("BOX_DATABASE_USER", "BOX_DEPLOYMENT_MANAGER_DATABASE_USER"),
        (
            "BOX_DATABASE_PASSWORD",
            "BOX_DEPLOYMENT_MANAGER_DATABASE_PASSWORD",
        ),
    ] {
        if !values.contains_key(target) {
            if let Some(value) = values.get(legacy) {
                set_env(&mut normalized, target, value)?;
            }
        }
        remove_env(&mut normalized, legacy);
    }
    let has_database_fields = [
        "BOX_DATABASE_HOST",
        "BOX_DATABASE_PORT",
        "BOX_DATABASE_NAME",
        "BOX_DATABASE_USER",
        "BOX_DATABASE_PASSWORD",
    ]
    .iter()
    .any(|key| values.get(*key).is_some_and(|value| !value.is_empty()));
    if !has_database_fields {
        if let Some((host, port, database, user, password)) = values
            .get("BOX_DATABASE_URL")
            .and_then(|value| legacy_database_url_fields(value))
        {
            set_env(&mut normalized, "BOX_DATABASE_HOST", &host)?;
            set_env(&mut normalized, "BOX_DATABASE_PORT", &port)?;
            set_env(&mut normalized, "BOX_DATABASE_NAME", &database)?;
            set_env(&mut normalized, "BOX_DATABASE_USER", &user)?;
            set_env(&mut normalized, "BOX_DATABASE_PASSWORD", &password)?;
        }
    }
    let normalized_values = parse_env(&normalized);
    let database_mode = normalized_values
        .get("BOX_DATABASE_MODE")
        .map(String::as_str)
        .filter(|mode| matches!(*mode, "managed" | "external"))
        .unwrap_or_else(|| {
            if normalized_values
                .get("BOX_DATABASE_HOST")
                .is_some_and(|host| !host.trim().is_empty())
            {
                "external"
            } else {
                "managed"
            }
        });
    set_env(&mut normalized, "BOX_DATABASE_MODE", database_mode)?;
    if database_mode == "managed" {
        remove_env(&mut normalized, "BOX_DATABASE_QUERY");
    }
    let redis_mode = normalized_values
        .get("BOX_REDIS_MODE")
        .map(String::as_str)
        .filter(|mode| matches!(*mode, "disabled" | "managed" | "external"))
        .unwrap_or_else(|| {
            if normalized_values
                .get("REDIS_HOST")
                .is_some_and(|host| !host.trim().is_empty())
            {
                "external"
            } else {
                "disabled"
            }
        });
    set_env(&mut normalized, "BOX_REDIS_MODE", redis_mode)?;
    for key in GENERATED_ENV_KEYS {
        remove_env(&mut normalized, key);
    }
    // Compose already supplies these defaults. Keep a value only when the
    // owner intentionally changed it as an advanced override.
    for (key, default) in [
        ("BOX_DATABASE_SCHEMA", "box_engine"),
        ("BOX_IDENTITY_DATABASE_SCHEMA", "box_identity"),
        ("BOX_DATABASE_POOL_SIZE", "4"),
        ("BOX_DATABASE_SSL_REJECT_UNAUTHORIZED", "true"),
        ("STORAGE_CACHE_REDIS_TTL", "240"),
        ("BOX_RUNTIME_IDLE_TIMEOUT_MS", "900000"),
        ("BOX_TRUST_PROXY", "false"),
    ] {
        if values.get(key).is_some_and(|value| value == default) {
            remove_env(&mut normalized, key);
        }
    }
    // This contains the same credential as the split configuration above and
    // belongs only in the generated runtime file.
    remove_env(&mut normalized, "BOX_DATABASE_URL");
    remove_env(&mut normalized, "BOX_PLAYER_SERVICE_INTERNAL_URL");
    Ok(box_manager_core::access_settings::independent_owner(&normalized))
}

/// Creator and VOXA are deliberately constrained to loopback or a private
/// network address. This is applied after raw editing too, so changing a
/// derived variable can never bypass the deployment policy.
fn enforce_creator_network_policy(app: &AppHandle) -> Result<bool, String> {
    let path = env_path(app)?;
    if !path.exists() {
        return Ok(false);
    }
    let original =
        fs::read_to_string(&path).map_err(|error| format!("无法读取部署配置：{error}"))?;
    let normalized = normalize_owner_environment(&original)?;
    if normalized != original {
        write_private_file(&path, normalized, "部署配置")?;
        return Ok(true);
    }
    Ok(false)
}

use shared_config::database_url;

/// Assemble the persisted runtime file and the view returned to its callers.
fn assemble_runtime_environment(
    owner: String,
    derived: BTreeMap<String, String>,
) -> Result<(String, BTreeMap<String, String>), String> {
    let mut runtime = owner;
    for (key, value) in derived {
        set_env(&mut runtime, &key, &value)?;
    }
    let values = parse_env(&runtime);
    Ok((runtime, values))
}

fn generate_runtime_environment(app: &AppHandle) -> Result<BTreeMap<String, String>, String> {
    ensure_runtime_files(app)?;
    enforce_creator_network_policy(app)?;
    let mut owner =
        fs::read_to_string(env_path(app)?).map_err(|error| format!("无法读取部署配置：{error}"))?;
    let existing = parse_env(&owner);
    let moderation_secret = resolve_secret("BOX_MODERATION_SIGNING_SECRET", "", &existing)?;
    set_env(&mut owner, "BOX_MODERATION_SIGNING_SECRET", &moderation_secret)?;
    write_private_file(&env_path(app)?, &owner, "部署配置")?;
    let values = parse_env(&owner);
    let lan_ip = detect_lan_ip();
    let mut derived = shared_config::runtime_environment(
        &values,
        &shared_config::RuntimeInputs {
            lan_ip: lan_ip.as_deref(),
            image_tag: IMAGE_TAG,
            platform: if cfg!(target_arch = "aarch64") {
                "linux/arm64"
            } else {
                "linux/amd64"
            },
            database_required: false,
            web_manager: false,
        },
    )?;
    box_manager_core::ssl::apply_runtime_urls(&runtime_root(app)?, &values, &mut derived)?;
    let (runtime, runtime_values) = assemble_runtime_environment(owner, derived)?;
    let runtime_path = runtime_env_path(app)?;
    if fs::read_to_string(&runtime_path).ok().as_deref() != Some(runtime.as_str()) {
        write_private_file(&runtime_path, runtime, "运行时配置")?;
    }
    Ok(runtime_values)
}

use shared_config::validate_port;

fn enabled_services(_values: &BTreeMap<String, String>) -> Vec<&str> {
    SERVICE_NAMES.to_vec()
}

fn check_remote_endpoint(label: &str, host: &str, port: u16) -> Result<(), String> {
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析{label}地址 {host}:{port}：{error}"))?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "无法连接{label} {host}:{port}：{}。请检查云安全组、防火墙和监听地址。",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "没有可用地址".into())
    ))
}

fn minutes_to_milliseconds(minutes: u32) -> u64 {
    u64::from(minutes) * 60_000
}

fn memory_mebibytes(value: Option<&String>, fallback: u32) -> u32 {
    let Some(value) = value.map(|value| value.trim().to_ascii_lowercase()) else {
        return fallback;
    };
    let parsed = if let Some(number) = value.strip_suffix('g') {
        number
            .parse::<f64>()
            .ok()
            .map(|gigabytes| (gigabytes * 1024.0).round() as u32)
    } else if let Some(number) = value.strip_suffix('m') {
        number
            .parse::<f64>()
            .ok()
            .map(|megabytes| megabytes.round() as u32)
    } else {
        value.parse::<u32>().ok()
    };
    parsed.filter(|memory| *memory > 0).unwrap_or(fallback)
}

fn load_existing_env(app: &AppHandle) -> BTreeMap<String, String> {
    env_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|content| parse_env(&content))
        .unwrap_or_default()
}

fn validate_install_configuration(config: &InstallConfigInput) -> Result<(), String> {
    let value = serde_json::to_value(config).map_err(|error| error.to_string())?;
    shared_config::validate_configuration(value.as_object().ok_or("配置格式无效")?)
}

fn validate_optional_public_address(value: &str, label: &str) -> Result<String, String> {
    shared_config::validate_public_address_override(value, label)
        .map_err(|error| format!("{label}：{error}"))
}

/// Preserve explicit per-service ranges supplied by advanced configurations.
fn normalize_access_defaults(config: &mut InstallConfigInput) {
    if config.creator_host.trim().is_empty() { config.creator_host = config.public_host.clone(); }
}

/// Compare the migrated owner values before the submitted fields overwrite them.
fn configuration_document_for_save(
    source: &str,
    config: &InstallConfigInput,
) -> Result<String, String> {
    let mut content = normalize_owner_environment(source)?;
    let submitted = serde_json::to_value(config).map_err(|error| error.to_string())?;
    clear_overrides_on_configuration_change(
        &mut content,
        submitted.as_object().ok_or("配置格式无效")?,
    )?;
    Ok(content)
}

fn default_public_address_mode() -> String { "independent".into() }

fn save_configuration(app: &AppHandle, mut config: InstallConfigInput) -> Result<(), String> {
    if config.public_ssl_configured.is_empty() {config.public_ssl_configured = box_manager_core::public_access::certificate_flags(&runtime_root(app)?);}
    let incoming = serde_json::to_value(&config).map_err(|error|error.to_string())?;
    let prepared = box_manager_core::public_access::prepare(incoming.as_object().ok_or("配置格式无效")?)?;
    config = serde_json::from_value(serde_json::Value::Object(prepared)).map_err(|error|error.to_string())?;
    ensure_runtime_files(app)?;
    normalize_access_defaults(&mut config);
    let database_mode = validate_database_mode(&config.database_mode)?;
    let redis_mode = validate_redis_mode(&config.redis_mode)?;
    let submitted_addresses = serde_json::to_value(&config).map_err(|error| error.to_string())?;
    if let Some(base) = shared_config::independent_public_base(submitted_addresses.as_object().ok_or("配置格式无效")?)? { config.public_address = base; }
    if config.public_address.trim().is_empty() { config.public_address = "127.0.0.1".into(); }
    let (public_host, public_scheme) =
        shared_config::parse_public_address(&config.public_address, "公网地址")?;
    config.public_host = public_host.clone();
    config.creator_host = public_host.clone();
    validate_install_configuration(&config)?;
    config.auth_portal_image =
        box_manager_core::auth_portal::normalize_image(&config.auth_portal_image, IMAGE_TAG)?;
    let creator_host = validate_creator_host(&config.creator_host)?;
    validate_creator_network_mode(&config.creator_network_mode)?;
    config.play_public_address_override =
        validate_optional_public_address(&config.play_public_address_override, "Play 公网地址")?;
    config.player_service_public_address_override = validate_optional_public_address(
        &config.player_service_public_address_override,
        "后台管理公网地址",
    )?;
    config.auth_portal_public_address_override = validate_optional_public_address(
        &config.auth_portal_public_address_override,
        "登录页面公网地址",
    )?;
    config.creator_public_address_override = validate_optional_public_address(
        &config.creator_public_address_override,
        "ARENA 公网地址",
    )?;
    config.voxa_public_address_override =
        validate_optional_public_address(&config.voxa_public_address_override, "VOXA 公网地址")?;

    let existing_file = env_path(app)?;
    let source = if existing_file.exists() {
        fs::read_to_string(&existing_file).map_err(|error| format!("无法读取现有配置：{error}"))?
    } else {
        ENV_TEMPLATE.to_string()
    };
    let mut content = configuration_document_for_save(&source, &config)?;
    let existing = parse_env(&content);
    if config.auth_portal_image.is_empty() {
        remove_env(&mut content, "BOX_AUTH_PORTAL_IMAGE");
    } else {
        set_env(
            &mut content,
            "BOX_AUTH_PORTAL_IMAGE",
            &config.auth_portal_image,
        )?;
    }

    set_env(
        &mut content,
        "PERMISSION_TOKEN_SECRET",
        &resolve_secret(
            "PERMISSION_TOKEN_SECRET",
            &config.permission_token_secret,
            &existing,
        )?,
    )?;
    set_env(
        &mut content,
        "BOX_PLAYER_AUTH_API_KEY",
        &resolve_secret(
            "BOX_PLAYER_AUTH_API_KEY",
            &config.player_auth_api_key,
            &existing,
        )?,
    )?;
    set_env(
        &mut content,
        "BOX_PLAY_ADMIN_TOKEN",
        &resolve_secret("BOX_PLAY_ADMIN_TOKEN", &config.play_admin_token, &existing)?,
    )?;
    // Keep this credential stable across Play restarts. Isolated map
    // containers retain it so they can continue to allocate private rooms
    // through the Play Library's Docker-only control endpoint.
    set_env(
        &mut content,
        "BOX_TELEPORT_INTERNAL_TOKEN",
        &resolve_secret("BOX_TELEPORT_INTERNAL_TOKEN", "", &existing)?,
    )?;
    // Separate, non-browser credential for Creator -> Runtime Manager calls.
    set_env(
        &mut content,
        "BOX_MODERATION_SIGNING_SECRET",
        &resolve_secret("BOX_MODERATION_SIGNING_SECRET", "", &existing)?,
    )?;
    // It is intentionally not part of the editable installation form.
    set_env(
        &mut content,
        "BOX_RUNTIME_MANAGER_TOKEN",
        &resolve_secret("BOX_RUNTIME_MANAGER_TOKEN", "", &existing)?,
    )?;
    set_env(
        &mut content,
        "BOX_SERVER_MANAGER_TOKEN",
        &resolve_secret("BOX_SERVER_MANAGER_TOKEN", "", &existing)?,
    )?;
    remove_env(&mut content, "BOX_PLAY_LIBRARY_READ_ONLY");
    set_env(
        &mut content,
        "BOX_PLAYER_REGISTRATION_ENABLED",
        if config.registration_enabled {
            "true"
        } else {
            "false"
        },
    )?;
    set_env(&mut content, "BOX_PLAY_PUBLIC_HOST", &public_host)?;
    set_env(&mut content, "BOX_PUBLIC_SCHEME", public_scheme)?;
    for (key, host_key, url_key, address) in [
        (
            "BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_PLAY_PUBLIC_HOST_OVERRIDE",
            "BOX_PLAY_PUBLIC_URL_OVERRIDE",
            &config.play_public_address_override,
        ),
        (
            "BOX_CREATOR_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_CREATOR_PUBLIC_HOST_OVERRIDE",
            "BOX_CREATOR_PUBLIC_URL_OVERRIDE",
            &config.creator_public_address_override,
        ),
        (
            "BOX_VOXA_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_VOXA_PUBLIC_HOST_OVERRIDE",
            "BOX_VOXA_PUBLIC_URL_OVERRIDE",
            &config.voxa_public_address_override,
        ),
        (
            "BOX_PLAYER_SERVICE_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_PLAYER_SERVICE_PUBLIC_HOST_OVERRIDE",
            "BOX_PLAYER_SERVICE_PUBLIC_URL_OVERRIDE",
            &config.player_service_public_address_override,
        ),
        (
            "BOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_AUTH_PORTAL_PUBLIC_HOST_OVERRIDE",
            "BOX_AUTH_PORTAL_PUBLIC_URL_OVERRIDE",
            &config.auth_portal_public_address_override,
        ),
    ] {
        remove_env(&mut content, host_key);
        remove_env(&mut content, url_key);
        set_env(&mut content, key, address)?;
    }
    remove_env(&mut content, "BOX_PLAYER_LOGIN_URL_OVERRIDE");
    set_env(
        &mut content,
        "BOX_PLAY_NETWORK_MODE",
        &config.play_network_mode,
    )?;
    set_env(&mut content, "BOX_CREATOR_HOST", &creator_host)?;
    set_env(
        &mut content,
        "BOX_CREATOR_NETWORK_MODE",
        &config.creator_network_mode,
    )?;
    set_env(&mut content, "BOX_PLAY_PORT", &config.play_port.to_string())?;
    set_env(&mut content, "BOX_VOXA_PORT", &config.voxa_port.to_string())?;
    set_env(
        &mut content,
        "BOX_CREATOR_PORT",
        &config.creator_port.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_PLAYER_SERVICE_PORT",
        &config.player_service_port.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_AUTH_PORTAL_PORT",
        &config.auth_portal_port.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_PLAY_MAX_RUNTIMES",
        &config.play_runtimes.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_CREATOR_EDIT_MAX_RUNTIMES",
        &config.creator_edit_runtimes.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_CREATOR_PLAY_MAX_RUNTIMES",
        &config.creator_play_runtimes.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_CREATOR_EDIT_PREWARM_RUNTIMES",
        &config.creator_edit_prewarm_runtimes.to_string(),
    )?;
    remove_env(&mut content, "BOX_CREATOR_PLAY_PREWARM_RUNTIMES");
    set_env(
        &mut content,
        "BOX_PLAY_PREWARM_RUNTIMES",
        &config.play_prewarm_runtimes.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_LOCAL_PLAYER_LIMIT",
        &config.player_limit.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_RUNTIME_IDLE_TIMEOUT_MS",
        &minutes_to_milliseconds(config.runtime_idle_minutes).to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_RUNTIME_START_TIMEOUT_MS",
        &minutes_to_milliseconds(config.runtime_start_timeout_minutes).to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_TELEPORT_MAX_ROOMS",
        &config.teleport_max_rooms.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS",
        &minutes_to_milliseconds(config.teleport_room_idle_minutes).to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_SCRIPT_HEAP_MB",
        &config.script_memory_mb.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_SCRIPT_MEMORY_MB",
        &config.script_memory_mb.to_string(),
    )?;
    for (key, value) in [
        (
            "BOX_PLAYER_SERVICE_MEMORY_LIMIT",
            format!("{}m", config.player_service_memory_mb),
        ),
        (
            "BOX_PLAYER_SERVICE_CPU_LIMIT",
            config.player_service_cpu_limit.to_string(),
        ),
        (
            "BOX_AUTH_PORTAL_MEMORY_LIMIT",
            format!("{}m", config.auth_portal_memory_mb),
        ),
        (
            "BOX_AUTH_PORTAL_CPU_LIMIT",
            config.auth_portal_cpu_limit.to_string(),
        ),
        (
            "BOX_CREATOR_MEMORY_LIMIT",
            format!("{}m", config.creator_memory_mb),
        ),
        (
            "BOX_CREATOR_CPU_LIMIT",
            config.creator_cpu_limit.to_string(),
        ),
        (
            "BOX_PLAY_MEMORY_LIMIT",
            format!("{}m", config.play_memory_mb),
        ),
        ("BOX_PLAY_CPU_LIMIT", config.play_cpu_limit.to_string()),
    ] {
        set_env(&mut content, key, &value)?;
    }
    let host = if database_mode == "managed" {
        "managed-postgres".to_string()
    } else {
        validate_host(&config.database_host, "数据库地址")?
    };
    let port = if database_mode == "managed" {
        5432
    } else {
        validate_port(&config.database_port)?
    };
    let existing_database_mode = existing
        .get("BOX_DATABASE_MODE")
        .map(String::as_str)
        .filter(|mode| matches!(*mode, "managed" | "external"))
        .unwrap_or_else(|| {
            if existing
                .get("BOX_DATABASE_HOST")
                .is_some_and(|host| !host.trim().is_empty())
            {
                "external"
            } else {
                "managed"
            }
        });
    let (database, user) = if database_mode == "managed" {
        if let Some(identity) = managed_database_identity(&existing) {
            identity
        } else if managed_database_volume_exists() {
            return Err("检测到已有内置 PostgreSQL 数据，但缺少其原始连接凭据。为避免覆盖既有数据，已停止切换；请恢复此前的 .env 后重试。".into());
        } else {
            (
                format!("box_db_{}", random_hex(8)),
                format!("box_user_{}", random_hex(8)),
            )
        }
    } else {
        (
            config.database_name.trim().to_string(),
            config.database_user.trim().to_string(),
        )
    };
    if database.is_empty() || user.is_empty() {
        return Err("PostgreSQL 数据库名和账号不能为空".into());
    }
    let saved_password = if database_mode == "managed" {
        managed_database_password(&existing)
    } else {
        (existing_database_mode == database_mode)
            .then(|| {
                existing
                    .get("BOX_DATABASE_PASSWORD")
                    .or_else(|| existing.get("BOX_DEPLOYMENT_MANAGER_DATABASE_PASSWORD"))
                    .cloned()
                    .filter(|password| !password.is_empty())
            })
            .flatten()
    };
    let password = if database_mode == "managed" {
        saved_password.unwrap_or_else(|| random_hex(32))
    } else if config.database_password.is_empty() {
        saved_password.unwrap_or_default()
    } else {
        config.database_password.clone()
    };
    if database_mode == "managed" && password.is_empty() {
        return Err("内置 PostgreSQL 数据库密码不能为空".into());
    }
    let existing_redis_mode = existing
        .get("BOX_REDIS_MODE")
        .map(String::as_str)
        .filter(|mode| matches!(*mode, "disabled" | "managed" | "external"))
        .unwrap_or_else(|| {
            if existing
                .get("REDIS_HOST")
                .is_some_and(|host| !host.trim().is_empty())
            {
                "external"
            } else {
                "disabled"
            }
        });
    let saved_redis_password = if redis_mode == "managed" {
        managed_redis_password(&existing)
    } else {
        (existing_redis_mode == redis_mode)
            .then(|| {
                existing
                    .get("REDIS_PASSWORD")
                    .cloned()
                    .filter(|password| !password.is_empty())
            })
            .flatten()
    };
    let (redis_host, redis_port, redis_password) = match redis_mode {
        "managed" => {
            let password = if !config.redis_password.is_empty() {
                config.redis_password.clone()
            } else {
                saved_redis_password.unwrap_or_else(|| random_hex(32))
            };
            ("managed-redis".into(), "6379".into(), password)
        }
        "external" => {
            let host = validate_host(&config.redis_host, "Redis 地址")?;
            let port = validate_port(&config.redis_port)?;
            let password = if config.redis_password.is_empty() {
                saved_redis_password.unwrap_or_default()
            } else {
                config.redis_password.clone()
            };
            (host, port.to_string(), password)
        }
        "disabled" => (String::new(), String::new(), String::new()),
        _ => unreachable!(),
    };
    let (redis_db, storage_cache_redis_db, storage_cache_redis_ttl) = if redis_mode == "managed" {
        (0, 1, 240)
    } else {
        (
            config.redis_db,
            config.storage_cache_redis_db,
            config.storage_cache_redis_ttl,
        )
    };
    set_env(&mut content, "BOX_DATABASE_MODE", database_mode)?;
    set_env(&mut content, "BOX_DATABASE_HOST", &host)?;
    set_env(&mut content, "BOX_DATABASE_PORT", &port.to_string())?;
    set_env(&mut content, "BOX_DATABASE_NAME", &database)?;
    set_env(&mut content, "BOX_DATABASE_USER", &user)?;
    set_env(&mut content, "BOX_DATABASE_PASSWORD", &password)?;
    if database_mode == "managed" {
        set_env(&mut content, "BOX_MANAGED_POSTGRES_DATABASE", &database)?;
        set_env(&mut content, "BOX_MANAGED_POSTGRES_USER", &user)?;
        set_env(&mut content, "BOX_MANAGED_POSTGRES_PASSWORD", &password)?;
    }
    set_env(
        &mut content,
        "BOX_DATABASE_SSL",
        if database_mode == "external" && config.database_ssl {
            "true"
        } else {
            "false"
        },
    )?;
    set_env(&mut content, "BOX_REDIS_MODE", redis_mode)?;
    set_env(&mut content, "REDIS_HOST", &redis_host)?;
    set_env(&mut content, "REDIS_PORT", &redis_port)?;
    set_env(&mut content, "REDIS_PASSWORD", &redis_password)?;
    if redis_mode == "managed" {
        set_env(&mut content, "BOX_MANAGED_REDIS_PASSWORD", &redis_password)?;
    }
    set_env(&mut content, "REDIS_DB", &redis_db.to_string())?;
    set_env(
        &mut content,
        "STORAGE_CACHE_REDIS_DB",
        &storage_cache_redis_db.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_DATABASE_POOL_SIZE",
        &(if database_mode == "managed" {
            10
        } else {
            config.database_pool_size
        })
        .to_string(),
    )?;
    set_env(
        &mut content,
        "STORAGE_CACHE_REDIS_TTL",
        &storage_cache_redis_ttl.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_AUTO_BACKUP_ENABLED",
        if config.auto_backup_enabled {
            "true"
        } else {
            "false"
        },
    )?;
    set_env(
        &mut content,
        "BOX_AUTO_BACKUP_INTERVAL_MINUTES",
        &config.auto_backup_interval_minutes.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_AUTO_BACKUP_RETENTION_COUNT",
        &config.auto_backup_retention_count.to_string(),
    )?;
    set_env(
        &mut content,
        "BOX_AUTO_BACKUP_RETENTION_DAYS",
        &config.auto_backup_retention_days.to_string(),
    )?;
    // The submitted mode is now authoritative, including external -> managed.
    if database_mode == "managed" {
        remove_env(&mut content, "BOX_DATABASE_QUERY");
    }
    let submitted = serde_json::to_value(&config).map_err(|error|error.to_string())?;
    content = box_manager_core::public_access::save_document(&content, submitted.as_object().ok_or("配置格式无效")?)?;
    content = box_manager_core::access_settings::save(
        &content,
        &config.public_address,
        &config.play_network_mode,
        &config.creator_network_mode,
        detect_lan_ip().as_deref(),
    )?;
    if config.external_nginx_manual {content = box_manager_core::access_settings::preserve_network(&source,&content)?;}
    write_private_file(&existing_file, content, "部署配置")?;
    generate_runtime_environment(app)?;
    Ok(())
}

fn offline_archive_search_roots(app: Option<&AppHandle>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            roots.push(resource_dir.clone());
            roots.push(resource_dir.join("payload"));
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            roots.extend(parent.ancestors().take(5).map(Path::to_path_buf));
        }
    }
    // Do not compile CARGO_MANIFEST_DIR into release binaries: it exposes the
    // builder's username and checkout path. These working-directory fallbacks
    // retain source-development discovery without embedding an absolute path.
    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir.join("payload"));
        roots.push(current_dir.join("src-tauri").join("payload"));
        roots.push(
            current_dir
                .join("apps")
                .join("deployment-manager")
                .join("src-tauri")
                .join("payload"),
        );
    }
    roots.sort();
    roots.dedup();
    roots
}

fn archive_candidates(app: Option<&AppHandle>) -> Vec<PathBuf> {
    let mut archives = Vec::new();
    for root in offline_archive_search_roots(app) {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if (name.starts_with("box-local-engine-images-")
                    || name.starts_with("box3-images-"))
                    && (name.ends_with(".tar.gz") || name.ends_with(".tar"))
                {
                    archives.push(entry.path());
                }
            }
        }
    }
    archives.sort();
    archives.dedup();
    archives
}

fn verify_offline_image_archive(app: &AppHandle, archive: &Path) -> Result<String, String> {
    let archive_name = archive
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("离线镜像归档名称无效")?;
    let expected_platform = if cfg!(target_arch = "aarch64") {
        "linux/arm64"
    } else {
        "linux/amd64"
    };
    let manifest = offline_archive_search_roots(Some(app))
        .into_iter()
        .map(|root| root.join("BOX-OFFLINE-IMAGE.json"))
        .find_map(|path| fs::read_to_string(path).ok())
        .ok_or("离线包缺少完整性清单 BOX-OFFLINE-IMAGE.json，请重新下载完整离线包")?;
    let manifest: OfflineImageManifest = serde_json::from_str(&manifest)
        .map_err(|error| format!("离线镜像完整性清单格式无效：{error}"))?;
    if manifest.format_version != 1
        || manifest.archive != archive_name
        || manifest.image_tag != IMAGE_TAG
        || manifest.platform != expected_platform
        || manifest.sha256.len() != 64
        || !manifest
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("离线镜像与当前启动器不匹配，请下载同一版本、同一架构的完整离线包".into());
    }
    let actual = file_sha256(archive).map_err(|error| format!("无法校验离线镜像：{error}"))?;
    if !actual.eq_ignore_ascii_case(&manifest.sha256) {
        return Err("离线镜像 SHA-256 校验失败，文件可能损坏或被替换，请重新下载离线包".into());
    }
    Ok(actual)
}

fn synchronize_runtime_image_tag(app: &AppHandle) -> Result<(), String> {
    // The image tag is owned by this application. It is generated into the
    // Docker-only file rather than being persisted in the operator's .env.
    if env_path(app)?.exists() {
        generate_runtime_environment(app)?;
    }
    Ok(())
}

fn offline_image_digest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join(format!(".offline-image-{IMAGE_TAG}.sha256")))
}

/// Report whether any application image the launcher starts is absent.
/// `inspect` returns true when the image is missing.
fn application_images_missing(tag: &str, inspect: &mut dyn FnMut(&str) -> bool) -> bool {
    SERVICE_NAMES.iter().any(|name| {
        let image = match *name {
            "player-auth-portal" => "box-local-engine-player-auth-portal".to_string(),
            other => format!("box-local-engine-{other}"),
        };
        inspect(&format!("{image}:{tag}"))
    })
}

fn ensure_images(app: &AppHandle, services: &[&str]) -> Result<(), String> {
    synchronize_runtime_image_tag(app)?;
    let tag = IMAGE_TAG;
    let missing = application_images_missing(tag, &mut |image| {
        docker_output(&["image", "inspect", image]).is_err()
    });
    let expected = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    if !missing {
        // Every image the launcher starts is already present under this
        // launcher's release tag. Prefer those local bits (operators may have
        // built them from this checkout) instead of replacing them with the
        // embedded catalog by digest.
        return Ok(());
    }
    if let Some(release) = crate::image_download::embedded_release()? {
        release.validate(expected)?;
        return crate::image_updates::prepare(&release, tag, services, &DesktopImageRuntime(app));
    }

    let archive = archive_candidates(Some(app))
        .into_iter()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().contains(expected))
        });
    let Some(archive) = archive else {
        // Neither a downloadable manifest nor a bundled archive is available.
        return Err(format!("未找到 {expected} 离线镜像归档。请重新下载完整离线包。"));
    };
    let archive_digest = verify_offline_image_archive(app, &archive)?;
    let digest_path = offline_image_digest_path(app)?;
    let imported_digest = fs::read_to_string(&digest_path)
        .ok()
        .map(|value| value.trim().to_string());
    // A corrected test build can retain the same release tag. Re-import when
    // the verified archive digest changes so Docker cannot keep serving an
    // older layer merely because that tag already exists locally.
    if !missing && imported_digest.as_deref() == Some(archive_digest.as_str()) {
        return Ok(());
    }
    let archive_string = archive.to_string_lossy().to_string();
    docker_output(&["load", "-i", &archive_string])?;
    write_private_file(
        &digest_path,
        format!("{archive_digest}\n"),
        "离线镜像导入记录",
    )?;
    Ok(())
}

fn managed_database_image(app: &AppHandle) -> String {
    load_existing_env(app)
        .get("BOX_POSTGRES_IMAGE")
        .cloned()
        .filter(|image| !image.trim().is_empty())
        .unwrap_or_else(|| MANAGED_DATABASE_IMAGE.into())
}

fn managed_database_enabled(app: &AppHandle) -> bool {
    load_existing_env(app)
        .get("BOX_DATABASE_MODE")
        .is_some_and(|mode| mode == "managed")
}

#[tauri::command]
fn has_managed_database_image(app: AppHandle) -> Result<bool, String> {
    docker_output(&["info", "--format", "{{.ServerVersion}}"])?;
    let image = managed_database_image(&app);
    Ok(docker_output(&["image", "inspect", &image]).is_ok())
}

#[tauri::command]
async fn prepare_managed_database(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        emit_progress(
            &app,
            "database-check",
            "正在检查 Docker 和 PostgreSQL 镜像…",
            10,
        );
        docker_output(&["info", "--format", "{{.ServerVersion}}"])?;
        let image = managed_database_image(&app);
        if docker_output(&["image", "inspect", &image]).is_ok() {
            emit_progress(&app, "database-image-ready", "PostgreSQL 镜像已就绪", 60);
            return Ok(());
        }
        emit_progress(
            &app,
            "database-image",
            "正在从国内镜像源下载 PostgreSQL 16…",
            20,
        );
        docker::pull_image(&image, "PostgreSQL", |percent, message| {
            emit_progress(&app, "dependency-image-download", &message, percent)
        })?;
        emit_progress(&app, "database-image-ready", "PostgreSQL 下载完成", 60);
        Ok(())
    })
    .await
    .map_err(|error| format!("数据库镜像下载任务异常结束：{error}"))?
}

fn managed_redis_image(app: &AppHandle) -> String {
    load_existing_env(app)
        .get("BOX_REDIS_IMAGE")
        .cloned()
        .filter(|image| !image.trim().is_empty())
        .unwrap_or_else(|| MANAGED_REDIS_IMAGE.into())
}

fn managed_redis_enabled(app: &AppHandle) -> bool {
    load_existing_env(app)
        .get("BOX_REDIS_MODE")
        .is_some_and(|mode| mode == "managed")
}

fn managed_service_installed(app: &AppHandle, service: &str) -> bool {
    let image = match service {
        "managed-postgres" => managed_database_image(app),
        "managed-redis" => managed_redis_image(app),
        _ => return false,
    };
    docker_output(&["image", "inspect", &image]).is_ok()
}

fn managed_service_configured(values: &BTreeMap<String, String>, service: &str) -> bool {
    match service {
        "managed-postgres" => {
            values
                .get("BOX_DATABASE_MODE")
                .is_some_and(|mode| mode == "managed")
                && managed_database_password(values).is_some()
        }
        "managed-redis" => {
            values
                .get("BOX_REDIS_MODE")
                .is_some_and(|mode| mode == "managed")
                && managed_redis_password(values).is_some()
        }
        _ => false,
    }
}

fn managed_database_volume_exists() -> bool {
    docker_output(&[
        "volume",
        "inspect",
        &format!("{PROJECT_NAME}_box-managed-postgres-data"),
    ])
    .is_ok()
}

fn managed_value(values: &BTreeMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .cloned()
        .filter(|value| !value.trim().is_empty())
}

fn managed_database_identity(existing: &BTreeMap<String, String>) -> Option<(String, String)> {
    let database = managed_value(existing, "BOX_MANAGED_POSTGRES_DATABASE");
    let user = managed_value(existing, "BOX_MANAGED_POSTGRES_USER");
    if let (Some(database), Some(user)) = (database, user) {
        return Some((database, user));
    }
    (existing
        .get("BOX_DATABASE_MODE")
        .is_some_and(|mode| mode == "managed"))
    .then(|| {
        Some((
            managed_value(existing, "BOX_DATABASE_NAME")?,
            managed_value(existing, "BOX_DATABASE_USER")?,
        ))
    })
    .flatten()
}

fn managed_database_password(existing: &BTreeMap<String, String>) -> Option<String> {
    managed_value(existing, "BOX_MANAGED_POSTGRES_PASSWORD").or_else(|| {
        (existing
            .get("BOX_DATABASE_MODE")
            .is_some_and(|mode| mode == "managed"))
        .then(|| managed_value(existing, "BOX_DATABASE_PASSWORD"))
        .flatten()
    })
}

fn managed_redis_password(existing: &BTreeMap<String, String>) -> Option<String> {
    managed_value(existing, "BOX_MANAGED_REDIS_PASSWORD").or_else(|| {
        (existing
            .get("BOX_REDIS_MODE")
            .is_some_and(|mode| mode == "managed"))
        .then(|| managed_value(existing, "REDIS_PASSWORD"))
        .flatten()
    })
}

#[tauri::command]
fn has_managed_redis_image(app: AppHandle) -> Result<bool, String> {
    docker_output(&["info", "--format", "{{.ServerVersion}}"])?;
    let image = managed_redis_image(&app);
    Ok(docker_output(&["image", "inspect", &image]).is_ok())
}

#[tauri::command]
async fn prepare_managed_redis(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        emit_progress(&app, "redis-check", "正在检查 Docker 和 Redis 镜像…", 10);
        docker_output(&["info", "--format", "{{.ServerVersion}}"])?;
        let image = managed_redis_image(&app);
        if docker_output(&["image", "inspect", &image]).is_ok() {
            emit_progress(&app, "redis-image-ready", "Redis 镜像已就绪", 60);
            return Ok(());
        }
        emit_progress(&app, "redis-image", "正在从国内镜像源下载 Redis 7…", 20);
        docker::pull_image(&image, "Redis", |percent, message| {
            emit_progress(&app, "dependency-image-download", &message, percent)
        })?;
        emit_progress(&app, "redis-image-ready", "Redis 下载完成", 60);
        Ok(())
    })
    .await
    .map_err(|error| format!("Redis 镜像下载任务异常结束：{error}"))?
}

fn managed_container_connectable(service: &str, host_port: &str) -> bool {
    docker_output(&[
        "ps",
        "--filter",
        &format!("label=com.docker.compose.project={PROJECT_NAME}"),
        "--filter",
        &format!("label=com.docker.compose.service={service}"),
        "--filter",
        "status=running",
        "--format",
        "{{.Ports}}",
    ])
    .is_ok_and(|output| {
        output
            .lines()
            .any(|line| line.contains(&format!("127.0.0.1:{host_port}->")))
    })
}

#[tauri::command]
async fn get_managed_service_info(app: AppHandle, service: String) -> Result<ManagedServiceInfo, String> {
    tauri::async_runtime::spawn_blocking(move || managed_service_info(app, service))
        .await.map_err(|error| error.to_string())?
}

fn managed_service_info(app: AppHandle, service: String) -> Result<ManagedServiceInfo, String> {
    let values = load_existing_env(&app);
    let host = "127.0.0.1".to_string();
    match service.as_str() {
        "postgresql" => {
            let image_available =
                docker_output(&["image", "inspect", &managed_database_image(&app)]).is_ok();
            let configured =
                image_available && managed_service_configured(&values, "managed-postgres");
            let port = values
                .get("BOX_MANAGED_POSTGRES_HOST_PORT")
                .cloned()
                .unwrap_or_else(|| "5432".into());
            let (database, user) =
                managed_database_identity(&values).unwrap_or_else(|| ("box".into(), "box".into()));
            let password = configured
                .then(|| managed_database_password(&values))
                .flatten()
                .unwrap_or_default();
            let connection_url = if configured {
                format!(
                    "postgresql://{}:{}@{}:{}/{}",
                    urlencoding::encode(&user),
                    urlencoding::encode(&password),
                    host,
                    port,
                    urlencoding::encode(&database)
                )
            } else {
                String::new()
            };
            Ok(ManagedServiceInfo {
                image_available,
                configured,
                running: managed_container_connectable("managed-postgres", &port),
                host,
                port,
                database,
                user,
                password,
                connection_url,
            })
        }
        "redis" => {
            let image_available =
                docker_output(&["image", "inspect", &managed_redis_image(&app)]).is_ok();
            let configured =
                image_available && managed_service_configured(&values, "managed-redis");
            let port = values
                .get("BOX_MANAGED_REDIS_HOST_PORT")
                .cloned()
                .unwrap_or_else(|| "6379".into());
            let database = values
                .get("REDIS_DB")
                .cloned()
                .unwrap_or_else(|| "0".into());
            let password = configured
                .then(|| managed_redis_password(&values))
                .flatten()
                .unwrap_or_default();
            let connection_url = if configured {
                format!(
                    "redis://:{}@{}:{}/{}",
                    urlencoding::encode(&password),
                    host,
                    port,
                    database
                )
            } else {
                String::new()
            };
            Ok(ManagedServiceInfo {
                image_available,
                configured,
                running: managed_container_connectable("managed-redis", &port),
                host,
                port,
                database,
                user: String::new(),
                password,
                connection_url,
            })
        }
        _ => Err("只支持读取内置 PostgreSQL 或 Redis 信息".into()),
    }
}

#[tauri::command]
async fn start_managed_service(app: AppHandle, service: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        let (mode_key, compose_service, label) = match service.as_str() {
            "postgresql" => ("BOX_DATABASE_MODE", "managed-postgres", "PostgreSQL"),
            "redis" => ("BOX_REDIS_MODE", "managed-redis", "Redis"),
            _ => return Err("只支持启动内置 PostgreSQL 或 Redis".into()),
        };
        let values = load_existing_env(&app);
        if !values.get(mode_key).is_some_and(|mode| mode == "managed") {
            return Err(format!("请先保存内置 {label} 配置"));
        }
        emit_progress(
            &app,
            "managed-service",
            &format!("正在启动内置 {label}…"),
            85,
        );
        compose_output(&app, &["up", "-d", "--wait", compose_service])?;
        emit_progress(
            &app,
            "managed-service",
            &format!("内置 {label} 已可连接"),
            100,
        );
        Ok(())
    })
    .await
    .map_err(|error| format!("内置服务启动任务异常结束：{error}"))?
}

fn saved_public_address_override(
    values: &BTreeMap<String, String>,
    address_key: &str,
    host_key: &str,
    url_key: &str,
    fallback_url_key: Option<&str>,
) -> String {
    if let Some(value) = values.get(&address_key.replace("_PUBLIC_ADDRESS_OVERRIDE","_INDEPENDENT_PUBLIC_ADDRESS")) { return value.clone(); }

    if let Some(address) = values.get(address_key) {
        return address.clone();
    }
    if let Some(url) = values
        .get(url_key)
        .or_else(|| fallback_url_key.and_then(|key| values.get(key)))
    {
        return url.clone();
    }
    values
        .get(host_key)
        .map(|host| {
            if host.parse::<IpAddr>().is_ok() {
                host.clone()
            } else {
                // The previous launcher treated custom DNS hosts as HTTPS.
                format!("https://{host}")
            }
        })
        .unwrap_or_default()
}

#[tauri::command]
fn get_install_config(app: AppHandle) -> InstallConfigView {
    // Loading configuration is also a policy boundary: a manually edited
    // public Creator address is normalized before it reaches the UI.
    let _ = enforce_creator_network_policy(&app);
    let values = load_existing_env(&app);
    if values.is_empty() {
        return InstallConfigView::default();
    }
    let number_u32 = |name: &str, fallback| {
        values
            .get(name)
            .and_then(|value| value.parse().ok())
            .unwrap_or(fallback)
    };
    let number_u8 = |name: &str, fallback| {
        values
            .get(name)
            .and_then(|value| value.parse().ok())
            .unwrap_or(fallback)
    };
    let number_f64 = |name: &str, fallback| {
        values
            .get(name)
            .and_then(|value| value.parse().ok())
            .unwrap_or(fallback)
    };
    let enabled = |name: &str, fallback| {
        values
            .get(name)
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(fallback)
    };
    let milliseconds_as_minutes = |name: &str, fallback_minutes: u32| {
        values
            .get(name)
            .and_then(|value| value.parse::<u64>().ok())
            .and_then(|milliseconds| {
                let rounded_up = milliseconds.saturating_add(59_999) / 60_000;
                u32::try_from(rounded_up).ok()
            })
            .filter(|minutes| *minutes > 0)
            .unwrap_or(fallback_minutes)
    };
    let public_host = values
        .get("BOX_PLAY_PUBLIC_HOST")
        .cloned()
        .unwrap_or_else(default_public_host);
    let public_address = box_manager_core::access_settings::public_address(&values);
    let public_view = box_manager_core::public_access::view(&values);
    InstallConfigView {
        database_mode: values
            .get("BOX_DATABASE_MODE")
            .cloned()
            .filter(|mode| matches!(mode.as_str(), "managed" | "external"))
            .unwrap_or_else(|| {
                if values
                    .get("BOX_DATABASE_HOST")
                    .is_some_and(|host| !host.trim().is_empty())
                {
                    "external".into()
                } else {
                    default_database_mode()
                }
            }),
        database_host: values.get("BOX_DATABASE_HOST").cloned().unwrap_or_default(),
        database_port: values
            .get("BOX_DATABASE_PORT")
            .cloned()
            .unwrap_or_else(default_database_port),
        database_name: values
            .get("BOX_DATABASE_NAME")
            .cloned()
            .unwrap_or_else(default_database_name),
        database_user: values
            .get("BOX_DATABASE_USER")
            .cloned()
            .unwrap_or_else(default_database_user),
        database_ssl: values
            .get("BOX_DATABASE_SSL")
            .is_some_and(|value| value == "true"),
        has_database_password: values
            .get("BOX_DATABASE_PASSWORD")
            .is_some_and(|value| !value.is_empty()),
        has_permission_token_secret: values
            .get("PERMISSION_TOKEN_SECRET")
            .is_some_and(|value| value.len() >= 16),
        has_player_auth_api_key: values
            .get("BOX_PLAYER_AUTH_API_KEY")
            .is_some_and(|value| value.len() >= 16),
        has_play_admin_token: values
            .get("BOX_PLAY_ADMIN_TOKEN")
            .is_some_and(|value| value.len() >= 16),
        redis_mode: values
            .get("BOX_REDIS_MODE")
            .cloned()
            .filter(|mode| matches!(mode.as_str(), "disabled" | "managed" | "external"))
            .unwrap_or_else(|| {
                if values
                    .get("REDIS_HOST")
                    .is_some_and(|host| !host.trim().is_empty())
                {
                    "external".into()
                } else {
                    default_redis_mode()
                }
            }),
        redis_host: values.get("REDIS_HOST").cloned().unwrap_or_default(),
        redis_port: values
            .get("REDIS_PORT")
            .cloned()
            .unwrap_or_else(default_redis_port),
        has_redis_password: values
            .get("REDIS_PASSWORD")
            .is_some_and(|value| !value.is_empty()),
        redis_db: number_u8("REDIS_DB", 0),
        storage_cache_redis_db: number_u8("STORAGE_CACHE_REDIS_DB", 1),
        database_pool_size: number_u32("BOX_DATABASE_POOL_SIZE", 4),
        storage_cache_redis_ttl: number_u8("STORAGE_CACHE_REDIS_TTL", 240),
        auto_backup_enabled: values
            .get("BOX_AUTO_BACKUP_ENABLED")
            .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on")),
        auto_backup_interval_minutes: number_u32("BOX_AUTO_BACKUP_INTERVAL_MINUTES", 60),
        auto_backup_retention_count: number_u32("BOX_AUTO_BACKUP_RETENTION_COUNT", 24),
        auto_backup_retention_days: number_u32("BOX_AUTO_BACKUP_RETENTION_DAYS", 30),
        public_host,
        public_address,
        public_address_mode: public_view["publicAddressMode"].as_str().unwrap_or("independent").into(),
        shared_public_address: public_view["sharedPublicAddress"].as_str().unwrap_or("").into(),
        public_ssl_configured: runtime_root(&app).map(|root|box_manager_core::public_access::certificate_flags(&root)).unwrap_or_default(),
        public_service_paths: serde_json::from_value(public_view["publicServicePaths"].clone()).unwrap_or_default(),        play_public_address_override: saved_public_address_override(
            &values,
            "BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_PLAY_PUBLIC_HOST_OVERRIDE",
            "BOX_PLAY_PUBLIC_URL_OVERRIDE",
            None,
        ),
        creator_public_address_override: saved_public_address_override(
            &values,
            "BOX_CREATOR_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_CREATOR_PUBLIC_HOST_OVERRIDE",
            "BOX_CREATOR_PUBLIC_URL_OVERRIDE",
            None,
        ),
        voxa_public_address_override: saved_public_address_override(
            &values,
            "BOX_VOXA_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_VOXA_PUBLIC_HOST_OVERRIDE",
            "BOX_VOXA_PUBLIC_URL_OVERRIDE",
            None,
        ),
        player_service_public_address_override: saved_public_address_override(
            &values,
            "BOX_PLAYER_SERVICE_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_PLAYER_SERVICE_PUBLIC_HOST_OVERRIDE",
            "BOX_PLAYER_SERVICE_PUBLIC_URL_OVERRIDE",
            None,
        ),
        auth_portal_public_address_override: saved_public_address_override(
            &values,
            "BOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_AUTH_PORTAL_PUBLIC_HOST_OVERRIDE",
            "BOX_AUTH_PORTAL_PUBLIC_URL_OVERRIDE",
            Some("BOX_PLAYER_LOGIN_URL_OVERRIDE"),
        ),
        play_network_mode: values
            .get("BOX_PLAY_NETWORK_MODE")
            .cloned()
            .unwrap_or_else(default_play_network_mode),
        creator_network_mode: values
            .get("BOX_CREATOR_NETWORK_MODE")
            .cloned()
            .unwrap_or_else(default_creator_network_mode),
        creator_host: values
            .get("BOX_CREATOR_HOST")
            .cloned()
            .unwrap_or_else(default_creator_host),
        lan_ip: detect_lan_ip().unwrap_or_default(),
        play_port: number_u32("BOX_PLAY_PORT", 3121).try_into().unwrap_or(3121),
        voxa_port: number_u32("BOX_VOXA_PORT", 3123).try_into().unwrap_or(3123),
        creator_port: number_u32("BOX_CREATOR_PORT", 3127)
            .try_into()
            .unwrap_or(3127),
        player_service_port: number_u32("BOX_PLAYER_SERVICE_PORT", 3124)
            .try_into()
            .unwrap_or(3124),
        auth_portal_port: number_u32("BOX_AUTH_PORTAL_PORT", 3125)
            .try_into()
            .unwrap_or(3125),
        auth_portal_image: values
            .get("BOX_AUTH_PORTAL_IMAGE")
            .cloned()
            .unwrap_or_default(),
        play_runtimes: number_u32("BOX_PLAY_MAX_RUNTIMES", 8),
        creator_edit_runtimes: number_u32("BOX_CREATOR_EDIT_MAX_RUNTIMES", 6),
        creator_play_runtimes: number_u32("BOX_CREATOR_PLAY_MAX_RUNTIMES", 4),
        creator_edit_prewarm_runtimes: number_u32("BOX_CREATOR_EDIT_PREWARM_RUNTIMES", 0),
        play_prewarm_runtimes: number_u32("BOX_PLAY_PREWARM_RUNTIMES", 0),
        player_limit: number_u32("BOX_LOCAL_PLAYER_LIMIT", 70),
        script_memory_mb: number_u32("BOX_SCRIPT_MEMORY_MB", 512),
        runtime_idle_minutes: milliseconds_as_minutes("BOX_RUNTIME_IDLE_TIMEOUT_MS", 15),
        runtime_start_timeout_minutes: milliseconds_as_minutes("BOX_RUNTIME_START_TIMEOUT_MS", 30),
        teleport_max_rooms: number_u32("BOX_TELEPORT_MAX_ROOMS", 64),
        teleport_room_idle_minutes: milliseconds_as_minutes(
            "BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS",
            15,
        ),
        registration_enabled: enabled("BOX_PLAYER_REGISTRATION_ENABLED", true),
        player_service_memory_mb: memory_mebibytes(
            values.get("BOX_PLAYER_SERVICE_MEMORY_LIMIT"),
            1024,
        ),
        player_service_cpu_limit: number_f64("BOX_PLAYER_SERVICE_CPU_LIMIT", 1.0),
        auth_portal_memory_mb: memory_mebibytes(values.get("BOX_AUTH_PORTAL_MEMORY_LIMIT"), 128),
        auth_portal_cpu_limit: number_f64("BOX_AUTH_PORTAL_CPU_LIMIT", 0.5),
        creator_memory_mb: memory_mebibytes(values.get("BOX_CREATOR_MEMORY_LIMIT"), 6144),
        creator_cpu_limit: number_f64("BOX_CREATOR_CPU_LIMIT", 2.0),
        play_memory_mb: memory_mebibytes(values.get("BOX_PLAY_MEMORY_LIMIT"), 4096),
        play_cpu_limit: number_f64("BOX_PLAY_CPU_LIMIT", 2.0),
    }
}

#[tauri::command]
fn get_owner_secrets(app: AppHandle) -> Result<OwnerSecretsView, String> {
    let values = load_existing_env(&app);
    let secret = |name: &str| {
        values
            .get(name)
            .filter(|value| value.len() >= 16)
            .cloned()
            .ok_or_else(|| "服主密钥尚未生成，请先保存一次配置".to_string())
    };
    Ok(OwnerSecretsView {
        permission_token_secret: secret("PERMISSION_TOKEN_SECRET")?,
        player_auth_api_key: secret("BOX_PLAYER_AUTH_API_KEY")?,
        play_admin_token: secret("BOX_PLAY_ADMIN_TOKEN")?,
    })
}

#[tauri::command]
fn get_raw_environment(app: AppHandle) -> Result<String, String> {
    ensure_runtime_files(&app)?;
    enforce_creator_network_policy(&app)?;
    let path = env_path(&app)?;
    if path.exists() {
        fs::read_to_string(path).map_err(|error| format!("无法读取 .env：{error}"))
    } else {
        Ok(ENV_TEMPLATE.to_string())
    }
}

#[tauri::command]
fn save_raw_environment(app: AppHandle, content: String) -> Result<bool, String> {
    let _operation = box_manager_core::operation::mutation_guard()?;
    validate_raw_environment(&content)?;
    ensure_runtime_files(&app)?;
    write_private_file(
        &env_path(&app)?,
        format!("{}\n", content.trim_end()),
        ".env",
    )?;
    let normalized = enforce_creator_network_policy(&app)?;
    generate_runtime_environment(&app)?;
    Ok(normalized)
}

#[tauri::command]
fn get_raw_nginx_config(app: AppHandle) -> Result<String, String> {
    box_manager_core::ssl::read_raw_nginx_config(&runtime_root(&app)?)
}

#[tauri::command]
fn save_raw_nginx_config(app: AppHandle, content: String) -> Result<bool, String> {
    let _operation = box_manager_core::operation::mutation_guard()?;
    let root = runtime_root(&app)?;
    box_manager_core::ssl::save_raw_nginx_config(&root, &root, &content, &mut |args| {
        docker_output(&args.iter().map(String::as_str).collect::<Vec<_>>())
    })
}

#[tauri::command]
async fn get_system_status(app: AppHandle) -> Result<SystemStatus, String> {
    tauri::async_runtime::spawn_blocking(move || system_status(app))
        .await.map_err(|error| error.to_string())
}

fn system_status(app: AppHandle) -> SystemStatus {
    let _ = enforce_creator_network_policy(&app);
    let data_directory = runtime_root(&app)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let docker = docker_check();
    let mut docker_ready = docker.engine_ready;
    let docker_cli_available = docker.cli_available;
    let docker_cli_version = docker.cli_version;
    let mut docker_message = docker.message;
    let configured = env_path(&app).is_ok_and(|path| path.exists());
    let environment = load_existing_env(&app);
    let output = if docker_ready && configured {
        match compose_output(&app, &["ps", "--all", "--format", "json"]) {
            Ok(output) => output,
            Err(error) => {
                docker_ready = false;
                docker_message = format!("无法读取服务状态：{error}");
                String::new()
            }
        }
    } else {
        String::new()
    };
    let mut services = services::statuses(&output, &environment);
    if !docker_ready {
        for service in &mut services {
            service.state = "unknown".into();
        }
    }
    let all_healthy = services
        .iter()
        .filter(|service| service.enabled)
        .all(|service| service.running);
    SystemStatus {
        docker_ready,
        docker_cli_available,
        docker_cli_version,
        docker_message,
        configured,
        all_healthy,
        services,
        data_directory,
    }
}

fn docker_check() -> DockerCheck {
    let cli = match docker_output(&["--version"]) {
        Ok(version) => version,
        Err(error) => {
            return DockerCheck {
                cli_available: false,
                cli_version: String::new(),
                engine_ready: false,
                message: docker_message(error),
            }
        }
    };
    match docker_output(&["info", "--format", "{{.ServerVersion}}"]) {
        Ok(_) => DockerCheck {
            cli_available: true,
            cli_version: cli,
            engine_ready: true,
            message: "Docker Desktop 已连接。".into(),
        },
        Err(error) => DockerCheck {
            cli_available: true,
            cli_version: cli,
            engine_ready: false,
            message: docker_message(error),
        },
    }
}

#[tauri::command]
async fn get_docker_check() -> Result<DockerCheck, String> {
    tauri::async_runtime::spawn_blocking(docker_check)
        .await.map_err(|error| error.to_string())
}

fn unavailable_runtime_status() -> RuntimeEndpointStatus {
    RuntimeEndpointStatus {
        phase: "unavailable".into(),
        percent: 0,
        message: "运行时未启动".into(),
        updated_at: String::new(),
        cpu_percent: None,
        memory_bytes: None,
        uptime_ms: None,
        process_count: 0,
        rooms: Vec::new(),
    }
}

fn runtime_is_active(status: &RuntimeEndpointStatus) -> bool {
    !matches!(status.phase.as_str(), "idle" | "unavailable")
}

fn decode_chunked_http_body(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut cursor = 0;
    let mut body = Vec::new();
    loop {
        let line_end = bytes[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")?
            + cursor;
        let size = std::str::from_utf8(&bytes[cursor..line_end])
            .ok()?
            .split(';')
            .next()?
            .trim();
        let size = usize::from_str_radix(size, 16).ok()?;
        cursor = line_end + 2;
        if bytes.len() < cursor + size + 2 || &bytes[cursor + size..cursor + size + 2] != b"\r\n" {
            return None;
        }
        body.extend_from_slice(&bytes[cursor..cursor + size]);
        cursor += size + 2;
        if size == 0 {
            return Some(body);
        }
    }
}

fn try_read_http_response(response: &[u8]) -> Option<(String, String)> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&response[..header_end])
        .ok()?
        .to_string();
    let payload = &response[header_end + 4..];
    let body = if headers.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("transfer-encoding")
                && value.trim().eq_ignore_ascii_case("chunked")
        })
    }) {
        decode_chunked_http_body(payload)?
    } else if let Some(length) = headers.lines().find_map(|line| {
        line.split_once(':').and_then(|(name, value)| {
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
    }) {
        (payload.len() >= length).then(|| payload[..length].to_vec())?
    } else {
        payload.to_vec()
    };
    String::from_utf8(body).ok().map(|body| (headers, body))
}

fn read_http_response(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => return try_read_http_response(&response),
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if let Some(parsed) = try_read_http_response(&response) {
                    return Some(parsed);
                }
                if response.len() > 128 * 1024 {
                    return None;
                }
            }
            Err(_) => return None,
        }
    }
}

fn runtime_endpoint_status_at(
    project_id: &str,
    address: SocketAddr,
    route_prefix: &str,
) -> RuntimeEndpointStatus {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(800)) else {
        return unavailable_runtime_status();
    };
    // An isolated runtime also asks Docker for CPU/memory stats.  Docker
    // Desktop can take longer than 1.2s here, which otherwise makes a
    // healthy map appear as disconnected in the catalog.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let route_prefix = route_prefix.trim_matches('/');
    let path = if route_prefix.is_empty() {
        format!("/{project_id}/__local_runtime/status")
    } else {
        format!("/{route_prefix}/{project_id}/__local_runtime/status")
    };
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return unavailable_runtime_status();
    }
    let Some((headers, body)) = read_http_response(&mut stream) else {
        return unavailable_runtime_status();
    };
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        return unavailable_runtime_status();
    }
    let Ok(value) = serde_json::from_str::<Value>(&body) else {
        return unavailable_runtime_status();
    };
    let percent = value
        .get("percent")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(100) as u8;
    RuntimeEndpointStatus {
        phase: value
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("idle")
            .into(),
        percent,
        message: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        updated_at: value
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        cpu_percent: value.get("cpuPercent").and_then(Value::as_f64),
        memory_bytes: value.get("memoryBytes").and_then(Value::as_u64),
        uptime_ms: value.get("uptimeMs").and_then(Value::as_u64),
        process_count: value
            .get("processCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u32::MAX as u64) as u32,
        rooms: value
            .get("rooms")
            .and_then(Value::as_array)
            .map(|rooms| {
                rooms
                    .iter()
                    .filter_map(|room| {
                        Some(RuntimeRoomStatus {
                            room_id: room.get("roomId")?.as_str()?.into(),
                            active: room.get("active").and_then(Value::as_bool).unwrap_or(false),
                            created_at: room.get("createdAt").and_then(Value::as_u64).unwrap_or(0),
                            last_access_at: room
                                .get("lastAccessAt")
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn runtime_endpoint_status(project_id: &str, port: u16) -> RuntimeEndpointStatus {
    let address = format!("127.0.0.1:{port}");
    let Some(address) = address
        .to_socket_addrs()
        .ok()
        .and_then(|mut values| values.next())
    else {
        return unavailable_runtime_status();
    };
    runtime_endpoint_status_at(project_id, address, "")
}

fn play_runtime_status(project_id: &str, port: u16) -> RuntimeEndpointStatus {
    let address = format!("127.0.0.1:{port}");
    let Some(address) = address
        .to_socket_addrs()
        .ok()
        .and_then(|mut values| values.next())
    else {
        return unavailable_runtime_status();
    };
    runtime_endpoint_status_at(project_id, address, "p")
}

fn destroy_runtime_at(
    project_id: &str,
    address: SocketAddr,
    route_prefix: &str,
    room_id: Option<&str>,
) -> Result<(), String> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| format!("无法连接运行时：{error}"))?;
    let prefix = route_prefix.trim_matches('/');
    let path = match room_id {
        Some(room_id) if prefix.is_empty() => {
            format!("/{project_id}/__room/{room_id}/__local_runtime/destroy")
        }
        Some(room_id) => {
            format!("/{prefix}/{project_id}/__room/{room_id}/__local_runtime/destroy")
        }
        None if prefix.is_empty() => format!("/{project_id}/__local_runtime/destroy"),
        None => format!("/{prefix}/{project_id}/__local_runtime/destroy"),
    };
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("无法发送销毁请求：{error}"))?;
    let Some((headers, _)) = read_http_response(&mut stream) else {
        return Err("运行时没有返回销毁结果".into());
    };
    if headers.starts_with("HTTP/1.1 204") || headers.starts_with("HTTP/1.0 204") {
        Ok(())
    } else {
        Err(format!(
            "运行时拒绝销毁请求：{}",
            headers.lines().next().unwrap_or("未知错误")
        ))
    }
}

#[tauri::command]
async fn destroy_project_runtime(
    app: AppHandle,
    project_id: String,
    mode: String,
    room_id: Option<String>,
) -> Result<(), String> {
    if !project_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-')
        || project_id.is_empty()
    {
        return Err("作品 ID 无效".into());
    }
    if let Some(room) = room_id.as_deref() {
        if room.is_empty()
            || !room.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '_' || character == '-'
            })
        {
            return Err("房间 ID 无效".into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        let (port, route_prefix) = match mode.as_str() {
            "creator" => (9967, ""),
            "play" => {
                let port = fs::read_to_string(env_path(&app)?)
                    .ok()
                    .map(|content| {
                        env_port(&parse_env(&content), "BOX_PLAY_PORT", default_play_port())
                    })
                    .unwrap_or_else(default_play_port);
                (port, "p")
            }
            _ => return Err("运行端类型无效".into()),
        };
        let address = format!("127.0.0.1:{port}")
            .to_socket_addrs()
            .ok()
            .and_then(|mut values| values.next())
            .ok_or("运行时地址无效")?;
        destroy_runtime_at(&project_id, address, route_prefix, room_id.as_deref())
    })
    .await
    .map_err(|error| format!("销毁运行时异常结束：{error}"))?
}

fn map_runtime_profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("apps/local-engine/data/map-runtime-profiles.json"))
}

fn read_map_runtime_profiles(app: &AppHandle) -> Result<MapRuntimeProfilesFile, String> {
    let path = map_runtime_profiles_path(app)?;
    match fs::read_to_string(path) {
        Ok(content) => {
            serde_json::from_str(&content).map_err(|error| format!("地图容器配置格式无效：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(MapRuntimeProfilesFile {
            version: 1,
            profiles: vec![],
        }),
        Err(error) => Err(format!("无法读取地图容器配置：{error}")),
    }
}

fn write_map_runtime_profiles(
    app: &AppHandle,
    document: &MapRuntimeProfilesFile,
) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("无法编码地图容器配置：{error}"))?;
    write_private_file(&map_runtime_profiles_path(app)?, encoded, "地图容器配置")
}

#[tauri::command]
fn list_map_runtime_profiles(app: AppHandle) -> Result<Vec<MapRuntimeProfile>, String> {
    let mut profiles = read_map_runtime_profiles(&app)?.profiles;
    profiles.sort_by(|left, right| {
        (&left.permanent_map_id, &left.mode).cmp(&(&right.permanent_map_id, &right.mode))
    });
    Ok(profiles
        .into_iter()
        .filter(|profile| profile.mode == "play")
        .collect())
}

#[tauri::command]
fn save_map_runtime_profile(app: AppHandle, profile: MapRuntimeProfile) -> Result<(), String> {
    validate_map_runtime_profile(&profile)?;
    let mut document = read_map_runtime_profiles(&app)?;
    document.version = 1;
    document.profiles.retain(|candidate| {
        candidate.permanent_map_id != profile.permanent_map_id || candidate.mode != profile.mode
    });
    document.profiles.push(profile);
    write_map_runtime_profiles(&app, &document)
}

#[tauri::command]
fn delete_map_runtime_profile(
    app: AppHandle,
    permanent_map_id: String,
    mode: String,
) -> Result<(), String> {
    if !valid_permanent_map_id(&permanent_map_id) || mode != "play" {
        return Err("地图容器配置标识无效".into());
    }
    let mut document = read_map_runtime_profiles(&app)?;
    document.profiles.retain(|candidate| {
        candidate.permanent_map_id != permanent_map_id || candidate.mode != mode
    });
    write_map_runtime_profiles(&app, &document)
}

#[tauri::command]
fn get_project_runtime_status(app: AppHandle) -> Result<ProjectRuntimeCatalog, String> {
    let runtime = runtime_root(&app)?;
    let play_port = fs::read_to_string(env_path(&app)?)
        .ok()
        .map(|content| env_port(&parse_env(&content), "BOX_PLAY_PORT", default_play_port()))
        .unwrap_or_else(default_play_port);
    let mut creator = fs::read_dir(runtime.join("apps/local-engine/projects"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let project_id = entry.file_name().to_string_lossy().to_string();
            let metadata = fs::read_to_string(entry.path().join("project.json")).ok()?;
            let project = serde_json::from_str::<Value>(&metadata).ok()?;
            Some(ProjectRuntimeStatus {
                name: project
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&project_id)
                    .into(),
                permanent_map_id: project
                    .get("permanentMapId")
                    .and_then(Value::as_str)
                    .unwrap_or(&project_id)
                    .into(),
                map_role: project
                    .get("mapRole")
                    .and_then(Value::as_str)
                    .unwrap_or("main")
                    .into(),
                main_project_id: project
                    .get("mainProjectId")
                    .and_then(Value::as_str)
                    .unwrap_or(&project_id)
                    .into(),
                edit: runtime_endpoint_status(&project_id, 9967),
                play: unavailable_runtime_status(),
                project_id,
            })
        })
        .collect::<Vec<_>>();
    let mut play = fs::read_dir(runtime.join("apps/local-engine/play-worlds"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let project_id = entry.file_name().to_string_lossy().to_string();
            let metadata = fs::read_to_string(entry.path().join("manifest.json")).ok()?;
            let world = serde_json::from_str::<Value>(&metadata).ok()?;
            (world.get("id").and_then(Value::as_str) == Some(project_id.as_str())).then(|| {
                ProjectRuntimeStatus {
                    name: world
                        .get("projectName")
                        .and_then(Value::as_str)
                        .unwrap_or(&project_id)
                        .into(),
                    permanent_map_id: world
                        .get("permanentMapId")
                        .and_then(Value::as_str)
                        .unwrap_or(&project_id)
                        .into(),
                    map_role: world
                        .get("mapRole")
                        .and_then(Value::as_str)
                        .unwrap_or("main")
                        .into(),
                    main_project_id: world
                        .get("mainProjectId")
                        .and_then(Value::as_str)
                        .unwrap_or(&project_id)
                        .into(),
                    edit: unavailable_runtime_status(),
                    play: play_runtime_status(&project_id, play_port),
                    project_id,
                }
            })
        })
        .collect::<Vec<_>>();
    creator.sort_by(|left, right| left.name.cmp(&right.name));
    play.sort_by(|left, right| left.name.cmp(&right.name));
    let play_maps = play.clone();
    creator.retain(|project| runtime_is_active(&project.edit));
    play.retain(|project| runtime_is_active(&project.play));
    Ok(ProjectRuntimeCatalog {
        creator,
        play,
        play_maps,
    })
}

#[tauri::command]
fn get_about_info() -> AboutInfo {
    let image_platform = if IMAGE_TAG.ends_with("-arm64") {
        "linux/arm64"
    } else if IMAGE_TAG.ends_with("-amd64") {
        "linux/amd64"
    } else {
        "由 Docker 自动选择"
    };
    let embedded_images = serde_json::from_str::<EmbeddedImageInfo>(IMAGE_INFO)
        .unwrap_or(EmbeddedImageInfo { images: vec![] })
        .images;
    let service_images = [
        ("地图创作工具 / 创作作品管理", "box-local-engine-creator"),
        ("模型创作工具", "box-local-engine-voxa"),
        ("游玩端", "box-local-engine-play"),
        ("账号服务", "box-local-engine-player-service"),
        ("登录页面", "box-local-engine-player-auth-portal"),
    ]
    .into_iter()
    .map(|(name, image)| {
        let embedded = embedded_images
            .iter()
            .find(|candidate| candidate.image == image);
        ServiceImageInfo {
            name: name.into(),
            image: image.into(),
            tag: embedded
                .map(|candidate| candidate.tag.clone())
                .unwrap_or_else(|| IMAGE_TAG.into()),
            platform: embedded
                .map(|candidate| candidate.platform.clone())
                .unwrap_or_else(|| image_platform.into()),
            image_id: embedded
                .map(|candidate| candidate.image_id.clone())
                .unwrap_or_else(|| "unknown".into()),
            created_at: embedded
                .map(|candidate| candidate.created_at.clone())
                .unwrap_or_else(|| "unknown".into()),
            source_revision: embedded
                .map(|candidate| candidate.source_revision.clone())
                .unwrap_or_else(|| "unknown".into()),
            build_source: embedded
                .map(|candidate| candidate.build_source.clone())
                .unwrap_or_else(|| "unknown".into()),
        }
    })
    .collect();

    AboutInfo {
        application_version: ROOT_VERSION.into(),
        image_tag: IMAGE_TAG.into(),
        source_revision: option_env!("BOX_BUILD_COMMIT").unwrap_or("unknown").into(),
        build_created_at: option_env!("BOX_BUILD_DATE").unwrap_or("unknown").into(),
        build_source: option_env!("BOX_BUILD_SOURCE").unwrap_or("local").into(),
        platform: std::env::consts::OS.into(),
        architecture: std::env::consts::ARCH.into(),
        license: "MIT License".into(),
        service_images,
    }
}

#[tauri::command]
fn get_legal_notices() -> LegalNotices {
    LegalNotices {
        license_name: "MIT License".into(),
        license_text: include_str!("../../../../distribution/LICENSE.txt").into(),
    }
}

fn parse_percentage(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_end_matches('%')
        .trim()
        .parse()
        .unwrap_or(0.0)
}

fn split_memory_usage(value: Option<&Value>) -> (String, String) {
    let usage = value.and_then(Value::as_str).unwrap_or_default();
    let mut parts = usage.splitn(2, '/').map(str::trim);
    (
        parts.next().unwrap_or("0 B").to_string(),
        parts.next().unwrap_or("—").to_string(),
    )
}

#[tauri::command]
async fn get_performance_status(app: AppHandle) -> Result<PerformanceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        docker_output(&["info", "--format", "{{.ServerVersion}}"]).map_err(docker_message)?;
        let environment = load_existing_env(&app);
        let enabled = enabled_services(&environment);
        let mut services: Vec<ServicePerformance> = SERVICE_NAMES
            .iter()
            .map(|name| ServicePerformance {
                name: (*name).into(),
                enabled: enabled.contains(name),
                running: false,
                cpu_percent: 0.0,
                memory_usage: "0 B".into(),
                memory_limit: "—".into(),
                memory_percent: 0.0,
                pids: 0,
            })
            .collect();

        if env_path(&app).is_ok_and(|path| path.exists()) {
            let compose = compose_output(&app, &["ps", "--format", "json"])?;
            let containers: Vec<Value> = serde_json::from_str(&compose).unwrap_or_else(|_| {
                compose
                    .lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect()
            });
            let mut running_containers = Vec::new();
            for container in containers {
                let name = container
                    .get("Service")
                    .or_else(|| container.get("service"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let state = container
                    .get("State")
                    .or_else(|| container.get("state"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let id = container
                    .get("ID")
                    .or_else(|| container.get("Id"))
                    .or_else(|| container.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(service) = services.iter_mut().find(|service| service.name == name) {
                    service.running = state.eq_ignore_ascii_case("running");
                    if service.running && !id.is_empty() {
                        running_containers.push((id.to_string(), name.to_string()));
                    }
                }
            }
            if !running_containers.is_empty() {
                let mut args = vec!["stats", "--no-stream", "--format", "{{json .}}"];
                args.extend(running_containers.iter().map(|(id, _)| id.as_str()));
                let stats = docker_output(&args)?;
                for value in stats
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                {
                    let stats_id = value
                        .get("ID")
                        .or_else(|| value.get("Container"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let Some((_, service_name)) = running_containers
                        .iter()
                        .find(|(id, _)| id.starts_with(stats_id) || stats_id.starts_with(id))
                    else {
                        continue;
                    };
                    let Some(service) = services
                        .iter_mut()
                        .find(|service| service.name == *service_name)
                    else {
                        continue;
                    };
                    service.cpu_percent = parse_percentage(value.get("CPUPerc"));
                    service.memory_percent = parse_percentage(value.get("MemPerc"));
                    (service.memory_usage, service.memory_limit) =
                        split_memory_usage(value.get("MemUsage"));
                    service.pids = value
                        .get("PIDs")
                        .and_then(|value| value.as_str().and_then(|value| value.parse().ok()))
                        .or_else(|| value.get("PIDs").and_then(Value::as_u64))
                        .unwrap_or(0);
                }
            }
        }
        Ok(PerformanceStatus {
            sampled_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            services,
        })
    })
    .await
    .map_err(|error| format!("性能采样任务异常结束：{error}"))?
}

#[tauri::command]
async fn test_remote_connection(
    app: AppHandle,
    kind: String,
    host: String,
    port: String,
    database: String,
    user: String,
    password: String,
    redis_db: u8,
) -> Result<ConnectionTest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let label = match kind.as_str() {
            "postgresql" => "PostgreSQL",
            "redis" => "Redis",
            _ => return Err("不支持的连接类型".into()),
        };
        let host = validate_host(&host, label)?;
        let port = validate_port(&port)?;
        let stored = load_existing_env(&app);
        if kind == "postgresql" {
            let database = if database.trim().is_empty() {
                stored.get("BOX_DATABASE_NAME").cloned().unwrap_or_default()
            } else {
                database.trim().into()
            };
            let user = if user.trim().is_empty() {
                stored.get("BOX_DATABASE_USER").cloned().unwrap_or_default()
            } else {
                user.trim().into()
            };
            let password = if password.is_empty() {
                stored
                    .get("BOX_DATABASE_PASSWORD")
                    .cloned()
                    .unwrap_or_default()
            } else {
                password
            };
            if database.is_empty() || user.is_empty() || password.is_empty() {
                return Err("请填写 PostgreSQL 数据库名、账号和密码后再测试".into());
            }
            let mut config = postgres::Config::new();
            config
                .host(&host)
                .port(port)
                .dbname(&database)
                .user(&user)
                .password(&password)
                .connect_timeout(Duration::from_secs(5));
            config
                .connect(NoTls)
                .map_err(|error| format!("PostgreSQL 连接失败：{error}"))?;
        } else {
            let password = if password.is_empty() {
                stored.get("REDIS_PASSWORD").cloned().unwrap_or_default()
            } else {
                password
            };
            let client = redis::Client::open(format!("redis://{host}:{port}/"))
                .map_err(|error| format!("Redis 客户端初始化失败：{error}"))?;
            let mut connection = client
                .get_connection()
                .map_err(|error| format!("Redis 连接失败：{error}"))?;
            if !password.is_empty() {
                redis::cmd("AUTH")
                    .arg(&password)
                    .query::<()>(&mut connection)
                    .map_err(|error| format!("Redis 认证失败：{error}"))?;
            }
            redis::cmd("SELECT")
                .arg(redis_db)
                .query::<()>(&mut connection)
                .map_err(|error| format!("Redis 数据库选择失败：{error}"))?;
            redis::cmd("PING")
                .query::<String>(&mut connection)
                .map_err(|error| format!("Redis 协议检查失败：{error}"))?;
        }
        Ok(ConnectionTest {
            ok: true,
            message: format!("{label} 服务连接并认证成功：{host}:{port}"),
        })
    })
    .await
    .map_err(|error| format!("连接测试异常结束：{error}"))?
}

fn validate_service_name(app: &AppHandle, service: &str) -> Result<bool, String> {
    if SERVICE_NAMES.contains(&service) {
        return Ok(false);
    }
    if !MANAGED_SERVICE_NAMES.contains(&service) {
        return Err("未知的 BOX 服务".into());
    }
    let values = load_existing_env(app);
    if !managed_service_configured(&values, service) {
        return Err("该内置基础服务尚未启用".into());
    }
    if !managed_service_installed(app, service) {
        return Err("该内置基础服务尚未安装".into());
    }
    Ok(true)
}

struct DesktopImageRuntime<'a>(&'a AppHandle);

impl crate::image_updates::Runtime for DesktopImageRuntime<'_> {
    fn docker(&self, args: &[&str]) -> Result<String, String> {
        docker_output(args)
    }
    fn acquire(&self, image: &crate::image_download::ImageRelease) -> Result<PathBuf, String> {
        self.acquire_many(&[image])?
            .pop()
            .ok_or("镜像下载结果缺失".into())
    }
    fn acquire_many(
        &self,
        images: &[&crate::image_download::ImageRelease],
    ) -> Result<Vec<PathBuf>, String> {
        let cache = self
            .0
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("engine-images");
        crate::image_download_batch::download(images, &cache, |downloads| {
            let _ = self.0.emit("install-progress", box_manager_core::services::InstallProgress::for_downloads(downloads.to_vec()));
        })
    }
    fn importing(&self, image: &crate::image_download::ImageRelease) {
        emit_progress(
            self.0,
            "image-import",
            &format!("{} 下载完成，正在导入 Docker…", image.image),
            100,
        );
    }
    fn discard(&self, archive: PathBuf) {
        let _ = fs::remove_file(archive);
    }
    fn pending(&self) -> Result<Vec<crate::image_updates::PendingImage>, String> {
        let path = runtime_root(self.0)?.join(".pending-image-updates.json");
        match fs::read_to_string(path) {
            Ok(value) => serde_json::from_str(&value).map_err(|e| format!("镜像更新记录无效：{e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        }
    }
    fn save(&self, pending: &[crate::image_updates::PendingImage]) -> Result<(), String> {
        write_private_file(
            &runtime_root(self.0)?.join(".pending-image-updates.json"),
            serde_json::to_string_pretty(pending).map_err(|e| e.to_string())?,
            "镜像更新记录",
        )
    }
    fn previous(&self, service: &str) -> Result<Vec<String>, String> {
        let containers = docker_output(&[
            "ps",
            "--all",
            "--quiet",
            "--filter",
            &format!("label=com.docker.compose.project={PROJECT_NAME}"),
            "--filter",
            &format!("label=com.docker.compose.service={service}"),
        ])?;
        containers
            .lines()
            .map(|id| {
                docker_output(&["inspect", id, "--format", "{{.Image}}"])
                    .map(|image| image.trim().to_string())
            })
            .collect()
    }
    fn ready(&self, service: &str, image: &crate::image_download::ImageRelease) -> Result<bool, String> {
        let containers = docker_output(&[
            "ps",
            "--all",
            "--quiet",
            "--filter",
            &format!("label=com.docker.compose.project={PROJECT_NAME}"),
            "--filter",
            &format!("label=com.docker.compose.service={service}"),
        ])?;
        if containers.trim().is_empty() {
            return Ok(false);
        }
        for container in containers.lines() {
            let details = docker_output(&["inspect", container, "--format", "{{json .}}"])?;
            let details: Value = serde_json::from_str(&details).map_err(|e| e.to_string())?;
            if !details["Image"].as_str().is_some_and(|id| image.accepts(id))
                || details["State"]["Running"].as_bool() != Some(true)
                || details["State"]["Health"]["Status"].as_str() != Some("healthy")
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn finalize_image_updates(app: &AppHandle) {
    if !image_cleanup_enabled(app) { return; }
    if let Ok(Some(catalog)) = crate::image_download::embedded_release() {
        if let Err(error) = crate::image_updates::finalize(&catalog, &DesktopImageRuntime(app)) {
            eprintln!("镜像清理已延后：{error}");
        }
    }
}

fn image_cleanup_enabled(app: &AppHandle) -> bool {
    app.path().app_config_dir().ok()
        .and_then(|root| fs::read_to_string(root.join("image-cleanup-choice.json")).ok())
        .is_some_and(|value| value.trim() == "true")
}

pub(crate) fn set_image_cleanup_choice(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::write(root.join("image-cleanup-choice.json"), if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

pub(crate) fn cleanup_images_before_launcher_restart(app: &AppHandle) -> Result<(), String> {
    use crate::image_updates::Runtime;
    let runtime = DesktopImageRuntime(app);
    if runtime.pending()?.is_empty() { return Ok(()); }
    let catalog = crate::image_download::embedded_release()?.ok_or("当前启动器没有镜像发行清单")?;
    crate::image_updates::cleanup_before_restart(&catalog, &runtime, PROJECT_NAME)
}

struct DesktopRuntime<'a>(&'a AppHandle);
impl ServiceRuntime for DesktopRuntime<'_> {
    fn prepare_images(&self, services: &[&str]) -> Result<(), String> {
        database_url(&generate_runtime_environment(self.0)?)?;
        docker_output(&["info", "--format", "{{.ServerVersion}}"])?;
        ensure_images(self.0, services)?;
        let mut values = load_existing_env(self.0);
        values.insert("BOX_IMAGE_TAG".into(), IMAGE_TAG.into());
        box_manager_core::auth_portal::prepare_custom_image(
            &values,
            if cfg!(target_arch = "aarch64") {
                "linux/arm64"
            } else {
                "linux/amd64"
            },
            docker_output,
            |stage, message, percent| emit_progress(self.0, stage, message, percent),
        )
    }
    fn managed_enabled(&self, service: &str) -> bool {
        match service {
            "managed-postgres" => managed_database_enabled(self.0),
            "managed-redis" => managed_redis_enabled(self.0),
            _ => false,
        }
    }
    fn check_managed(&self, service: &str) -> Result<(), String> {
        validate_service_name(self.0, service).map(|_| ())
    }
    fn compose(&self, args: &[&str]) -> Result<(), String> {
        let mut arguments = args.to_vec();
        if args.starts_with(&["up", "-d"]) && !args.contains(&"--wait") {
            arguments.splice(2..2, ["--wait", "--wait-timeout", "90"]);
        }
        compose_output(self.0, &arguments).map(|_| ())
    }
    fn progress(&self, stage: &str, message: &str, percent: u8) {
        emit_progress(self.0, stage, message, percent);
    }
}

#[tauri::command]
async fn control_service(app: AppHandle, service: String, action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        services::control(&DesktopRuntime(&app), &service, &action)?;
        if action == "start" { finalize_image_updates(&app); }
        Ok(())
    })
    .await
    .map_err(|error| format!("服务操作异常结束：{error}"))?
}

fn is_sensitive_env_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.contains("PASSWORD")
        || key.contains("SECRET")
        || key.contains("TOKEN")
        || key.contains("API_KEY")
        || key == "BOX_DATABASE_URL"
}

fn redact_text(mut text: String, values: &BTreeMap<String, String>) -> String {
    for (key, value) in values {
        if is_sensitive_env_key(key) && value.len() >= 4 {
            text = text.replace(value, "[REDACTED]");
        }
    }
    text
}

fn create_diagnostic_zip(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| format!("无法覆盖旧诊断包：{error}"))?;
    }
    #[cfg(target_os = "windows")]
    let command = {
        let mut command = Command::new("powershell");
        let source = source.to_string_lossy().replace('\'', "''");
        let destination = destination.to_string_lossy().replace('\'', "''");
        command.args([
            "-NoProfile",
            "-Command",
            &format!(
                "Compress-Archive -LiteralPath '{source}' -DestinationPath '{destination}' -Force"
            ),
        ]);
        command
    };
    #[cfg(target_os = "macos")]
    let command = {
        let mut command = Command::new("/usr/bin/ditto");
        command.args(["-c", "-k", "--norsrc"]);
        command.arg(source).arg(destination);
        command
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let command = {
        let mut command = Command::new("zip");
        command
            .arg("-r")
            .arg(destination)
            .arg(".")
            .current_dir(source);
        command
    };
    run_command(command)?;
    Ok(())
}

fn backup_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("apps/local-engine/backups"))
}

fn data_storage_info(app: &AppHandle) -> Result<DataStorageInfo, String> {
    let path = runtime_root(app)?;
    Ok(DataStorageInfo {
        using_default: path == default_runtime_root(app)?,
        path: path.to_string_lossy().into_owned(),
    })
}

fn has_running_desktop_services() -> Result<bool, String> {
    let output = docker_output(&[
        "ps",
        "--filter",
        &format!("label=com.docker.compose.project={PROJECT_NAME}"),
        "--filter",
        "status=running",
        "--format",
        "{{.ID}}",
    ])?;
    Ok(output.lines().any(|line| !line.trim().is_empty()))
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| format!("无法创建目标数据目录：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("无法读取数据目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取数据文件：{error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取数据文件类型：{error}"))?;
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("无法复制 {}：{error}", source_path.display()))?;
        } else {
            return Err(format!(
                "数据目录包含不支持迁移的特殊文件：{}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn get_data_storage_info(app: AppHandle) -> Result<DataStorageInfo, String> {
    data_storage_info(&app)
}

#[tauri::command]
fn choose_data_storage_directory() -> Result<Option<String>, String> {
    Ok(choose_data_storage_directory_native()?.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn relocate_data_storage(
    app: AppHandle,
    directory: String,
) -> Result<DataStorageInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        let source = runtime_root(&app)?;
        let parent = PathBuf::from(directory.trim());
        if !parent.is_absolute() {
            return Err("请选择一个本机磁盘上的绝对路径".into());
        }
        if !parent.exists() || !parent.is_dir() {
            return Err("所选数据目录不存在或不可用".into());
        }
        let destination = parent.join("BoxEngineData");
        if destination.exists() {
            return Err(format!(
                "目标目录已存在：{}。请选择一个新的空目录。",
                destination.display()
            ));
        }
        let source_canonical = source
            .canonicalize()
            .map_err(|error| format!("无法确认当前数据目录：{error}"))?;
        let parent_canonical = parent
            .canonicalize()
            .map_err(|error| format!("无法确认目标目录：{error}"))?;
        if parent_canonical.starts_with(&source_canonical) {
            return Err("不能将数据迁移到当前数据目录的内部".into());
        }
        if has_running_desktop_services()? {
            return Err("请先在服务总览停止全部服务，再迁移数据目录".into());
        }
        emit_progress(&app, "data-copy", "正在复制地图、模型、备份与配置…", 25);
        copy_directory(&source, &destination)?;
        emit_progress(&app, "data-switch", "正在切换到新的数据目录…", 80);
        write_private_file(
            &runtime_location_file(&app)?,
            format!("{}\n", destination.display()),
            "数据目录配置",
        )?;
        if let Err(error) = fs::remove_dir_all(&source) {
            return Err(format!(
                "数据已迁移到 {}，但无法删除旧目录 {}：{error}",
                destination.display(),
                source.display()
            ));
        }
        emit_progress(
            &app,
            "complete",
            "数据目录已迁移，请从服务总览重新启动服务",
            100,
        );
        data_storage_info(&app)
    })
    .await
    .map_err(|error| format!("数据迁移任务异常结束：{error}"))?
}

fn dialog_result(mut command: Command) -> Result<Option<PathBuf>, String> {
    let output = command
        .output()
        .map_err(|error| format!("无法打开文件选择器：{error}"))?;
    if !output.status.success() {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if detail.contains("User canceled") || detail.contains("-128") {
            return Ok(None);
        }
        return Err(format!("文件选择器未完成：{}", detail.trim()));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then(|| PathBuf::from(path)))
}

#[cfg(target_os = "macos")]
fn choose_data_storage_directory_native() -> Result<Option<PathBuf>, String> {
    let mut command = Command::new("/usr/bin/osascript");
    command.args([
        "-e",
        "POSIX path of (choose folder with prompt \"选择 BOX3 Engine 数据所在目录\")",
    ]);
    dialog_result(command)
}

#[cfg(target_os = "windows")]
fn choose_data_storage_directory_native() -> Result<Option<PathBuf>, String> {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择 BOX3 Engine 数据所在目录'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Output $d.SelectedPath}"]);
    dialog_result(command)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn choose_data_storage_directory_native() -> Result<Option<PathBuf>, String> {
    let mut command = Command::new("zenity");
    command.args([
        "--file-selection",
        "--directory",
        "--title=选择 BOX3 Engine 数据所在目录",
    ]);
    dialog_result(command)
}

#[cfg(target_os = "macos")]
fn choose_backup_import() -> Result<Option<PathBuf>, String> {
    let mut command = Command::new("/usr/bin/osascript");
    command.args([
        "-e",
        "POSIX path of (choose file with prompt \"选择 BOX3 Engine 备份包\")",
    ]);
    dialog_result(command)
}

#[cfg(target_os = "macos")]
fn choose_backup_export(name: &str) -> Result<Option<PathBuf>, String> {
    let safe_name = name.replace('\\', "\\\\").replace('"', "\\\"");
    let mut command = Command::new("/usr/bin/osascript");
    command.args([
        "-e",
        &format!(
            "POSIX path of (choose file name with prompt \"导出 BOX3 Engine 备份包\" default name \"{safe_name}\")"
        ),
    ]);
    dialog_result(command)
}

#[cfg(target_os = "macos")]
fn choose_diagnostic_export(name: &str) -> Result<Option<PathBuf>, String> {
    let safe_name = name.replace('\\', "\\\\").replace('"', "\\\"");
    let mut command = Command::new("/usr/bin/osascript");
    command.args([
        "-e",
        &format!(
            "POSIX path of (choose file name with prompt \"导出 BOX3 Engine 脱敏诊断包\" default name \"{safe_name}\")"
        ),
    ]);
    dialog_result(command)
}

#[cfg(target_os = "windows")]
fn choose_backup_import() -> Result<Option<PathBuf>, String> {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='BOX3 Engine backup (*.zip;*.tar;*.gz)|*.zip;*.tar;*.gz'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Output $d.FileName}"]);
    dialog_result(command)
}

#[cfg(target_os = "windows")]
fn choose_backup_export(name: &str) -> Result<Option<PathBuf>, String> {
    let safe_name = name.replace('\'', "''");
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-Command", &format!("Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.SaveFileDialog; $d.Filter='BOX3 Engine backup (*.zip;*.tar;*.gz)|*.zip;*.tar;*.gz'; $d.FileName='{safe_name}'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){{Write-Output $d.FileName}}")]);
    dialog_result(command)
}

#[cfg(target_os = "windows")]
fn choose_diagnostic_export(name: &str) -> Result<Option<PathBuf>, String> {
    let safe_name = name.replace('\'', "''");
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-Command", &format!("Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.SaveFileDialog; $d.Filter='BOX3 Engine diagnostics (*.zip)|*.zip'; $d.FileName='{safe_name}'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){{Write-Output $d.FileName}}")]);
    dialog_result(command)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn choose_backup_import() -> Result<Option<PathBuf>, String> {
    let mut command = Command::new("zenity");
    command.args([
        "--file-selection",
        "--title=选择 BOX3 Engine 备份包",
        "--file-filter=*.zip *.tar *.gz",
    ]);
    dialog_result(command)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn choose_backup_export(name: &str) -> Result<Option<PathBuf>, String> {
    let mut command = Command::new("zenity");
    command.args([
        "--file-selection",
        "--save",
        "--confirm-overwrite",
        "--filename",
        name,
    ]);
    dialog_result(command)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn choose_diagnostic_export(name: &str) -> Result<Option<PathBuf>, String> {
    let mut command = Command::new("zenity");
    command.args([
        "--file-selection",
        "--save",
        "--confirm-overwrite",
        "--title=导出 BOX3 Engine 脱敏诊断包",
        "--filename",
        name,
    ]);
    dialog_result(command)
}

#[tauri::command]
async fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || backup_store::list(&backup_directory(&app)?))
        .await
        .map_err(|error| format!("备份列表任务异常结束：{error}"))?
}

#[tauri::command]
async fn create_backup(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        emit_progress(&app, "backup", "正在创建数据备份…", 20);
        backup_store::create(&runtime_root(&app)?, &backup_directory(&app)?)
    })
    .await
    .map_err(|error| format!("备份任务异常结束：{error}"))?
}

#[tauri::command]
async fn inspect_backup(app: AppHandle, archive: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let archive = backup_store::resolve(&backup_directory(&app)?, &archive)?;
        let info = backup::validate_archive(&archive, backup::Limits::default())?;
        serde_json::to_value(info).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("备份检查任务异常结束：{error}"))?
}

#[tauri::command]
async fn restore_backup(
    app: AppHandle,
    archive: String,
    include_env: Option<bool>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        let archive = backup_store::resolve(&backup_directory(&app)?, &archive)?;
        emit_progress(&app, "restore-validate", "正在校验备份…", 10);
        let report = backup::restore_archive_with_env(
            &runtime_root(&app)?,
            &archive,
            backup::Limits::default(),
            include_env.unwrap_or(false),
            |_| {
                services::stop(&DesktopRuntime(&app))?;
                emit_progress(&app, "restore", "正在恢复数据…", 50);
                Ok(())
            },
        )?;
        emit_progress(&app, "complete", "恢复完成", 100);
        Ok(report.cleanup_warning)
    })
    .await
    .map_err(|error| format!("恢复任务异常结束：{error}"))?
}

#[tauri::command]
async fn delete_backup(app: AppHandle, archive: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        let archive = backup_store::resolve(&backup_directory(&app)?, &archive)?;
        fs::remove_file(archive).map_err(|error| format!("无法删除备份：{error}"))
    })
    .await
    .map_err(|error| format!("删除备份任务异常结束：{error}"))?
}

#[tauri::command]
async fn export_backup(app: AppHandle, archive: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let canonical_archive = backup_store::resolve(&backup_directory(&app)?, &archive)?;
        let suggested_name = canonical_archive
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let Some(destination) = choose_backup_export(&suggested_name)? else {
            return Ok(None);
        };
        if destination == canonical_archive {
            return Err("导出位置不能与原始备份相同".into());
        }
        fs::copy(&canonical_archive, &destination)
            .map_err(|error| format!("无法导出备份：{error}"))?;
        Ok(Some(destination.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("导出备份任务异常结束：{error}"))?
}

#[tauri::command]
async fn import_backup(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(source) = choose_backup_import()? else {
            return Ok(None);
        };
        let _operation = box_manager_core::operation::mutation_guard()?;
        backup_store::import_file(&backup_directory(&app)?, &source).map(Some)
    })
    .await
    .map_err(|error| format!("导入备份任务异常结束：{error}"))?
}

#[tauri::command]
async fn export_diagnostics(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let suggested_name = format!("BOX-diagnostic-{timestamp}.zip");
        let Some(destination) = choose_diagnostic_export(&suggested_name)? else {
            return Ok(None);
        };
        let root = runtime_root(&app)?;
        let diagnostic_root = root.join("diagnostics");
        let staging = diagnostic_root.join("current");
        fs::create_dir_all(&diagnostic_root)
            .map_err(|error| format!("无法创建诊断目录：{error}"))?;
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(|error| format!("无法清理诊断目录：{error}"))?;
        }
        fs::create_dir_all(&staging).map_err(|error| format!("无法创建诊断目录：{error}"))?;
        let environment = load_existing_env(&app);
        let runtime_environment = runtime_env_path(&app)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .map(|content| parse_env(&content))
            .unwrap_or_default();
        let safe_environment: BTreeMap<String, String> = environment
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    if is_sensitive_env_key(key) {
                        "[REDACTED]".into()
                    } else {
                        value.clone()
                    },
                )
            })
            .collect();
        let docker_info = docker_output(&["info", "--format", "{{json .}}"])
        .unwrap_or_else(|error| format!("Docker info unavailable: {error}"));
        let compose_state = redact_text(
            compose_output(&app, &["ps", "--format", "json"])
                .unwrap_or_else(|error| format!("Compose state unavailable: {error}")),
            &runtime_environment,
        );
        let report = serde_json::json!({
            "formatVersion": 1,
            "generatedAtMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "applicationVersion": ROOT_VERSION,
            "imageTag": IMAGE_TAG,
            "platform": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "systemStatus": system_status(app.clone()),
            "configuration": safe_environment,
            "dockerInfo": docker_info,
            "composeState": compose_state,
        });
        fs::write(
            staging.join("report.json"),
            serde_json::to_vec_pretty(&report).map_err(|error| format!("无法生成诊断报告：{error}"))?,
        )
        .map_err(|error| format!("无法写入诊断报告：{error}"))?;
        let logs = compose_output(&app, &["logs", "--tail", "500", "--no-color"])
            .unwrap_or_else(|error| format!("Logs unavailable: {error}"));
        let logs = redact_text(redact_text(logs, &runtime_environment), &environment);
        fs::write(staging.join("logs.txt"), logs)
            .map_err(|error| format!("无法写入诊断日志：{error}"))?;
        fs::write(
            staging.join("README.txt"),
            "此诊断包已自动隐藏密码、令牌、API Key 和数据库连接串。发送前仍建议人工检查。\n",
        )
        .map_err(|error| format!("无法写入诊断说明：{error}"))?;
        create_diagnostic_zip(&staging, &destination)?;
        fs::remove_dir_all(staging).map_err(|error| format!("无法清理诊断临时目录：{error}"))?;
        Ok(Some(destination.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("诊断包任务异常结束：{error}"))?
}

#[tauri::command]
async fn save_configuration_command(
    app: AppHandle,
    config: InstallConfigInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        let database_mode = validate_database_mode(&config.database_mode)?;
        let redis_mode = validate_redis_mode(&config.redis_mode)?;
        if database_mode == "external" {
            emit_progress(&app, "preflight", "正在检查 PostgreSQL 数据库…", 20);
            let database_host = validate_host(&config.database_host, "数据库地址")?;
            let database_port = validate_port(&config.database_port)?;
            check_remote_endpoint(" PostgreSQL", &database_host, database_port)?;
        }
        if redis_mode == "external" {
            let redis_host = validate_host(&config.redis_host, "Redis 地址")?;
            let redis_port = validate_port(&config.redis_port)?;
            check_remote_endpoint(" Redis", &redis_host, redis_port)?;
        }
        emit_progress(&app, "config", "正在保存安全配置…", 70);
        save_configuration(&app, config)?;
        emit_progress(&app, "complete", "配置已保存，请在总览选择启动范围", 100);
        Ok(())
    })
    .await
    .map_err(|error| format!("配置任务异常结束：{error}"))?
}

#[tauri::command]
async fn start_services(app: AppHandle, scope: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        services::start(&DesktopRuntime(&app), &scope)?;
        finalize_image_updates(&app);
        Ok(())
    })
    .await
    .map_err(|error| format!("启动任务异常结束：{error}"))?
}

#[tauri::command]
async fn stop_services(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = box_manager_core::operation::mutation_guard()?;
        services::stop(&DesktopRuntime(&app))
    })
    .await
    .map_err(|error| format!("停止任务异常结束：{error}"))?
}

#[tauri::command]
fn open_service(app: AppHandle, url: String) -> Result<(), String> {
    generate_runtime_environment(&app)?;
    let values = runtime_env_path(&app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|content| parse_env(&content))
        .unwrap_or_default();
    let configured_url = |name: &str, fallback: &str| {
        values
            .get(name)
            .filter(|value| !value.is_empty())
            .map(String::as_str)
            .unwrap_or(fallback)
            .trim_end_matches('/')
            .to_string()
    };
    let allowed = [
        format!(
            "{}/",
            configured_url("BOX_CREATOR_PUBLIC_URL", "http://127.0.0.1:3127")
        ),
        format!(
            "{}/",
            configured_url("BOX_PLAY_PUBLIC_URL", "http://127.0.0.1:3121")
        ),
        format!(
            "{}/",
            configured_url("BOX_PLAYER_SERVICE_PUBLIC_URL", "http://127.0.0.1:3124")
        ),
        format!(
            "{}/",
            configured_url("BOX_AUTH_PORTAL_PUBLIC_URL", "http://127.0.0.1:3125")
        ),
        format!(
            "{}/",
            configured_url("BOX_VOXA_PUBLIC_URL", "http://127.0.0.1:3123")
        ),
    ];
    if !allowed.contains(&url) {
        return Err("只允许打开当前配置中的 BOX 服务地址".into());
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", &url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };
    hide_window(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开浏览器：{error}"))
}

#[tauri::command]
fn open_community_group() -> Result<(), String> {
    let url = "https://qm.qq.com/q/oMdzAAN49a";
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    hide_window(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开交流群：{error}"))
}

#[tauri::command]
fn open_docker_desktop_download() -> Result<(), String> {
    let url = "https://www.docker.com/products/docker-desktop/";
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    hide_window(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开 Docker Desktop 下载页面：{error}"))
}

#[tauri::command]
fn start_docker_desktop() -> Result<(), String> {
    let mut command = if docker_output(&["desktop", "version"]).is_ok() {
        let mut command = docker_command();
        command.args(["desktop", "start"]);
        command
    } else {
        #[cfg(target_os = "windows")]
        {
            let path = r"C:\Program Files\Docker\Docker\Docker Desktop.exe";
            if !Path::new(path).is_file() {
                return Err(
                    "Docker CLI 已安装，但未找到 Docker Desktop 程序。请手动启动 Docker Desktop。"
                        .into(),
                );
            }
            let mut command = Command::new("cmd");
            command.args(["/C", "start", "", path]);
            command
        }
        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("open");
            command.args(["-a", "Docker"]);
            command
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        return Err("请手动启动 Docker Desktop，然后重新检测。".into());
    };
    hide_window(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动 Docker Desktop：{error}"))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[tauri::command]
fn verify_archive(app: AppHandle) -> Result<String, String> {
    let archive = archive_candidates(Some(&app))
        .into_iter()
        .next()
        .ok_or_else(|| "未找到离线镜像归档".to_string())?;
    verify_offline_image_archive(&app, &archive)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn test_install_config() -> InstallConfigInput {
        InstallConfigInput {
            external_nginx_manual: false,
            database_mode: default_database_mode(),
            database_host: String::new(),
            database_port: default_database_port(),
            database_name: default_database_name(),
            database_user: default_database_user(),
            database_password: String::new(),
            database_ssl: false,
            permission_token_secret: String::new(),
            player_auth_api_key: String::new(),
            play_admin_token: String::new(),
            redis_mode: default_redis_mode(),
            redis_host: String::new(),
            redis_port: default_redis_port(),
            redis_password: String::new(),
            redis_db: 0,
            storage_cache_redis_db: 1,
            database_pool_size: default_database_pool_size(),
            storage_cache_redis_ttl: default_storage_cache_redis_ttl(),
            auto_backup_enabled: false,
            auto_backup_interval_minutes: 60,
            auto_backup_retention_count: 24,
            auto_backup_retention_days: 30,
            public_host: default_public_host(),
            public_address: "127.0.0.1".into(),
            public_address_mode: "independent".into(),
            shared_public_address: String::new(),
            public_service_paths: BTreeMap::new(),
            public_ssl_configured: BTreeMap::new(),
            independent_public_addresses: BTreeMap::new(),
            play_public_address_override: String::new(),
            creator_public_address_override: String::new(),
            voxa_public_address_override: String::new(),
            player_service_public_address_override: String::new(),
            auth_portal_public_address_override: String::new(),
            play_network_mode: default_play_network_mode(),
            creator_host: default_creator_host(),
            creator_network_mode: default_creator_network_mode(),
            play_port: 3121,
            voxa_port: 3123,
            creator_port: 3127,
            player_service_port: 3124,
            auth_portal_port: 3125,
            auth_portal_image: String::new(),
            play_runtimes: default_play_runtimes(),
            creator_edit_runtimes: default_creator_edit_runtimes(),
            creator_play_runtimes: default_creator_play_runtimes(),
            creator_edit_prewarm_runtimes: default_creator_edit_prewarm_runtimes(),
            play_prewarm_runtimes: default_play_prewarm_runtimes(),
            player_limit: default_player_limit(),
            script_memory_mb: default_script_memory_mb(),
            runtime_idle_minutes: default_runtime_idle_minutes(),
            runtime_start_timeout_minutes: default_runtime_start_timeout_minutes(),
            teleport_max_rooms: default_teleport_max_rooms(),
            teleport_room_idle_minutes: default_teleport_room_idle_minutes(),
            registration_enabled: true,
            player_service_memory_mb: default_player_service_memory_mb(),
            player_service_cpu_limit: default_player_service_cpu_limit(),
            auth_portal_memory_mb: default_auth_portal_memory_mb(),
            auth_portal_cpu_limit: default_auth_portal_cpu_limit(),
            creator_memory_mb: default_creator_memory_mb(),
            creator_cpu_limit: default_creator_cpu_limit(),
            play_memory_mb: default_play_memory_mb(),
            play_cpu_limit: default_play_cpu_limit(),
        }
    }

    #[test]
    fn validates_custom_login_image_and_default_in_native_configuration() {
        let mut config = test_install_config();
        assert!(validate_install_configuration(&config).is_ok());
        config.auth_portal_image = "registry.test/login:1.0".into();
        assert!(validate_install_configuration(&config).is_ok());
        config.auth_portal_image = "https://registry.test/login".into();
        assert!(validate_install_configuration(&config).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolves_docker_desktop_cli_without_a_shell_path() {
        if !Path::new("/Applications/Docker.app/Contents/Resources/bin/docker").is_file()
            || std::env::var_os("BOX_DOCKER_CLI").is_some()
        {
            return;
        }
        let command = docker_command();
        assert_eq!(
            command.get_program(),
            "/Applications/Docker.app/Contents/Resources/bin/docker"
        );
    }

    #[test]
    fn explains_a_docker_daemon_that_is_not_ready() {
        assert!(docker_message("Cannot connect to the Docker daemon".into())
            .contains("Docker CLI 已安装"));
    }

    #[test]
    fn distinguishes_an_installed_cli_from_a_missing_docker_socket() {
        assert!(docker_message(
            "Cannot connect to the Docker daemon at unix:///Users/test/.docker/run/docker.sock. Is the docker daemon running? no such file or directory".into()
        )
        .contains("Docker CLI 已安装"));
    }

    #[test]
    fn rejects_duplicate_service_ports() {
        let mut config = test_install_config();
        config.voxa_port = config.play_port;
        assert!(validate_install_configuration(&config)
            .unwrap_err()
            .contains("不能使用同一个端口"));
    }

    #[test]
    fn rejects_invalid_automatic_backup_retention() {
        let mut config = test_install_config();
        config.auto_backup_enabled = true;
        config.auto_backup_interval_minutes = 0;
        assert!(validate_install_configuration(&config)
            .unwrap_err()
            .contains("自动备份间隔"));
    }

    #[test]
    fn validates_runtime_capacity_and_converts_minutes() {
        let mut config = test_install_config();
        assert!(validate_install_configuration(&config).is_ok());
        assert_eq!(minutes_to_milliseconds(15), 900_000);

        config.teleport_max_rooms = 1_025;
        assert!(validate_install_configuration(&config)
            .unwrap_err()
            .contains("私有房间上限"));
    }

    #[test]
    fn rejects_prewarm_above_runtime_limit() {
        let mut config = test_install_config();
        config.play_prewarm_runtimes = config.play_runtimes + 1;
        assert!(validate_install_configuration(&config)
            .unwrap_err()
            .contains("Play 预热数量"));
    }

    #[test]
    fn validates_operator_resources_and_parses_memory_units() {
        let mut config = test_install_config();
        assert!(validate_install_configuration(&config).is_ok());
        assert_eq!(memory_mebibytes(Some(&"1g".to_string()), 128), 1024);
        assert_eq!(memory_mebibytes(Some(&"512m".to_string()), 128), 512);

        config.auth_portal_cpu_limit = 0.0;
        assert!(validate_install_configuration(&config)
            .unwrap_err()
            .contains("登录页面 CPU"));
    }

    #[test]
    fn external_database_requires_a_host() {
        assert!(database_url(&BTreeMap::new())
            .unwrap_err()
            .contains("外部 PostgreSQL"));
    }

    #[test]
    fn managed_database_uses_the_internal_compose_host() {
        let values = BTreeMap::from([
            ("BOX_DATABASE_MODE".into(), "managed".into()),
            ("BOX_DATABASE_NAME".into(), "box".into()),
            ("BOX_DATABASE_USER".into(), "box".into()),
            ("BOX_DATABASE_PASSWORD".into(), "managed-secret".into()),
        ]);
        assert_eq!(
            database_url(&values).unwrap(),
            "postgresql://box:managed-secret@managed-postgres:5432/box"
        );
    }

    #[test]
    fn runtime_status_reads_a_complete_chunked_response_without_waiting_for_close() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = r#"{"phase":"ready","percent":100,"message":"运行时已就绪"}"#;
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n{:X}\r\n{}\r\n0\r\n\r\n",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(1500));
        });

        let status = runtime_endpoint_status_at("project-id", address, "");
        server.join().unwrap();

        assert_eq!(status.phase, "ready");
        assert_eq!(status.percent, 100);
    }

    #[test]
    fn play_runtime_status_uses_the_public_play_route() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let body = r#"{"phase":"ready","percent":100}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });

        let status = runtime_endpoint_status_at("project-id", address, "p");
        let request = server.join().unwrap();

        assert_eq!(status.phase, "ready");
        assert!(request.starts_with("GET /p/project-id/__local_runtime/status HTTP/1.1"));
    }

    #[test]
    fn managed_database_identity_keeps_internal_credentials_when_active_mode_changes() {
        let existing = BTreeMap::from([
            ("BOX_DATABASE_MODE".into(), "external".into()),
            ("BOX_DATABASE_NAME".into(), "external_database".into()),
            ("BOX_DATABASE_USER".into(), "external_user".into()),
            (
                "BOX_MANAGED_POSTGRES_DATABASE".into(),
                "managed_database".into(),
            ),
            ("BOX_MANAGED_POSTGRES_USER".into(), "managed_user".into()),
            (
                "BOX_MANAGED_POSTGRES_PASSWORD".into(),
                "managed-password".into(),
            ),
            ("REDIS_PASSWORD".into(), "external-redis-password".into()),
            (
                "BOX_MANAGED_REDIS_PASSWORD".into(),
                "managed-redis-password".into(),
            ),
        ]);
        assert_eq!(
            managed_database_identity(&existing),
            Some(("managed_database".into(), "managed_user".into()))
        );
        assert_eq!(
            managed_database_password(&existing).as_deref(),
            Some("managed-password")
        );
        assert_eq!(
            managed_redis_password(&existing).as_deref(),
            Some("managed-redis-password")
        );
    }

    #[test]
    fn diagnostic_redaction_hides_secret_values() {
        let values = BTreeMap::from([
            ("BOX_PLAY_ADMIN_TOKEN".into(), "owner-secret-value".into()),
            ("BOX_PLAY_PORT".into(), "3000".into()),
        ]);
        let redacted = redact_text("token=owner-secret-value port=3000".into(), &values);
        assert_eq!(redacted, "token=[REDACTED] port=3000");
    }

    #[test]
    fn validates_raw_environment_without_hiding_owner_values() {
        assert!(validate_raw_environment(
            "# owner-managed configuration\nBOX_PLAY_ADMIN_TOKEN=owner-secret-value\nBOX_PLAY_PORT=3000\n"
        )
        .is_ok());
        assert!(validate_raw_environment("BOX_PLAY_PORT\n").is_err());
        assert!(validate_raw_environment("box_play_port=3000\n").is_err());
    }

    #[test]
    fn creator_network_policy_accepts_valid_public_hosts() {
        assert!(validate_creator_host("127.0.0.1").is_ok());
        assert!(validate_creator_host("192.168.1.10").is_ok());
        assert!(validate_creator_host("10.0.0.10").is_ok());
        assert!(validate_creator_host("0.0.0.0").is_err());
        assert!(validate_creator_host("203.0.113.20").is_ok());
        assert!(validate_creator_host("arena.example.com").is_ok());
        assert_eq!(
            host_from_http_url("https://[fd00::10]:3002/path"),
            Some("fd00::10".into())
        );
    }

    #[test]
    fn independent_access_settings_preserve_creator_range() {
        let mut config = test_install_config();
        config.public_host = "123.123.213.123".into();
        config.play_network_mode = "public".into();
        config.creator_host = "127.0.0.1".into();
        config.creator_network_mode = "local".into();
        normalize_access_defaults(&mut config);
        assert_eq!(config.creator_host,"127.0.0.1");
        assert_eq!(config.creator_network_mode,"local");
        assert!(validate_install_configuration(&config).is_ok());
    }

    #[test]
    fn accepts_an_owner_supplied_secret() {
        let value = resolve_secret(
            "BOX_PLAY_ADMIN_TOKEN",
            "owner-controlled-token",
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(value, "owner-controlled-token");
    }

    #[test]
    fn owner_normalization_preserves_legacy_urls_before_removing_derived_keys() {
        let source = "# owner comment\nBOX_PLAY_PUBLIC_URL=https://play.example/worlds\nBOX_CREATOR_PUBLIC_URL=https://create.example/editor\nBOX_AUTH_PORTAL_PUBLIC_URL=https://auth.example/\nBOX_PLAYER_LOGIN_URL=https://login.example/custom\nBOX_DATABASE_URL=postgres://u:p@db/box?sslmode=require\n";
        let normalized = normalize_owner_environment(source).unwrap();
        let values = parse_env(&normalized);
        assert_eq!(
            values["BOX_PLAY_PUBLIC_URL_OVERRIDE"],
            "https://play.example/worlds"
        );
        assert_eq!(
            values["BOX_CREATOR_PUBLIC_URL_OVERRIDE"],
            "https://create.example/editor"
        );
        assert_eq!(
            values["BOX_PLAYER_LOGIN_URL_OVERRIDE"],
            "https://login.example/custom"
        );
        assert_eq!(values["BOX_PLAY_NETWORK_MODE"], "public");
        assert_eq!(values["BOX_CREATOR_NETWORK_MODE"], "public");
        assert_eq!(values["BOX_DATABASE_QUERY"], "sslmode=require");
        assert!(!values.contains_key("BOX_PLAY_PUBLIC_URL"));
        assert!(!values.contains_key("BOX_DATABASE_URL"));
        assert!(normalized.contains("# owner comment"));
        assert_eq!(
            normalize_owner_environment(&normalized).unwrap(),
            normalized
        );
    }

    #[test]
    fn owner_normalization_keeps_explicit_query_and_cleans_managed_query() {
        let source = "BOX_DATABASE_URL=postgres://u:p@db/box?sslmode=require\nBOX_DATABASE_QUERY=sslmode=verify-full\n";
        let external = normalize_owner_environment(source).unwrap();
        assert_eq!(
            parse_env(&external)["BOX_DATABASE_QUERY"],
            "sslmode=verify-full"
        );
        let mut managed = external;
        set_env(&mut managed, "BOX_DATABASE_MODE", "managed").unwrap();
        assert!(!parse_env(&normalize_owner_environment(&managed).unwrap())
            .contains_key("BOX_DATABASE_QUERY"));
    }

    #[test]
    fn desktop_form_compares_migrated_hosts_and_ports_before_field_updates() {
        let source = "BOX_PLAY_PUBLIC_URL=https://play.example/worlds\nBOX_CREATOR_PUBLIC_URL=https://create.example/editor\nBOX_AUTH_PORTAL_PUBLIC_URL=https://auth.example/\nBOX_PLAYER_LOGIN_URL=https://login.example/custom\nBOX_DATABASE_URL=postgres://owner:fixture@db/box?sslmode=require\n";
        let mut config = test_install_config();
        config.public_host = "play.example".into();
        config.play_network_mode = "public".into();
        config.creator_host = "create.example".into();
        config.creator_network_mode = "public".into();
        let unchanged = configuration_document_for_save(source, &config).unwrap();
        let values = parse_env(&unchanged);
        assert!(values.contains_key("BOX_PLAY_PUBLIC_URL_OVERRIDE"));
        assert!(values.contains_key("BOX_CREATOR_PUBLIC_URL_OVERRIDE"));
        // Blank submitted passwords can now retain migrated legacy credentials.
        assert_eq!(values["BOX_DATABASE_PASSWORD"], "fixture");
        config.play_port = 4000;
        let port_changed = parse_env(&configuration_document_for_save(source, &config).unwrap());
        assert!(!port_changed.contains_key("BOX_PLAY_PUBLIC_URL_OVERRIDE"));
        assert!(port_changed.contains_key("BOX_AUTH_PORTAL_PUBLIC_URL_OVERRIDE"));
        config.public_host = "new.example".into();
        let host_changed = parse_env(&configuration_document_for_save(source, &config).unwrap());
        assert!(!host_changed.contains_key("BOX_AUTH_PORTAL_PUBLIC_URL_OVERRIDE"));
        assert!(host_changed.contains_key("BOX_CREATOR_PUBLIC_URL_OVERRIDE"));
        assert_eq!(
            host_changed["BOX_PLAYER_LOGIN_URL_OVERRIDE"],
            "https://login.example/custom"
        );
    }

    #[test]
    fn migrates_a_legacy_database_url_without_retaining_it() {
        let normalized = normalize_owner_environment(
            "BOX_DATABASE_URL=postgresql://box%20user:secret%21@db.example.test:5432/box%20data\nBOX_TRUST_PROXY=false\nBOX_RUNTIME_IDLE_TIMEOUT_MS=900000\n",
        )
        .unwrap();
        let values = parse_env(&normalized);
        assert_eq!(
            values.get("BOX_DATABASE_HOST"),
            Some(&"db.example.test".into())
        );
        assert_eq!(values.get("BOX_DATABASE_PORT"), Some(&"5432".into()));
        assert_eq!(values.get("BOX_DATABASE_NAME"), Some(&"box data".into()));
        assert_eq!(values.get("BOX_DATABASE_USER"), Some(&"box user".into()));
        assert_eq!(values.get("BOX_DATABASE_PASSWORD"), Some(&"secret!".into()));
        assert_eq!(values.get("BOX_DATABASE_MODE"), Some(&"external".into()));
        assert!(!values.contains_key("BOX_DATABASE_URL"));
        assert!(!values.contains_key("BOX_TRUST_PROXY"));
        assert!(!values.contains_key("BOX_RUNTIME_IDLE_TIMEOUT_MS"));
    }

    #[test]
    fn defaults_an_unconfigured_desktop_database_to_managed_mode() {
        let normalized = normalize_owner_environment(
            "BOX_DATABASE_HOST=\nBOX_DATABASE_PORT=5432\nBOX_DATABASE_NAME=box\nBOX_DATABASE_USER=box\n",
        )
        .unwrap();
        let values = parse_env(&normalized);
        assert_eq!(values.get("BOX_DATABASE_MODE"), Some(&"managed".into()));
        assert_eq!(values.get("BOX_REDIS_MODE"), Some(&"disabled".into()));
    }

    #[test]
    fn migrates_an_existing_redis_host_to_external_mode() {
        let normalized = normalize_owner_environment(
            "BOX_DATABASE_MODE=managed\nBOX_DATABASE_HOST=managed-postgres\nREDIS_HOST=cache.example.test\nREDIS_PORT=6379\n",
        )
        .unwrap();
        let values = parse_env(&normalized);
        assert_eq!(values.get("BOX_REDIS_MODE"), Some(&"external".into()));
        assert_eq!(values.get("REDIS_HOST"), Some(&"cache.example.test".into()));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_title(&format!("BOX3 Engine Launcher v{ROOT_VERSION}"))?;
            }
            let handle=app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(5));
                let Ok(root)=runtime_root(&handle) else {continue};
                if !root.join("https/certificate-paths.json").exists() {continue;}
                let environment=fs::read_to_string(root.join(".env")).unwrap_or_default();
                let _=box_manager_core::ssl::refresh_certificate_paths(&root,&root,"box-local-engine-desktop_default",&environment,&mut |args| docker_output(&args.iter().map(String::as_str).collect::<Vec<_>>()));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssl_commands::get_ssl_status,
            ssl_commands::install_nginx_image,
            ssl_commands::set_nginx_provider,
            ssl_commands::apply_ssl_config,
            ssl_commands::delete_ssl_certificate,
            ssl_commands::stop_ssl_proxy,
            ssl_commands::reload_ssl_proxy,
            ssl_commands::verify_ssl_endpoint,
            ssl_commands::export_ssl_configuration,
            get_install_config,
            get_owner_secrets,
            get_raw_environment,
            save_raw_environment,
            get_raw_nginx_config,
            save_raw_nginx_config,
            get_system_status,
            get_project_runtime_status,
            list_map_runtime_profiles,
            save_map_runtime_profile,
            delete_map_runtime_profile,
            destroy_project_runtime,
            get_about_info,
            crate::updates::open_release_download,
            crate::launcher_update::download_launcher_update,
            crate::launcher_update::apply_launcher_update,
            get_legal_notices,
            get_performance_status,
            get_data_storage_info,
            choose_data_storage_directory,
            relocate_data_storage,
            list_backups,
            create_backup,
            inspect_backup,
            restore_backup,
            delete_backup,
            export_backup,
            import_backup,
            test_remote_connection,
            has_managed_database_image,
            prepare_managed_database,
            has_managed_redis_image,
            prepare_managed_redis,
            get_managed_service_info,
            start_managed_service,
            save_configuration_command,
            start_services,
            stop_services,
            control_service,
            export_diagnostics,
            open_service,
            open_community_group,
            external_links::open_project_repository,
            open_docker_desktop_download,
            start_docker_desktop,
            get_docker_check,
            verify_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BOX Local Engine manager");
}


#[cfg(test)]
mod desktop_runtime_contract_tests {
    use super::*;
    #[test]
    fn application_images_missing_names_every_started_image() {
        let mut seen = Vec::new();
        assert!(!application_images_missing("v0.3.0-linux-arm64", &mut |image| {
            seen.push(image.to_string());
            false
        }));
        for expected in [
            "box-local-engine-play:v0.3.0-linux-arm64",
            "box-local-engine-creator:v0.3.0-linux-arm64",
            "box-local-engine-voxa:v0.3.0-linux-arm64",
            "box-local-engine-player-service:v0.3.0-linux-arm64",
            "box-local-engine-player-auth-portal:v0.3.0-linux-arm64",
        ] {
            assert!(seen.contains(&expected.to_string()), "{expected}");
        }
        assert!(application_images_missing("v0.3.0-linux-arm64", &mut |image| {
            image == "box-local-engine-player-auth-portal:v0.3.0-linux-arm64"
        }));
    }

    #[test]
    fn path_validation_receives_the_same_derived_environment_as_compose() {
        let owner = "BOX_PLAY_NETWORK_MODE=public\nBOX_CREATOR_NETWORK_MODE=local\nBOX_PLAY_PUBLIC_ADDRESS_OVERRIDE=http://127.0.0.1/abc\nBOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE=http://127.0.0.1/sjixs\n".to_string();
        let derived = shared_config::runtime_environment(&parse_env(&owner), &shared_config::RuntimeInputs {
            lan_ip:None,image_tag:"0.3.0",platform:"linux/arm64",database_required:false,web_manager:false,
        }).unwrap();
        let (document, returned) = assemble_runtime_environment(owner, derived).unwrap();
        let settings = box_manager_core::ssl::Settings {
            mode:"managed".into(),https_port:443,upstream_ports:Default::default(),
            routes:vec![box_manager_core::ssl::Route {service:"play".into(),domain:"127.0.0.1".into(),port:Some(80),path:"/abc".into(),secure:false}],
        };
        box_manager_core::ssl::validate_path_images(&settings,&returned,&mut |args| {
            assert_eq!(args.last().unwrap(),"box-local-engine-play:0.3.0");
            Ok(r#"{"box.routing.base-path":"runtime-v1"}"#.into())
        }).unwrap();
        assert_eq!(returned, parse_env(&document));
    }
}
