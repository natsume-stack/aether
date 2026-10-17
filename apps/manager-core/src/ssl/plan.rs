//! Compose port ownership, upstream transitions and public routing configuration.
use super::*;
use std::{fs, path::Path};

pub fn routing_settings(root: &Path) -> Result<Option<Settings>, String> {
    let pending = root.join("https/routing.pending.json");
    if pending.exists() {
        return serde_json::from_str(&fs::read_to_string(pending).map_err(|e| e.to_string())?)
            .map(Some)
            .map_err(|e| e.to_string());
    }
    let saved = root.join("https/settings.json");
    if !saved.exists() {
        return Ok(None);
    }
    let config: Saved =
        serde_json::from_str(&fs::read_to_string(saved).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    Ok(Some(config.settings))
}
fn controller_owned(root: &Path, settings: &Settings) -> bool {
    super::runtime::provider(root, Some(&settings.mode)) == settings.mode
}
/// Keep host HTTP bindings out of the ports owned by Nginx. No application is started here.
pub fn compose_source(root: &Path, source: &str) -> Result<String, String> {
    if fs::read_to_string(root.join("https/provider"))
        .is_ok_and(|value| value.trim() == "external-manual")
    {
        return Ok(source.into());
    }
    let Some(settings) = routing_settings(root)?.or(draft_settings(root)?) else {
        return Ok(source.into());
    };
    if !controller_owned(root, &settings) {
        return Ok(source.into());
    }
    let values =
        crate::environment::parse_env(&fs::read_to_string(root.join(".env")).unwrap_or_default());
    let targets: std::collections::BTreeSet<&str> = settings
        .routes
        .iter()
        .filter(|route| {
            let mode = if matches!(route.service.as_str(), "creator" | "voxa") {
                "BOX_CREATOR_NETWORK_MODE"
            } else {
                "BOX_PLAY_NETWORK_MODE"
            };
            values.get(mode).is_none_or(|value| value == "public")
        })
        .map(|route| route.service.as_str())
        .collect();
    let mut result = String::new();
    let mut service = "";
    let mut skipping = false;
    for line in source.lines() {
        let indent = line.bytes().take_while(|byte| *byte == b' ').count();
        if indent == 2 && line.trim_end().ends_with(':') {
            service = line.trim().trim_end_matches(':');
        }
        if skipping {
            if indent > 4 || line.trim().is_empty() {
                continue;
            }
            skipping = false;
        }
        if indent == 4 && line.trim() == "ports:" && targets.contains(service) {
            if settings.mode == "external" {
                if let Some(port) = settings.upstream_ports.get(service) {
                    let internal = SERVICES
                        .iter()
                        .find(|s| s.0 == service)
                        .ok_or("公网服务无效")?
                        .2;
                    result.push_str(&format!(
                        "    ports:\n      - \"127.0.0.1:{port}:{internal}\"\n"
                    ));
                } else {
                    result.push_str(line);
                    result.push('\n');
                    continue;
                }
            }
            skipping = true;
            continue;
        }
        result.push_str(line);
        result.push('\n');
    }
    Ok(result)
}
fn draft_settings(root: &Path) -> Result<Option<Settings>, String> {
    let Ok(content) = fs::read_to_string(root.join(".env")) else {
        return Ok(None);
    };
    let values = crate::environment::parse_env(&content);
    if values.get("BOX_PLAY_NETWORK_MODE").map(String::as_str) != Some("public") {
        return Ok(None);
    }
    let mut routes = Vec::new();
    for (service, label, _, key, port) in crate::public_access::SERVICES {
        let Some(address) = values
            .get(&format!("{key}_PUBLIC_ADDRESS_OVERRIDE"))
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let (domain, port, secure, path) = if address.contains("://") {
            crate::configuration_migration::public_url_parts(address, label)?
        } else {
            (
                address.clone(),
                crate::configuration::env_port(&values, &format!("{key}_PORT"), port)?,
                false,
                String::new(),
            )
        };
        routes.push(Route {
            service: service.into(),
            domain,
            port: Some(port),
            secure,
            path: crate::public_access::prefix(&path)?,
        });
    }
    if routes.is_empty() {
        return Ok(None);
    }
    let mode = super::runtime::provider(root, None).to_string();
    let mut settings = Settings {
        mode,
        https_port: 443,
        routes,
        upstream_ports: Default::default(),
    };
    if settings.mode == "external" {
        super::apply::backend_ports(&mut settings, &content, None)?;
    }
    Ok(Some(settings))
}
/// Select only this project's currently running applications when ports must move.
pub fn transition_services(
    root: &Path,
    project: &str,
    desired: &Settings,
    docker: &mut dyn FnMut(&[String]) -> Result<String, String>,
    compose: &mut dyn FnMut(&[String]) -> Result<String, String>,
) -> Result<(), String> {
    let mut targets: std::collections::BTreeSet<String> =
        desired.routes.iter().map(|r| r.service.clone()).collect();
    if let Ok(text) = fs::read_to_string(root.join("https/settings.json")) {
        if let Ok(old) = serde_json::from_str::<Saved>(&text) {
            targets.extend(old.settings.routes.into_iter().map(|r| r.service));
        }
    }
    let mut running = Vec::new();
    for service in targets {
        let args = vec![
            "container".into(),
            "ls".into(),
            "--filter".into(),
            format!("label=com.docker.compose.project={project}"),
            "--filter".into(),
            format!("label=com.docker.compose.service={service}"),
            "--format".into(),
            "{{.ID}}".into(),
        ];
        if !docker(&args)?.trim().is_empty() {
            running.push(service);
        }
    }
    if running.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "up".into(),
        "-d".into(),
        "--no-deps".into(),
        "--no-build".into(),
        "--force-recreate".into(),
    ];
    args.extend(running);
    compose(&args).map(|_| ())
}
fn upstream(settings: &Settings, route: &Route, environment: &str) -> String {
    let service = SERVICES.iter().find(|s| s.0 == route.service).unwrap();
    if settings.mode == "managed" {
        return format!("{}:{}", service.1, service.2);
    }
    let values = crate::environment::parse_env(environment);
    format!(
        "127.0.0.1:{}",
        settings
            .upstream_ports
            .get(&route.service)
            .copied()
            .or_else(|| values.get(service.3).and_then(|v| v.parse().ok()))
            .unwrap_or(service.4)
    )
}
pub(super) fn configuration(
    settings: &Settings,
    revision: &str,
    environment: &str,
    multiple: bool,
) -> String {
    let mut output =
        "map $http_upgrade $box_ssl_connection { default upgrade; '' close; }\n".to_string();
    let mut groups: BTreeMap<(String, u16), Vec<&Route>> = BTreeMap::new();
    for route in &settings.routes {
        groups
            .entry((
                route.domain.clone(),
                route.port.unwrap_or(if route.secure {
                    if settings.mode == "managed" {
                        443
                    } else {
                        settings.https_port
                    }
                } else {
                    80
                }),
            ))
            .or_default()
            .push(route);
    }
    for ((domain, port), routes) in groups {
        let first = routes[0];
        output.push_str(&format!(
            "server {{\n listen {port}{};\n server_name {domain};\n client_max_body_size 256m;\n",
            if first.secure { " ssl" } else { "" }
        ));
        if first.secure {
            let cert = if multiple {
                format!("{}-cert.pem", first.service)
            } else {
                "cert.pem".into()
            };
            let key = if multiple {
                format!("{}-key.pem", first.service)
            } else {
                "key.pem".into()
            };
            output.push_str(&format!(" ssl_certificate /etc/box-https/revisions/{revision}/{cert};\n ssl_certificate_key /etc/box-https/revisions/{revision}/{key};\n ssl_protocols TLSv1.2 TLSv1.3;\n"));
        }
        for route in &routes {
            let target = upstream(settings, route, environment);
            let location = if route.path.is_empty() {
                "/".into()
            } else {
                format!("{}/", route.path)
            };
            if !route.path.is_empty() {
                output.push_str(&format!(
                    " location = {} {{ return 308 {}/$is_args$args; }}\n",
                    route.path, route.path
                ));
            }
            output.push_str(&format!(
                " location {}{location} {{\n",
                if route.path.is_empty() { "" } else { "^~ " }
            ));
            if settings.mode == "managed" {
                output.push_str("  resolver 127.0.0.11 valid=30s ipv6=off;\n");
            }
            // `set` runs in the rewrite phase and must precede `rewrite ...
            // break`, which ends that phase for this location. Otherwise
            // $box_upstream stays empty and proxy_pass fails with
            // "invalid URL prefix in \"\"" (HTTP 500) for prefixed routes.
            output.push_str(&format!("  set $box_upstream http://{target};\n"));
            if !route.path.is_empty() {
                output.push_str(&format!("  rewrite ^{}(/.*)$ $1 break;\n", route.path));
            }
            output.push_str(&format!("  proxy_pass $box_upstream;\n  proxy_http_version 1.1;\n  proxy_set_header Host $http_host;\n  proxy_set_header X-Forwarded-Proto {};\n  proxy_set_header X-Forwarded-Host $http_host;\n  proxy_set_header X-Forwarded-For $remote_addr;\n  proxy_set_header X-Forwarded-Prefix \"{}\";\n  proxy_set_header Accept-Encoding \"\";\n  proxy_set_header Upgrade $http_upgrade;\n  proxy_set_header Connection $box_ssl_connection;\n  proxy_read_timeout 3600s;\n }}\n",if route.secure{"https"}else{"http"},route.path));
        }
        if routes.iter().all(|r| !r.path.is_empty()) {
            output.push_str(" location / { return 404; }\n");
        }
        output.push_str("}\n");
    }
    output
}

