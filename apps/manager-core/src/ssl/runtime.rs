#[cfg(test)]
pub(super) use super::certificate_checks::openssl_command;
pub(super) use super::certificate_checks::{check_cert, check_local_key};
use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
pub(super) type Docker<'a> = dyn FnMut(&[String]) -> Result<String, String> + 'a;

pub(super) fn call(docker: &mut Docker<'_>, args: &[&str]) -> Result<String, String> {
    docker(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
}
pub(super) fn identity(root: &Path) -> String {
    if let Ok(owner) = fs::read_to_string(root.join("https/owner")) {
        if owner.len() == 16 && owner.bytes().all(|b| b.is_ascii_hexdigit()) {
            return owner;
        }
    }
    format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()))[..16].to_string()
}
pub(super) fn name(root: &Path) -> String {
    format!("box-https-{}", identity(root))
}
pub(super) fn owned(root: &Path, docker: &mut Docker<'_>) -> Result<Option<bool>, String> {
    // `container ls` distinguishes a missing container from an unavailable daemon.
    let id = call(
        docker,
        &[
            "container",
            "ls",
            "-a",
            "--filter",
            &format!("name=^/{}$", name(root)),
            "--format",
            "{{.ID}}",
        ],
    )?;
    if id.trim().is_empty() {
        return Ok(None);
    }
    let owner = call(
        docker,
        &[
            "inspect",
            "--format",
            "{{index .Config.Labels \"box.https.owner\"}}",
            &name(root),
        ],
    )?;
    if owner.trim() != identity(root) {
        return Err("HTTPS 容器名称已被其他程序使用，未修改该容器".into());
    }
    Ok(Some(
        call(
            docker,
            &["inspect", "--format", "{{.State.Running}}", &name(root)],
        )?
        .trim()
            == "true",
    ))
}
pub(super) fn private(path: &Path, data: &str) -> Result<(), String> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(data.as_bytes()).map_err(|e| e.to_string())
}
pub(super) fn replace(path: &Path, data: &str) -> Result<(), String> {
    let temporary = path.with_extension("pending");
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(|e| e.to_string())?;
    }
    private(&temporary, data)?;
    // Windows cannot rename over an existing file; retain a rollback copy.
    let backup = path.with_extension("previous");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(e.to_string());
    }
    Ok(())
}
pub(super) fn saved(root: &Path) -> Result<Option<Saved>, String> {
    let path = root.join("https/settings.json");
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| e.to_string())
}
pub fn install_image(docker: &mut Docker<'_>) -> Result<(), String> {
    if call(docker, &["image", "inspect", IMAGE]).is_err() {
        call(docker, &["pull", IMAGE])?;
    }
    Ok(())
}

