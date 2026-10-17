#![recursion_limit = "256"]

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path as FsPath, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tower_http::services::ServeDir;

mod http {
    pub(crate) mod commands;
    pub(crate) mod web;
    pub(crate) mod websocket;
}
mod operations;
mod platform {
    pub(crate) mod backups;
    pub(crate) mod configuration;
    pub(crate) mod monitoring;
    pub(crate) mod security_data;
}
mod runtime {
    pub(crate) mod catalog;
    pub(crate) mod map_runtimes;
    pub(crate) mod runtime;
}
#[cfg(test)]
mod tests;
use box_manager_core::configuration as shared_config;
use box_manager_core::configuration_migration::{
    clear_overrides_on_configuration_change, migrate_document,
};
use box_manager_core::environment::parse_env;
use box_manager_core::map_runtime_profiles::{
    valid_permanent_map_id, validate_map_runtime_profile, MapRuntimeProfile, MapRuntimeProfilesFile,
};
use box_manager_core::services::{
    self, Runtime as ServiceRuntime, APPLICATION_SERVICES as SERVICES,
};
use box_manager_core::{backup, backup_store};
use http::web::*;
use operations::Operations;
use platform::backups::{
    backup_dir, backup_file, create_backup, inspect_backup, list_backups, restore_backup,
};
use platform::configuration::*;
use platform::monitoring::*;
use platform::security_data::*;
use runtime::map_runtimes::*;
use shared_config::{
    database_url, validate_configuration, validate_host, validate_raw_environment,
};

const LEGAL_NOTICE: &str = include_str!("../../../distribution/LICENSE.txt");
#[derive(Clone)]
/// Immutable dependencies for one management request.
///
/// `operation_id` is populated only after the HTTP layer accepts a client
/// supplied operation key, so synchronous modules can report progress without
/// knowing anything about HTTP headers.
struct App {
    root: PathBuf,
    token: String,
    runtime_token: String,
    compose_file: PathBuf,
    environment_file: PathBuf,
    operations: Arc<Operations>,
    operation_id: Option<String>,
}
impl App {
    /// Publishes a non-terminal progress update when this invocation belongs
    /// to a long-running, browser-polled operation.
    fn progress(&self, stage: &str, message: &str, percent: u8) {
        if let Some(id) = &self.operation_id {
            self.operations.update(id, stage, message, percent, false);
        }
    }

    fn image_progress(&self, image: &str, bytes: u64, total: u64) {
        if let Some(id) = &self.operation_id {
            let image = if image.starts_with("box-local-engine-") { image.to_owned() } else { format!("box-local-engine-{image}") };
            self.operations.update_download(id, &image, bytes, total);
        }
    }
    fn image_download_complete(&self, image: &str) {
        if let Some(id) = &self.operation_id { self.operations.complete_download(id, image); }
    }
}
struct WebRuntime<'a>(&'a App);
/// Adapter from the shared service-control module to this manager's local
/// configuration, Compose runner and progress store.
impl ServiceRuntime for WebRuntime<'_> {
    fn prepare_images(&self, _services: &[&str]) -> Result<(), String> {
        let runtime_path = generate_runtime_environment(self.0)?;
        database_url(&parse_env(
            &fs::read_to_string(env_path(self.0)).map_err(|e| e.to_string())?,
        ))?;
        docker(&["info", "--format", "{{.ServerVersion}}"])?;
        let values =
            parse_env(&fs::read_to_string(env_path(self.0)).map_err(|error| error.to_string())?);
        let runtime =
            parse_env(&fs::read_to_string(runtime_path).map_err(|error| error.to_string())?);
        box_manager_core::auth_portal::prepare_custom_image(
            &values,
            runtime
                .get("BOX_PLAY_PLATFORM")
                .map(String::as_str)
                .unwrap_or("linux/amd64"),
            docker,
            |stage, message, percent| self.0.progress(stage, message, percent),
        )?;
        let values = parse_env(&fs::read_to_string(env_path(self.0)).map_err(|error| error.to_string())?);
        let image_tag = values.get("BOX_IMAGE_TAG").map(String::as_str).ok_or("镜像版本未配置")?;
        let mut prepared = Vec::new();
        for service in _services {
            if *service == "player-auth-portal"
                && box_manager_core::auth_portal::image(&values, image_tag)?
                    != format!("box-local-engine-player-auth-portal:{image_tag}")
            {
                continue;
            }
            // A local version tag can still point at an older build of the
            // same version. Always validate its content against the catalog.
            prepared.push(plan_application_image(self.0, service, image_tag)?);
        }
        if let Some(id) = &self.0.operation_id {
            self.0.operations.begin_downloads(id, prepared.iter().filter_map(|image| image.download_row()).collect());
        }
        let acquired = std::thread::scope(|scope| {
            let workers = prepared.into_iter()
                .map(|image| scope.spawn(move || acquire_application_image(self.0, image)))
                .collect::<Vec<_>>();
            let mut first_error = None;
            let mut acquired = Vec::new();
            for worker in workers {
                match worker.join() {
                    Ok(Ok(image)) => acquired.push(image),
                    Ok(Err(error)) if first_error.is_none() => first_error = Some(error),
                    Err(_) if first_error.is_none() => {
                        first_error = Some("镜像下载任务异常结束".to_string())
                    }
                    _ => {}
                }
            }
            first_error.map_or(Ok(acquired), Err)
        })?;
        for image in acquired { import_application_image(self.0, image)?; }
        Ok(())
    }
    fn managed_enabled(&self, service: &str) -> bool {
        let key = match service {
            "managed-postgres" => "BOX_DATABASE_MODE",
            "managed-redis" => "BOX_REDIS_MODE",
            _ => return false,
        };
        parse_env(&fs::read_to_string(env_path(self.0)).unwrap_or_default())
            .get(key)
            .is_some_and(|mode| mode == "managed")
    }
    fn check_managed(&self, service: &str) -> Result<(), String> {
        if !self.managed_enabled(service) {
            return Err("该内置基础服务尚未启用".into());
        }
        let values = parse_env(&fs::read_to_string(env_path(self.0)).map_err(|e| e.to_string())?);
        let image = managed_image(
            &values,
            if service == "managed-postgres" {
                "postgresql"
            } else {
                "redis"
            },
        )?;
        docker(&["image", "inspect", &image])
            .map_err(|_| "该内置基础服务尚未安装，请先在数据配置中下载镜像".to_string())?;
        Ok(())
    }
    fn compose(&self, args: &[&str]) -> Result<(), String> {
        compose(self.0, args).map(|_| ())
    }
    fn progress(&self, stage: &str, message: &str, percent: u8) {
        self.0.progress(stage, message, percent);
    }
}

