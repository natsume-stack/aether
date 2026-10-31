//! Operator configuration and generated Docker runtime files.
//!
//! The public interface deliberately stays small: commands ask for paths,
//! parse or update environment values, and persist private files. Everything
//! about atomic writes and configuration syntax remains local to this module.

use rand::{rngs::OsRng, RngCore};
use std::{
    collections::BTreeMap,
    fs,
    net::UdpSocket,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const COMPOSE_TEMPLATE: &str = include_str!("../../../../docker-compose.yml");
pub(crate) const ROOT_VERSION: &str = match option_env!("BOX_ROOT_VERSION") {
    Some(value) => value,
    None => env!("CARGO_PKG_VERSION"),
};
pub(crate) const IMAGE_TAG: &str = match option_env!("BOX_MANAGER_IMAGE_TAG") {
    Some(value) => value,
    None => ROOT_VERSION,
};
pub(crate) use box_manager_core::services::APPLICATION_SERVICES as SERVICE_NAMES;

pub(crate) fn detect_lan_ip() -> Option<String> {
    // UDP connect only asks the OS to choose an outbound interface; it does
    // not send traffic to the documentation-only probe address.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    (!address.is_loopback() && !address.is_unspecified()).then(|| address.to_string())
}

pub(crate) fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    let default_root = app_data.join("runtime");
    let location_file = app_data.join("runtime-location");
    let root = match fs::read_to_string(&location_file) {
        Ok(value) if !value.trim().is_empty() => {
            let configured = PathBuf::from(value.trim());
            if !configured.is_absolute() {
                return Err("数据目录配置无效，请在数据存储页面重新选择目录".into());
            }
            if !configured.exists() {
                return Err(format!(
                    "数据目录不可用：{}。请连接原来的磁盘后重试。",
                    configured.display()
                ));
            }
            configured
        }
        Ok(_) => default_root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => default_root,
        Err(error) => return Err(format!("无法读取数据目录配置：{error}")),
    };
    fs::create_dir_all(&root).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(root)
}

pub(crate) fn runtime_location_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?
        .join("runtime-location"))
}

pub(crate) fn default_runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?
        .join("runtime"))
}

pub(crate) fn env_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join(".env"))
}

pub(crate) fn runtime_env_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join(".runtime.env"))
}

pub(crate) fn compose_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("docker-compose.yml"))
}

pub(crate) fn ensure_runtime_files(app: &AppHandle) -> Result<(), String> {
    let root = runtime_root(app)?;
    let compose = root.join("docker-compose.yml");
    if !compose.exists() || fs::read_to_string(&compose).ok().as_deref() != Some(COMPOSE_TEMPLATE) {
        fs::write(&compose, COMPOSE_TEMPLATE)
            .map_err(|error| format!("无法写入 Docker Compose 配置：{error}"))?;
    }
    for directory in [
        "apps/local-engine/projects",
        "apps/local-engine/dist",
        "apps/local-engine/data",
        // Runtime containers mount this path read-only.  It must exist before
        // the game server initializes its local content store.
        "apps/local-engine/data/blobs",
        "apps/local-engine/backups",
        "apps/local-engine/play-worlds",
        "apps/voxa/data",
    ] {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("无法创建数据目录 {directory}：{error}"))?;
    }
    Ok(())
}

pub(crate) use box_manager_core::environment::{parse_env, remove_env, set_env};

pub(crate) fn write_private_file(
    path: &Path,
    content: impl AsRef<[u8]>,
    label: &str,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法确定 {label} 的保存目录"))?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建 {label} 目录：{error}"))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        random_hex(8)
    ));
    fs::write(&temporary, content).map_err(|error| format!("无法写入 {label}：{error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法保护 {label} 权限：{error}"))?;
    if let Err(rename_error) = fs::rename(&temporary, path) {
        // `rename` is atomic only when both paths are on the same file
        // system. This can legitimately fail with EXDEV when the app data
        // directory is a symlink or resides on a mounted volume. Copying the
        // already-written private file is the safe fallback here; importantly
        // it also avoids reporting a misleading second error when there is no
        // old file to remove.
        let copy_result = fs::copy(&temporary, path);
        match copy_result {
            Ok(_) => {
                let _ = fs::remove_file(&temporary);
            }
            Err(copy_error) => {
                let _ = fs::remove_file(&temporary);
                return Err(format!(
                    "无法替换 {label}：{rename_error}；跨文件系统复制也失败：{copy_error}"
                ));
            }
        }
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法保护 {label} 权限：{error}"))?;
    Ok(())
}

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut data = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut data);
    data.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn resolve_secret(
    name: &str,
    submitted: &str,
    existing: &BTreeMap<String, String>,
) -> Result<String, String> {
    let submitted = submitted.trim();
    if !submitted.is_empty() {
        if submitted.len() < 16 {
            return Err(format!("{name} 至少需要 16 个字符"));
        }
        return Ok(submitted.to_string());
    }
    Ok(existing
        .get(name)
        .filter(|value| value.len() >= 16)
        .cloned()
        .unwrap_or_else(|| random_hex(32)))
}

pub(crate) use box_manager_core::configuration::validate_raw_environment;
