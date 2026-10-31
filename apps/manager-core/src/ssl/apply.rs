//! Validate and apply a routing revision, restoring the previous state on failure.
use super::certificates::material;
use super::proxy::{bindings, ports, run_proxy};
use super::runtime::*;
use super::*;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
type Docker<'a> = dyn FnMut(&[String]) -> Result<String, String> + 'a;

pub(super) fn backend_ports(
    settings: &mut Settings,
    environment: &str,
    old: Option<&Saved>,
) -> Result<(), String> {
    let values = crate::environment::parse_env(environment);
    let mut reserved = ports(settings);
    for service in SERVICES {
        reserved.insert(crate::configuration::env_port(
            &values, service.3, service.4,
        )?);
    }
    let mut backend = BTreeMap::new();
    for route in &settings.routes {
        let service = SERVICES
            .iter()
            .find(|service| service.0 == route.service)
            .ok_or("公网服务无效")?;
        let previous = old
            .and_then(|saved| saved.settings.upstream_ports.get(&route.service))
            .copied();
        let port = if let Some(port) = previous.filter(|port| !reserved.contains(port)) {
            port
        } else {
            let original = u32::from(crate::configuration::env_port(
                &values, service.3, service.4,
            )?);
            let mut port = if original + 10000 <= 65535 {
                (original + 10000) as u16
            } else {
                10000
            };
            while reserved.contains(&port) {
                port = if port == 65535 { 10000 } else { port + 1 };
            }
            port
        };
        reserved.insert(port);
        backend.insert(route.service.clone(), port);
    }
    settings.upstream_ports = backend;
    Ok(())
}