pub fn install_image_with_progress(
    docker: &mut Docker<'_>,
    pull: &mut super::ImagePull<'_>,
    progress: &mut dyn FnMut(u8, String),
) -> Result<(), String> {
    if call(docker, &["image", "inspect", IMAGE]).is_err() {
        pull(IMAGE, progress)?;
    }
    Ok(())
}
/// Keep generated application links and CORS origins aligned with saved managed HTTPS listeners.
/// Engine host ports remain HTTP upstream ports and must never be replaced by TLS ports.
pub fn apply_runtime_urls(
    root: &Path,
    values: &BTreeMap<String, String>,
    derived: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    for service in SERVICES {
        derived.insert(
            service.3.trim_end_matches("_PORT").to_owned() + "_TRUST_PROXY",
            if values.get("BOX_TRUST_PROXY").is_some_and(|value| value == "true") {
                "true"
            } else {
                "false"
            }.into(),
        );
        derived.insert(
            service.3.trim_end_matches("_PORT").to_owned() + "_BASE_PATH",
            String::new(),
        );
    }
    derived.insert("BOX_PUBLIC_SERVICE_PREFIXES_BY_ORIGIN".into(), "{}".into());
    if fs::read_to_string(root.join("https/provider"))
        .is_ok_and(|value| value.trim() == "external-manual")
    {
        let mut peers: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (service, _, _, _, _) in SERVICES {
            let prefix = SERVICES
                .iter()
                .find(|entry| entry.0 == service)
                .unwrap()
                .3
                .trim_end_matches("_PORT");
            let Some(url) = derived.get(&format!("{prefix}_PUBLIC_URL")) else {
                continue;
            };
            let (host, port, secure, path) =
                crate::configuration_migration::public_url_parts(url, "公开地址")?;
            let path = crate::public_access::prefix(&path)?;
            let origin = format!(
                "{}://{}{}",
                if secure { "https" } else { "http" },
                crate::configuration::origin_host(&host)?,
                if port == if secure { 443 } else { 80 } {
                    String::new()
                } else {
                    format!(":{port}")
                }
            );
            derived.insert(format!("{prefix}_BASE_PATH"), path.clone());
            if !path.is_empty() {
                peers.entry(origin).or_default().push(path);
            }
        }
        for key in ["BOX_BIND_IP", "BOX_CREATOR_BIND_IP", "BOX_VOXA_BIND_IP"] {
            let address = values.get(key).map(String::as_str).unwrap_or("127.0.0.1");
            address
                .parse::<std::net::IpAddr>()
                .map_err(|_| format!("{key} 必须是监听 IP"))?;
            derived.insert(key.into(), address.into());
        }
        derived.insert(
            "BOX_PUBLIC_SERVICE_PREFIXES_BY_ORIGIN".into(),
            serde_json::to_string(&peers).map_err(|error| error.to_string())?,
        );
        return Ok(());
    }
    let Some(settings) = super::plan::routing_settings(root)? else {
        return Ok(());
    };
    let provider =
        fs::read_to_string(root.join("https/provider")).unwrap_or_else(|_| settings.mode.clone());
    if provider.trim() != settings.mode {
        return Ok(());
    }
    let mut overrides = values.clone();
    let mut peers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for route in &settings.routes {
        let Some(service) = SERVICES.iter().find(|service| service.0 == route.service) else {
            continue;
        };
        let mode = if matches!(route.service.as_str(), "creator" | "voxa") {
            "BOX_CREATOR_NETWORK_MODE"
        } else {
            "BOX_PLAY_NETWORK_MODE"
        };
        if values.get(mode).map(String::as_str) != Some("public") {
            continue;
        }
        let key = service.3.trim_end_matches("_PORT");
        // Managed routes have no published application ports; generated
        // external routes bind their upstreams to loopback. Only these
        // isolated services may automatically trust Nginx's replaced headers.
        if settings.mode == "managed" || settings.upstream_ports.contains_key(&route.service) {
            derived.insert(format!("{key}_TRUST_PROXY"), "true".into());
        }
        let port = route.port.unwrap_or(if route.secure {
            settings.https_port
        } else {
            80
        });
        let origin = format!(
            "{}://{}{}",
            if route.secure { "https" } else { "http" },
            crate::configuration::origin_host(&route.domain)?,
            if port == if route.secure { 443 } else { 80 } {
                String::new()
            } else {
                format!(":{port}")
            }
        );
        overrides.insert(
            format!("{key}_PUBLIC_URL_OVERRIDE"),
            format!("{origin}{}", route.path),
        );
        if route.service == "player-auth-portal" {
            overrides.insert(
                "BOX_PLAYER_LOGIN_URL_OVERRIDE".into(),
                format!("{origin}{}", route.path),
            );
        }
        derived.insert(format!("{key}_BASE_PATH"), route.path.clone());
        if !route.path.is_empty() {
            peers.entry(origin).or_default().push(route.path.clone());
        }
    }
    crate::configuration_migration::apply_url_overrides(&overrides, derived)?;
    derived.insert(
        "BOX_PUBLIC_SERVICE_PREFIXES_BY_ORIGIN".into(),
        serde_json::to_string(&peers).map_err(|error| error.to_string())?,
    );
    Ok(())
}
pub fn set_provider(root: &Path, mode: &str) -> Result<(), String> {
    if !matches!(
        mode,
        "managed" | "external" | "external-manual" | "disabled"
    ) {
        return Err("Nginx 来源无效".into());
    }
    fs::create_dir_all(root.join("https")).map_err(|e| e.to_string())?;
    replace(&root.join("https/provider"), mode)
}

pub(super) fn provider(root: &Path, saved_mode: Option<&str>) -> &'static str {
    let selected = fs::read_to_string(root.join("https/provider")).ok();
    match selected.as_deref().map(str::trim).or(saved_mode) {
        Some("external" | "external-manual") => "external",
        _ => "managed",
    }
}

