//! Certificate import and Nginx configuration shared by both manager transports.
mod apply;
mod certificate_checks;
mod certificates;
mod local;
mod path_certificates;
mod plan;
mod runtime;
mod transition;
pub use path_certificates::{refresh_certificate_paths, reload};
mod raw;
pub use raw::{read_raw_nginx_config, save_raw_nginx_config};
mod proxy;
pub use certificates::delete_certificate;
pub use plan::{
    compose_source, routing_settings, transition_services, validate_path_images, UpstreamTransition,
};
pub use runtime::{
    apply, install_image, install_image_with_progress, set_provider, status, stop, verify_endpoint,
};
pub use runtime::{apply_runtime_urls, apply_with_transition, apply_with_transition_progress};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const IMAGE: &str = "docker.m.daocloud.io/library/nginx:stable-bookworm";
pub type ImagePull<'a> = dyn FnMut(&str, &mut dyn FnMut(u8, String)) -> Result<(), String> + 'a;
pub const SERVICES: [(&str, &str, u16, &str, u16); 6] = [
    ("play", "play", 3000, "BOX_PLAY_PORT", 3121),
    ("creator", "creator", 3000, "BOX_CREATOR_PORT", 3127),
    ("voxa", "voxa", 3001, "BOX_VOXA_PORT", 3123),
    (
        "player-service",
        "player-service",
        3213,
        "BOX_PLAYER_SERVICE_PORT",
        3124,
    ),
    (
        "player-auth-portal",
        "player-auth-portal",
        3214,
        "BOX_AUTH_PORTAL_PORT",
        3125,
    ),
    (
        "server-manager",
        "server-manager",
        3130,
        "BOX_SERVER_MANAGER_PORT",
        3130,
    ),
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Route {
    pub service: String,
    pub domain: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub path: String,
    #[serde(default = "secure_route")]
    pub secure: bool,
}
fn secure_route() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub mode: String,
    pub https_port: u16,
    pub routes: Vec<Route>,
    #[serde(default)]
    pub upstream_ports: BTreeMap<String, u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Import {
    #[serde(default)]
    pub certificate_paths: BTreeMap<String, CertificatePath>,
    pub settings: Settings,
    #[serde(default)]
    pub external_local: bool,
    #[serde(default)]
    pub certificate: String,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub certificates: BTreeMap<String, Certificate>,
    #[serde(default)]
    pub delete_services: Vec<String>,
}

fn independent_certificate() -> String {
    "independent".into()
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Certificate {
    #[serde(default = "independent_certificate")]
    pub source: String,
    pub certificate: String,
    pub private_key: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertificatePath {
    pub certificate_path: String,
    pub private_key_path: String,
    #[serde(default = "independent_certificate")]
    pub source: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub settings: Settings,
    #[serde(default)]
    pub external_local: bool,
    #[serde(default)]
    pub pending_local: bool,
    pub expires_at: String,
    pub revision: String,
    pub external_config: String,
    #[serde(default)]
    pub certificate_sources: BTreeMap<String, String>,
    #[serde(default)]
    pub certificate_expiries: BTreeMap<String, String>,
}

pub fn domain(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    let value = value.trim_matches(['[', ']']).to_string();
    if let Ok(ip) = value.parse::<std::net::IpAddr>() {
        return Ok(ip.to_string());
    }
    if value.len() > 253
        || !value.contains('.')
        || value.parse::<std::net::IpAddr>().is_ok()
        || value.split('.').any(|p| {
            p.is_empty()
                || p.len() > 63
                || p.starts_with('-')
                || p.ends_with('-')
                || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("请填写证书覆盖的域名，不包含协议、端口、通配符或路径".into());
    }
    Ok(value)
}

pub fn validate(input: &mut Import) -> Result<(), String> {
    if !matches!(input.settings.mode.as_str(), "managed" | "external")
        || input.settings.https_port == 0
    {
        return Err("HTTPS 模式或端口无效".into());
    }
    if input.settings.routes.len() > SERVICES.len() {
        return Err("公网路由数量无效".into());
    }
    let mut domains = BTreeSet::new();
    let mut services = BTreeSet::new();
    let mut protocols = BTreeMap::new();
    for route in &mut input.settings.routes {
        route.domain = domain(&route.domain)?;
        route.path = crate::public_access::prefix(&route.path)?;
        let port = route.port.unwrap_or(if route.secure {
            input.settings.https_port
        } else {
            80
        });
        if protocols
            .insert(port, route.secure)
            .is_some_and(|secure| secure != route.secure)
        {
            return Err("同一个公网端口不能同时使用 HTTP 和 HTTPS".into());
        }
        if route.port == Some(0)
            || !SERVICES.iter().any(|s| s.0 == route.service)
            || !services.insert(route.service.clone())
            || !domains.insert((
                route.domain.clone(),
                route.port.unwrap_or(if route.secure {
                    input.settings.https_port
                } else {
                    80
                }),
                route.path.clone(),
            ))
        {
            return Err("同一个服务只能配置一次；同一地址、端口和路径不能重复".into());
        }
    }
    if input.certificates.len() > SERVICES.len()
        || input
            .certificates
            .keys()
            .any(|key| !SERVICES.iter().any(|service| service.0 == key))
    {
        return Err("证书服务配置无效".into());
    }
    for service in &input.delete_services {
        if !SERVICES.iter().any(|entry| entry.0 == service)
            || input.certificates.contains_key(service)
            || input
                .settings
                .routes
                .iter()
                .any(|route| route.service == *service && route.secure)
        {
            return Err("证书删除参数与当前 HTTPS 路由冲突".into());
        }
    }
    if !input.certificate.is_empty() || !input.private_key.is_empty() {
        validate_pem(&input.certificate, &input.private_key)?;
    }
    for cert in input.certificates.values() {
        if !matches!(cert.source.as_str(), "shared" | "independent") {
            return Err("证书来源无效".into());
        }
        validate_pem(&cert.certificate, &cert.private_key)?;
    }

    Ok(())
}

fn validate_pem(certificate: &str, private_key: &str) -> Result<(), String> {
    if certificate.len() > 256 * 1024
        || private_key.len() > 64 * 1024
        || !certificate.starts_with("-----BEGIN CERTIFICATE-----")
        || !(private_key.starts_with("-----BEGIN PRIVATE KEY-----")
            || private_key.starts_with("-----BEGIN RSA PRIVATE KEY-----")
            || private_key.starts_with("-----BEGIN EC PRIVATE KEY-----"))
    {
        return Err(
            "请导入 PEM 格式完整证书链和未加密私钥，证书不超过 256 KB、私钥不超过 64 KB".into(),
        );
    }
    Ok(())
}

/// A conf.d fragment for an existing Nginx; managed mode wraps it in http {}.
pub fn configuration(settings: &Settings, revision: &str, environment: &str) -> String {
    configuration_multiple(settings, revision, environment, false)
}

fn configuration_multiple(
    settings: &Settings,
    revision: &str,
    environment: &str,
    multiple: bool,
) -> String {
    plan::configuration(settings, revision, environment, multiple)
}

#[cfg(test)]
mod integration;
#[cfg(test)]
mod tests;