#[derive(Deserialize)]
struct Request {
    #[serde(flatten)]
    body: BTreeMap<String, Value>,
}
#[derive(Serialize)]
struct Error {
    message: String,
}

fn fail(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(Error {
            message: message.into(),
        }),
    )
        .into_response()
}

fn validate_startup_token(key: &str, value: Option<String>) -> Result<String, String> {
    let value = value.unwrap_or_default();
    if value.len() >= 32 {
        return Ok(value);
    }
    Err(format!(
        "配置错误：{key} 必须设置为至少 32 个字符的密钥。请在服务器部署目录的 .env 中设置该值后重新创建 server-manager 容器。 Configuration error: {key} must be a secret of at least 32 characters; set it in .env and recreate server-manager."
    ))
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if env::args().nth(1).as_deref() == Some("--healthcheck") {
        if let Err(error) = run_healthcheck() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let root = env::var("BOX_SERVER_MANAGER_ROOT").unwrap_or_else(|_| "/workspace".into());
    let root_path = PathBuf::from(&root);
    let token = match validate_startup_token(
        "BOX_SERVER_MANAGER_TOKEN",
        env::var("BOX_SERVER_MANAGER_TOKEN").ok(),
    ) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let runtime_token = match validate_startup_token(
        "BOX_RUNTIME_MANAGER_TOKEN",
        env::var("BOX_RUNTIME_MANAGER_TOKEN").ok(),
    ) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let app = Arc::new(App {
        root: root_path.clone(),
        token,
        runtime_token,
        compose_file: env::var("BOX_SERVER_MANAGER_COMPOSE_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| root_path.join("compose.yml")),
        operations: Arc::new(Operations::default()),
        operation_id: None,
        environment_file: env::var("BOX_SERVER_MANAGER_ENV_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| root_path.join(".env")),
    });
    let certificate_app=app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let root=&certificate_app.root;
        if !root.join("https/certificate-paths.json").exists() {continue;}
        let Ok(host_root)=host_project_root(&certificate_app) else {continue};
        let environment=fs::read_to_string(&certificate_app.environment_file).unwrap_or_default();
        let _=box_manager_core::ssl::refresh_certificate_paths(root,&host_root,"box-local-engine_default",&environment,&mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>()));
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/api/health", get(health))
        .route(
            "/api/runtime/ensure",
            post(runtime::runtime::ensure_runtime_container),
        )
        .route(
            "/api/runtime/{container_id}",
            delete(runtime::runtime::delete_runtime_container),
        )
        .route(
            "/api/runtime/{container_id}/stats",
            get(runtime::runtime::get_runtime_container_stats),
        )
        .route("/api/backups/upload", post(upload_backup))
        .route("/api/backups/{archive}/download", get(download_backup))
        .route(
            "/api/diagnostics/{archive}/download",
            get(download_diagnostics),
        )
        .route("/api/commands/{name}", post(http::commands::command))
        .route("/api/operations/{id}", get(operation_progress))
        .route("/api/events", get(http::websocket::upgrade))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .fallback_service(ServeDir::new(public_directory()).append_index_html_on_directories(true))
        .layer(middleware::from_fn(security))
        .with_state(app);
    let host = env::var("BOX_SERVER_MANAGER_HOST")
        .unwrap_or_else(|_| "0.0.0.0".into())
        .parse()
        .expect("BOX_SERVER_MANAGER_HOST must be an IP address");
    let port = manager_port();
    let addr = SocketAddr::new(host, port);
    println!("BOX3 Rust server manager listening on {addr}");
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), router)
        .await
        .unwrap()
}