pub fn status(root: &Path, docker: &mut Docker<'_>) -> Result<Value, String> {
    let config = saved(root)?;
    let days = config
        .as_ref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s.expires_at).ok())
        .map(|expiry| (expiry.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days());
    let running = owned(root, docker).unwrap_or(None).unwrap_or(false);
    let provider = provider(root, config.as_ref().map(|c| c.settings.mode.as_str()));
    let nginx_config_available = provider == "managed" && root.join("https/nginx.conf").is_file();
    let image = call(docker, &["image", "inspect", IMAGE]);
    let image_available = image.is_ok();
    let metadata = if running {
        call(docker, &["inspect", &name(root)]).ok()
    } else {
        image.ok()
    };
    let image_version = metadata
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value[0]["Config"]["Env"].as_array().cloned())
        .and_then(|env| {
            env.iter()
                .filter_map(Value::as_str)
                .find_map(|entry| entry.strip_prefix("NGINX_VERSION=").map(str::to_owned))
        });
    Ok(
        json!({"config":config,"running":running,"daysRemaining":days,"provider":provider,"nginxConfigAvailable":nginx_config_available,"imageAvailable":image_available,"imageVersion":image_version,"certificatePaths":super::path_certificates::status(root)["paths"],"certificatePathError":super::path_certificates::status(root)["error"],"externalNginx":super::local::status(),"externalManual":fs::read_to_string(root.join("https/provider")).is_ok_and(|value|value.trim()=="external-manual")}),
    )
}
pub(super) fn mount(host_root: &Path) -> Result<String, String> {
    let value = host_root.join("https").to_string_lossy().to_string();
    if value.contains(',') || value.contains('\n') {
        return Err("数据目录不能包含逗号或换行".into());
    }
    Ok(format!("type=bind,src={value},dst=/etc/box-https,readonly"))
}
pub fn apply(
    root: &Path,
    host_root: &Path,
    network: &str,
    environment: &str,
    input: Import,
    docker: &mut Docker<'_>,
) -> Result<Value, String> {
    apply_with_local(
        root,
        host_root,
        network,
        environment,
        input,
        docker,
        &mut super::local::deploy,
    )
}

pub(super) fn apply_with_local(
    root: &Path,
    host_root: &Path,
    network: &str,
    environment: &str,
    input: Import,
    docker: &mut Docker<'_>,
    local_deploy: &mut dyn FnMut(&Path, &str) -> Result<Option<super::local::Transaction>, String>,
) -> Result<Value, String> {
    super::apply::execute(
        root,
        host_root,
        network,
        environment,
        input,
        docker,
        None,
        None,
        local_deploy,
        &mut |_| Ok(()),
        false,
    )
}
pub fn apply_with_transition(
    root: &Path,
    host_root: &Path,
    network: &str,
    environment: &str,
    input: Import,
    docker: &mut Docker<'_>,
    transition: &mut dyn FnMut(bool) -> Result<(), String>,
) -> Result<Value, String> {
    super::apply::execute(
        root,
        host_root,
        network,
        environment,
        input,
        docker,
        None,
        None,
        &mut super::local::deploy,
        transition,
        true,
    )
}
pub fn apply_with_transition_progress(
    root: &Path,
    host_root: &Path,
    network: &str,
    environment: &str,
    input: Import,
    docker: &mut Docker<'_>,
    pull: &mut super::ImagePull<'_>,
    progress: &mut dyn FnMut(u8, String),
    transition: &mut dyn FnMut(bool) -> Result<(), String>,
) -> Result<Value, String> {
    super::apply::execute(
        root,
        host_root,
        network,
        environment,
        input,
        docker,
        Some(pull),
        Some(progress),
        &mut super::local::deploy,
        transition,
        true,
    )
}

pub fn stop(root: &Path, docker: &mut Docker<'_>) -> Result<Value, String> {
    if owned(root, docker)?.is_some() {
        call(docker, &["rm", "-f", &name(root)])?;
    }
    status(root, docker)
}
pub fn verify_endpoint(root: &Path, docker: &mut Docker<'_>) -> Result<Value, String> {
    let saved = saved(root)?.ok_or("请先导入并校验证书")?;
    let mut checks = Vec::new();
    for route in saved
        .settings
        .routes
        .into_iter()
        .filter(|route| route.secure)
    {
        let is_ip = route.domain.parse::<std::net::IpAddr>().is_ok();
        let target = format!(
            "{}:{}",
            crate::configuration::origin_host(&route.domain)?,
            route.port.unwrap_or(saved.settings.https_port)
        );
        let result = call(
            docker,
            &[
                "run",
                "--rm",
                "-i",
                IMAGE,
                "timeout",
                "10",
                "openssl",
                "s_client",
                "-connect",
                &target,
                "-servername",
                &route.domain,
                if is_ip {
                    "-verify_ip"
                } else {
                    "-verify_hostname"
                },
                &route.domain,
                "-verify_return_error",
                "-brief",
            ],
        );
        checks.push(json!({"domain":route.domain,"ok":result.is_ok(),"message":if result.is_ok() { "公网 TLS 证书链与域名验证通过".to_string() } else { "公网 TLS 验证失败，请检查 DNS、端口、证书链及信任根".to_string() }}));
    }
    Ok(json!({"checks":checks}))
}