pub use super::transition::UpstreamTransition;

pub fn validate_path_images(
    settings: &Settings,
    environment: &BTreeMap<String, String>,
    docker: &mut dyn FnMut(&[String]) -> Result<String, String>,
) -> Result<(), String> {
    for route in settings
        .routes
        .iter()
        .filter(|route| !route.path.is_empty())
    {
        let key = match route.service.as_str() {
            "play" => "BOX_PLAY_IMAGE",
            "creator" => "BOX_CREATOR_IMAGE",
            "voxa" => "BOX_VOXA_IMAGE",
            "player-service" => "BOX_PLAYER_SERVICE_IMAGE",
            "player-auth-portal" => "BOX_AUTH_PORTAL_IMAGE",
            _ => return Err("当前服务不支持入口路径".into()),
        };
        let image = if let Some(image) = environment
            .get(key)
            .filter(|image| !image.trim().is_empty())
        {
            image.clone()
        } else {
            let tag = environment
                .get("BOX_IMAGE_TAG")
                .filter(|tag| !tag.trim().is_empty())
                .ok_or("无法确定服务镜像版本")?;
            format!("box-local-engine-{}:{tag}", route.service)
        };
        let args = vec![
            "image".into(),
            "inspect".into(),
            "--format".into(),
            "{{json .Config.Labels}}".into(),
            image,
        ];
        let labels = match docker(&args) {
            Ok(labels) => labels,
            // Routes may be configured before optional components are installed.
            // Inspect local images only; saving settings must not install them.
            Err(error) if error.to_ascii_lowercase().contains("no such image") => continue,
            Err(error) => return Err(format!("无法检查 {} 的镜像入口路径能力：{error}", route.service)),
        };
        let metadata: serde_json::Value = serde_json::from_str(&labels)
            .map_err(|_| "镜像路径能力记录无效")?;
        if metadata["box.routing.base-path"].as_str() != Some("runtime-v1") {
            return Err(format!(
                "{} 的镜像暂不支持入口路径，请先安装支持前缀的新镜像",
                route.service
            ));
        }
    }
    Ok(())
}
