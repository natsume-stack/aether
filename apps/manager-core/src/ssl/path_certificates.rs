//! Read operator-selected certificate paths; only validated snapshots reach Nginx.
use super::*;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
type Records = BTreeMap<String, CertificatePath>;

fn records(root: &Path) -> Result<Records, String> {
    match fs::read_to_string(root.join("https/certificate-paths.json")) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| "证书路径记录无效".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(error) => Err(format!("无法读取证书路径记录：{error}")),
    }
}
fn read_path(root: &Path, host_root: &Path, raw: &str, limit: u64) -> Result<String, String> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() || raw.chars().any(char::is_control) {
        return Err("证书路径必须是绝对路径，不能包含控制字符".into());
    }
    let path = if root != host_root && path.starts_with(host_root) {
        root.join(path.strip_prefix(host_root).unwrap())
    } else {
        path
    };
    let file = fs::File::open(&path).map_err(|error| {
        format!(
            "无法读取证书或私钥文件 {}：{error}；Web 管理端需能访问该文件的只读挂载",
            path.display()
        )
    })?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("证书路径必须指向普通文件".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("证书或私钥文件过大".into());
    }
    String::from_utf8(bytes)
        .map(|text| text.trim().to_string())
        .map_err(|_| "证书或私钥不是 PEM 文本".into())
}
fn material(root: &Path, host_root: &Path, paths: &CertificatePath) -> Result<Certificate, String> {
    Ok(Certificate {
        source: paths.source.clone(),
        certificate: read_path(root, host_root, &paths.certificate_path, 256 * 1024)?,
        private_key: read_path(root, host_root, &paths.private_key_path, 64 * 1024)?,
    })
}
pub(super) fn prepare(
    root: &Path,
    host_root: &Path,
    input: &mut Import,
) -> Result<Records, String> {
    if !input.certificate_paths.is_empty() && input.settings.mode != "managed" {
        return Err("证书路径自动管理仅用于内置 Nginx".into());
    }
    let mut saved = records(root)?;
    saved.retain(|service, _| {
        input
            .settings
            .routes
            .iter()
            .any(|route| route.service == *service && route.secure)
            && !input.delete_services.contains(service)
            && !input.certificates.contains_key(service)
            && input.certificate.is_empty()
    });
    for (service, paths) in &input.certificate_paths {
        if !input
            .settings
            .routes
            .iter()
            .any(|route| route.service == *service && route.secure)
        {
            return Err("证书路径与 HTTPS 服务不匹配".into());
        }
        input
            .certificates
            .insert(service.clone(), material(root, host_root, paths)?);
        saved.insert(service.clone(), paths.clone());
    }
    Ok(saved)
}
pub(super) fn commit(root: &Path, saved: &Records) -> Result<(), String> {
    super::runtime::replace(
        &root.join("https/certificate-paths.json"),
        &serde_json::to_string_pretty(saved).map_err(|error| error.to_string())?,
    )
}
pub(super) fn status(root: &Path) -> serde_json::Value {
    serde_json::json!({"paths":records(root).unwrap_or_default(),"error":fs::read_to_string(root.join("https/certificate-path-error")).unwrap_or_default()})
}

/// Read saved certificate paths and validate a new snapshot before graceful reload.
/// The command adapters hold the shared mutation guard for this operation.
pub fn reload(
    root: &Path,
    host_root: &Path,
    network: &str,
    environment: &str,
    docker: &mut dyn FnMut(&[String]) -> Result<String, String>,
) -> Result<serde_json::Value, String> {
    let result = (|| {
        let old = super::runtime::saved(root)?.ok_or("请先配置并启动内置 Nginx")?;
        if old.settings.mode != "managed"
            || super::runtime::provider(root, Some(&old.settings.mode)) != "managed"
        {
            return Err("外部 Nginx 由你维护，启动器不能重载".into());
        }
        if super::runtime::owned(root, docker)? != Some(true) {
            return Err("请先启动内置 Nginx，再重载".into());
        }
        super::runtime::apply(
            root,
            host_root,
            network,
            environment,
            Import {
                certificate_paths: records(root)?,
                settings: old.settings,
                external_local: false,
                certificate: String::new(),
                private_key: String::new(),
                certificates: Default::default(),
                delete_services: Vec::new(),
            },
            docker,
        )
    })();
    let error_file = root.join("https/certificate-path-error");
    match &result {
        Err(error) => {
            let _ = super::runtime::replace(&error_file, error);
        }
        Ok(_) => {
            if error_file.exists() {
                let _ = fs::remove_file(error_file);
            }
        }
    }
    result
}

/// Content comparison also detects certificate tools that replace symlinks.
/// Failed renewal leaves the active snapshot untouched and is retried later.
pub fn refresh_certificate_paths(
    root: &Path,
    host_root: &Path,
    network: &str,
    environment: &str,
    docker: &mut dyn FnMut(&[String]) -> Result<String, String>,
) -> Result<bool, String> {
    let _guard = crate::operation::mutation_guard()?;
    let Some(old) = super::runtime::saved(root)? else {
        return Ok(false);
    };
    if old.settings.mode != "managed"
        || super::runtime::provider(root, Some(&old.settings.mode)) != "managed"
    {
        return Ok(false);
    }
    let result: Result<bool,String> = (|| {
        let pairs = records(root)?;
        if pairs.is_empty() {
            return Ok(false);
        }
        let mut changed = false;
        for (service, pair) in pairs {
            let source = material(root, host_root, &pair)?;
            let active = super::certificates::material(root, &old, &service)?;
            changed |= source.certificate != active.certificate.trim()
                || source.private_key != active.private_key.trim();
        }
        if !changed {
            return Ok(false);
        }
        // A stopped proxy stays stopped; automatic renewal never starts it.
        if super::runtime::owned(root, docker)? != Some(true) {
            return Ok(false);
        }
        reload(root, host_root, network, environment, docker)?;
        Ok(true)
    })();
    let error_file = root.join("https/certificate-path-error");
    if let Err(error) = &result {
        let _ = super::runtime::replace(&error_file, error);
    } else if error_file.exists() {
        let _ = fs::remove_file(error_file);
    }
    result
}