pub(super) fn execute(
    root: &Path,
    host_root: &Path,
    network: &str,
    environment: &str,
    mut input: Import,
    docker: &mut Docker<'_>,
    pull: Option<&mut super::ImagePull<'_>>,
    progress: Option<&mut dyn FnMut(u8, String)>,
    local_deploy: &mut dyn FnMut(&Path, &str) -> Result<Option<super::local::Transaction>, String>,
    transition: &mut dyn FnMut(bool) -> Result<(), String>,
    controlled: bool,
) -> Result<Value, String> {
    // A containerized manager cannot control the host's Nginx process.
    if input.settings.mode == "external" && root != host_root {
        input.external_local = false;
    }
    let path_records = super::path_certificates::prepare(root, host_root, &mut input)?;
    validate(&mut input)?;
    let directory = root.join("https");
    fs::create_dir_all(directory.join("revisions")).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    if !directory.join("owner").exists() {
        private(&directory.join("owner"), &identity(host_root))?;
    }
    let original = if input.settings.mode == "managed" {
        owned(root, docker)?
    } else {
        owned(root, docker).unwrap_or(None)
    };
    if input.settings.mode == "external" && original.is_some() {
        return Err("请先停止内置 Nginx 再切换到外部模式".into());
    }
    let old = saved(root)?;
    if original.is_some() && old.is_none() {
        return Err("已有内置 Nginx 缺少配置记录，请先停止入口再重新保存".into());
    }
    if controlled && input.settings.mode == "external" {
        backend_ports(&mut input.settings, environment, old.as_ref())?;
    }
    if !controlled && input.settings.mode == "managed" {
        let values = crate::environment::parse_env(environment);
        for port in ports(&input.settings) {
            if SERVICES.iter().any(|service| {
                crate::configuration::env_port(&values, service.3, service.4).ok() == Some(port)
            }) {
                return Err(
                    "Nginx 端口与引擎服务端口冲突；请使用启动器的公网配置应用端口接管".into(),
                );
            }
        }
    }
    if !controlled
        && original.is_some()
        && old
            .as_ref()
            .is_some_and(|previous| ports(&previous.settings) != ports(&input.settings))
    {
        return Err("修改监听端口前请先停止 Nginx 入口".into());
    }
    let deleting = !input.delete_services.is_empty()
        || input.certificates.is_empty()
            && input.certificate.is_empty()
            && input.private_key.is_empty()
            && old.as_ref().is_some_and(|previous| {
                previous.settings.mode == input.settings.mode
                    && previous.settings.routes.len() > input.settings.routes.len()
                    && input.settings.routes.iter().all(|route| {
                        previous.settings.routes.iter().any(|saved| {
                            saved.service == route.service
                                && saved.domain == route.domain
                                && saved.port == route.port
                                && saved.path == route.path
                                && saved.secure == route.secure
                        })
                    })
            });
    let revision = format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos(),
        std::process::id()
    );
    let staging = directory.join("revisions").join(&revision);
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let active = directory.join("nginx.conf");
    let previous = fs::read_to_string(&active).ok();
    let pending = directory.join("routing.pending.json");
    let bind = mount(host_root)?;
    let mut changed = false;
    let mut recreated = false;
    let mut upstreams = false;
    let mut local_transaction = None;
    let result = (|| {
        if input.settings.mode == "managed" && !input.settings.routes.is_empty() {
            if let (Some(pull), Some(progress)) = (pull, progress) {
                install_image_with_progress(docker, pull, progress)?;
            } else {
                install_image(docker)?;
            }
        }
        let mut materials = BTreeMap::<String, Certificate>::new();
        if let Some(previous) = &old {
            let mut services: std::collections::BTreeSet<String> =
                previous.certificate_sources.keys().cloned().collect();
            services.extend(
                previous
                    .settings
                    .routes
                    .iter()
                    .filter(|route| route.secure)
                    .map(|route| route.service.clone()),
            );
            for service in services {
                let replacing = input.certificates.contains_key(&service)
                    || (!input.certificate.is_empty()
                        && input
                            .settings
                            .routes
                            .iter()
                            .any(|route| route.service == service && route.secure));
                if !input.delete_services.contains(&service) && !replacing {
                    materials.insert(service.clone(), material(root, previous, &service)?);
                }
            }
        }
        if !input.certificate.is_empty() {
            for route in input.settings.routes.iter().filter(|route| route.secure) {
                materials.insert(
                    route.service.clone(),
                    Certificate {
                        source: "shared".into(),
                        certificate: input.certificate.clone(),
                        private_key: input.private_key.clone(),
                    },
                );
            }
        }
        materials.extend(input.certificates.clone());
        let mut sources = BTreeMap::new();
        let mut expiries = BTreeMap::new();
        let mut tls_groups = BTreeMap::new();
        for (service, material) in &materials {
            let certificate = format!("{service}-cert.pem");
            let key = format!("{service}-key.pem");
            private(&staging.join(&certificate), &material.certificate)?;
            private(&staging.join(&key), &material.private_key)?;
            let route = input
                .settings
                .routes
                .iter()
                .find(|route| route.service == *service);
            let secure = route.is_some_and(|route| route.secure);
            let uploaded =
                input.certificates.contains_key(service) || !input.certificate.is_empty();
            let expiry = if uploaded || (secure && !deleting) {
                let settings = Settings {
                    routes: route
                        .into_iter()
                        .filter(|route| route.secure)
                        .cloned()
                        .collect(),
                    ..input.settings.clone()
                };
                check_cert(
                    docker,
                    &bind,
                    &revision,
                    &settings,
                    &certificate,
                    &staging,
                    secure,
                )?
            } else {
                old.as_ref()
                    .and_then(|previous| {
                        previous
                            .certificate_expiries
                            .get(service)
                            .cloned()
                            .or_else(|| Some(previous.expires_at.clone()))
                    })
                    .unwrap_or_default()
            };
            if input.settings.mode == "external" {
                check_local_key(&staging, &certificate, &key)?;
            }
            if let Some(route) = route.filter(|route| route.secure) {
                let fingerprint = format!(
                    "{}|{}",
                    material.certificate.split_whitespace().collect::<String>(),
                    material.private_key.split_whitespace().collect::<String>()
                );
                let group = (
                    route.domain.clone(),
                    route.port.unwrap_or(input.settings.https_port),
                );
                if let Some(existing) = tls_groups.insert(group, fingerprint.clone()) {
                    if existing != fingerprint {
                        return Err(
                            "同一域名和端口的路径分流必须使用同一套证书和私钥，请使用共用证书"
                                .into(),
                        );
                    }
                }
            }
            sources.insert(service.clone(), material.source.clone());
            expiries.insert(service.clone(), expiry);
        }
        for route in input.settings.routes.iter().filter(|route| route.secure) {
            if !materials.contains_key(&route.service) {
                return Err(format!("{} 请先选择 SSL 证书和私钥", route.service));
            }
        }
        let expiry = input
            .settings
            .routes
            .iter()
            .filter(|route| route.secure)
            .filter_map(|route| expiries.get(&route.service))
            .min()
            .cloned()
            .unwrap_or_default();
        let fragment = configuration_multiple(&input.settings, &revision, environment, true);
        let configuration = format!("events {{}}\nhttp {{\n{fragment}\n}}\n");
        private(&staging.join("nginx.conf"), &configuration)?;
        if input.settings.mode == "managed" && !input.settings.routes.is_empty() {
            call(
                docker,
                &[
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--mount",
                    &bind,
                    IMAGE,
                    "nginx",
                    "-t",
                    "-c",
                    &format!("/etc/box-https/revisions/{revision}/nginx.conf"),
                ],
            )
            .map_err(|error| format!("Nginx 配置校验失败：{error}"))?;
        }
        let local_ready = if controlled && input.settings.mode == "external" && input.external_local
        {
            super::local::available()?
        } else {
            true
        };
        if controlled && local_ready {
            replace(
                &pending,
                &serde_json::to_string(&input.settings).map_err(|error| error.to_string())?,
            )?;
            upstreams = true;
            transition(false)?;
        }
        if input.settings.mode == "managed" {
            let change_ports = old
                .as_ref()
                .is_some_and(|previous| bindings(&previous.settings) != bindings(&input.settings));
            let mut existing = original;
            if original.is_some() && (change_ports || input.settings.routes.is_empty()) {
                call(docker, &["rm", "-f", &name(root)])?;
                recreated = true;
                existing = None;
            }
            replace(&active, &configuration)?;
            changed = true;
            if !input.settings.routes.is_empty() {
                if let Some(running) = existing {
                    if !running {
                        call(docker, &["start", &name(root)])?;
                    }
                    call(
                        docker,
                        &[
                            "exec",
                            &name(root),
                            "nginx",
                            "-t",
                            "-c",
                            "/etc/box-https/nginx.conf",
                        ],
                    )?;
                    call(
                        docker,
                        &[
                            "exec",
                            &name(root),
                            "nginx",
                            "-s",
                            "reload",
                            "-c",
                            "/etc/box-https/nginx.conf",
                        ],
                    )?;
                } else {
                    recreated = true;
                    run_proxy(root, network, &bind, &input.settings, docker)?;
                }
            }
        } else if input.external_local && local_ready {
            if root != host_root {
                return Err("本机 Nginx 需要管理端直接运行在 Nginx 所在机器".into());
            }
            let config = super::local::configuration(&fragment, host_root, &identity(root))?;
            local_transaction = local_deploy(root, &config)?;
        }
        let pending_local = !local_ready || (input.external_local && local_transaction.is_none());
        let saved = Saved {
            settings: input.settings.clone(),
            external_local: input.external_local,
            pending_local,
            expires_at: expiry,
            revision: revision.clone(),
            external_config: super::local::configuration(
                &configuration_multiple(
                    &Settings {
                        mode: "external".into(),
                        ..input.settings.clone()
                    },
                    &revision,
                    environment,
                    true,
                ),
                host_root,
                &identity(root),
            )?,
            certificate_sources: sources,
            certificate_expiries: expiries,
        };
        replace(
            &directory.join("settings.json"),
            &serde_json::to_string_pretty(&saved).map_err(|error| error.to_string())?,
        )?;
        if pending.exists() {
            fs::remove_file(&pending).map_err(|error| error.to_string())?;
        }
        super::path_certificates::commit(root, &path_records)?;
        Ok(
            json!({"config":saved,"running":input.settings.mode=="managed" && !input.settings.routes.is_empty(),"externalLocalApplied":local_transaction.is_some(),"sslWarning":if pending_local {"公网配置和证书已保存；需要安装并启动本机 Nginx 后再次保存，入口尚未生效。"}else if input.settings.mode == "external" && !input.external_local && !input.settings.routes.is_empty() {"公网配置已生成，请在宿主机 Nginx 中导入配置、检查并重载后验证访问。"} else{""},"daysRemaining":null}),
        )
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&pending);
        let rollback = (|| {
            if let Some(transaction) = &local_transaction {
                transaction.rollback()?;
            }
            if recreated {
                if owned(root, docker)?.is_some() {
                    call(docker, &["rm", "-f", &name(root)])?;
                }
            }
            if upstreams {
                transition(true)?;
            }
            if changed || recreated {
                if let Some(previous) = &previous {
                    replace(&active, previous)?;
                    if let Some(was_running) = original {
                        if recreated {
                            run_proxy(
                                root,
                                network,
                                &bind,
                                &old.as_ref().ok_or("缺少旧 Nginx 设置")?.settings,
                                docker,
                            )?;
                        } else {
                            call(
                                docker,
                                &[
                                    "exec",
                                    &name(root),
                                    "nginx",
                                    "-s",
                                    "reload",
                                    "-c",
                                    "/etc/box-https/nginx.conf",
                                ],
                            )?;
                        }
                        if !was_running {
                            call(docker, &["stop", &name(root)])?;
                        }
                    }
                } else {
                    let _ = fs::remove_file(&active);
                }
            }
            Ok::<(), String>(())
        })();
        if rollback.is_ok() {
            let _ = fs::remove_dir_all(staging);
        }
        return Err(format!(
            "{error}；{}",
            if rollback.is_ok() {
                "原配置已保留或恢复".into()
            } else {
                format!("回退失败：{}", rollback.unwrap_err())
            }
        ));
    }
    result
}
