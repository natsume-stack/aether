//! Resolve operator drafts into explicit per-service public endpoints.
use crate::{configuration, environment};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const SERVICES: [(&str, &str, &str, &str, u16); 5] = [
    (
        "play",
        "Play",
        "playPublicAddressOverride",
        "BOX_PLAY",
        3121,
    ),
    (
        "creator",
        "ARENA",
        "creatorPublicAddressOverride",
        "BOX_CREATOR",
        3127,
    ),
    (
        "voxa",
        "VOXA",
        "voxaPublicAddressOverride",
        "BOX_VOXA",
        3123,
    ),
    (
        "player-service",
        "后台管理",
        "playerServicePublicAddressOverride",
        "BOX_PLAYER_SERVICE",
        3124,
    ),
    (
        "player-auth-portal",
        "登录页面",
        "authPortalPublicAddressOverride",
        "BOX_AUTH_PORTAL",
        3125,
    ),
];
fn string<'a>(config: &'a Map<String, Value>, key: &str) -> &'a str {
    config.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn prefix(value: &str) -> Result<String, String> {
    let value = value.trim().trim_matches('/');
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.len() > 128
        || value.split('/').any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
    {
        return Err("入口路径只能包含字母、数字、下划线、短横线和 /".into());
    }
    if matches!(
        value.split('/').next().unwrap(),
        "api" | "_next" | "runtime" | "p" | "player-admin"
    ) {
        return Err("入口路径不能使用 API、资源或运行时的保留路径".into());
    }
    Ok(format!("/{value}"))
}
fn parts(
    address: &str,
    label: &str,
    port: u16,
    secure: bool,
    shared: bool,
) -> Result<(String, u16, bool, String), String> {
    let address = address.trim();
    if address.contains("://") {
        return crate::configuration_migration::public_url_parts(address, label);
    }
    let authority = address.split('/').next().unwrap_or("");
    let raw_ipv6 = authority.parse::<std::net::Ipv6Addr>().is_ok();
    let explicit_port = !raw_ipv6
        && authority.rsplit_once(':').is_some_and(|(_, port)| {
            !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit())
        });
    let source = if raw_ipv6 {
        format!("[{authority}]{}", &address[authority.len()..])
    } else {
        address.into()
    };
    let (host, mut endpoint_port, secure, path) = crate::configuration_migration::public_url_parts(
        &format!("{}://{source}", if secure { "https" } else { "http" }),
        label,
    )?;
    if !shared && host.parse::<std::net::IpAddr>().is_ok() && !explicit_port {
        endpoint_port = port;
    }
    Ok((host, endpoint_port, secure, path))
}
pub fn certificate_flags(root: &std::path::Path) -> BTreeMap<String, bool> {
    let saved: Value = std::fs::read_to_string(root.join("https/settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let legacy = saved["expiresAt"]
        .as_str()
        .is_some_and(|value| !value.is_empty())
        && saved["certificateSources"]
            .as_object()
            .is_none_or(|map| map.is_empty());
    let mut flags = BTreeMap::new();
    for (service, ..) in SERVICES {
        let configured = saved["certificateExpiries"][service]
            .as_str()
            .is_some_and(|value| !value.is_empty())
            || (legacy
                && saved["settings"]["routes"]
                    .as_array()
                    .is_some_and(|routes| routes.iter().any(|route| route["service"] == service)));
        flags.insert(service.into(), configured);
    }
    let shared = legacy
        || saved["certificateSources"]
            .as_object()
            .is_some_and(|sources| {
                sources.iter().any(|(service, source)| {
                    source == "shared" && flags.get(service).copied().unwrap_or(false)
                })
            });
    flags.insert("shared".into(), shared);
    flags
}
/// Prepare the adapter's existing fields without losing inactive independent drafts.
pub fn prepare(config: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    if config.get("externalNginxManual").and_then(Value::as_bool) == Some(true)
        || !config.contains_key("publicAddressMode")
    {
        return Ok(config.clone());
    }
    let mode = string(config, "publicAddressMode");
    if !matches!(mode, "shared" | "independent") {
        return Err("公网地址模式无效".into());
    }
    let shared = mode == "shared";
    let has_ssl = |service: &str| {
        config
            .get("publicSslConfigured")
            .and_then(|value| value.get(service))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let base = string(config, "sharedPublicAddress");
    if shared && base.is_empty() && string(config, "playNetworkMode") == "public" {
        return Err("公网（共用地址）请填写 IP 或域名".into());
    }
    let active_public = ["playNetworkMode", "creatorNetworkMode"].iter().any(|key| {
        config
            .get(*key)
            .and_then(Value::as_str)
            .is_none_or(|mode| mode == "public")
    });
    let base = if shared && active_public && !base.is_empty() {
        let p = parts(base, "共用公网地址", 80, has_ssl("shared"), true)?;
        if !matches!(p.3.as_str(), "" | "/") {
            return Err("共用地址只填写 IP 或域名，路径在各服务中设置".into());
        }
        Some(p)
    } else {
        None
    };
    let mut output = config.clone();
    let mut drafts = Map::new();
    let mut first = None;
    for (service, label, field, _, fallback) in SERVICES {
        let draft = config
            .get("independentPublicAddresses")
            .and_then(|value| value.get(service))
            .and_then(Value::as_str)
            .unwrap_or_else(|| string(config, field));
        drafts.insert(service.into(), Value::String(draft.into()));
        let port_key = match service {
            "play" => "playPort",
            "creator" => "creatorPort",
            "voxa" => "voxaPort",
            "player-service" => "playerServicePort",
            _ => "authPortalPort",
        };
        let port = config
            .get(port_key)
            .map(|v| {
                v.as_u64()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| v.as_str().unwrap_or("").into())
            })
            .map(|s| configuration::validate_port(&s))
            .transpose()?
            .unwrap_or(fallback);
        let selected = if config.contains_key(field) {
            string(config, field)
        } else {
            draft
        };
        let network_mode = string(
            config,
            if matches!(service, "creator" | "voxa") {
                "creatorNetworkMode"
            } else {
                "playNetworkMode"
            },
        );
        let address = if !network_mode.is_empty() && network_mode != "public" {
            None
        } else if shared {
            base.clone()
        } else if selected.trim().is_empty() {
            None
        } else {
            Some(parts(
                selected,
                &format!("{label} 公网地址"),
                port,
                has_ssl(service),
                false,
            )?)
        };
        let effective = if let Some((host, mut public_port, secure, path)) = address {
            let custom = if shared {
                config
                    .get("publicServicePaths")
                    .and_then(|v| v.get(service))
                    .and_then(Value::as_str)
                    .unwrap_or("")
            } else {
                ""
            };
            let path = prefix(if custom.trim().is_empty() {
                if shared {
                    ""
                } else {
                    &path
                }
            } else {
                custom
            })?;
            if shared && path.is_empty() {
                public_port = port;
            }
            let endpoint = format!(
                "{}://{}{}{}",
                if secure { "https" } else { "http" },
                configuration::origin_host(&host)?,
                if public_port == if secure { 443 } else { 80 } {
                    String::new()
                } else {
                    format!(":{public_port}")
                },
                path
            );
            if first.is_none() {
                first = Some(format!(
                    "{}://{}",
                    if secure { "https" } else { "http" },
                    configuration::origin_host(&host)?
                ));
            }
            endpoint
        } else {
            String::new()
        };
        output.insert(field.into(), Value::String(effective));
    }
    output.insert("independentPublicAddresses".into(), Value::Object(drafts));
    output.insert(
        "publicAddress".into(),
        Value::String(first.unwrap_or_else(|| "127.0.0.1".into())),
    );
    Ok(output)
}
/// Persist selected-mode metadata and both sets of operator drafts.
pub fn save_document(content: &str, config: &Map<String, Value>) -> Result<String, String> {
    if !config.contains_key("publicAddressMode") {
        return Ok(content.into());
    }
    let prepared = prepare(config)?;
    let shared = string(config, "publicAddressMode") == "shared";
    let mut output = content.to_string();
    environment::set_env(
        &mut output,
        "BOX_PUBLIC_ADDRESS_MODE",
        string(&prepared, "publicAddressMode"),
    )?;
    environment::set_env(
        &mut output,
        "BOX_SHARED_PUBLIC_ADDRESS",
        string(&prepared, "sharedPublicAddress"),
    )?;
    for (service, _, field, key, _) in SERVICES {
        environment::set_env(
            &mut output,
            &format!("{key}_PUBLIC_ADDRESS_OVERRIDE"),
            string(&prepared, field),
        )?;
        let draft = prepared
            .get("independentPublicAddresses")
            .and_then(|v| v.get(service))
            .and_then(Value::as_str)
            .unwrap_or("");
        environment::set_env(
            &mut output,
            &format!("{key}_INDEPENDENT_PUBLIC_ADDRESS"),
            draft,
        )?;
        let path = config
            .get("publicServicePaths")
            .and_then(|v| v.get(service))
            .and_then(Value::as_str)
            .unwrap_or("");
        let active = string(
            config,
            if matches!(service, "creator" | "voxa") {
                "creatorNetworkMode"
            } else {
                "playNetworkMode"
            },
        );
        let path = if shared && (active.is_empty() || active == "public") {
            prefix(path)?
        } else {
            path.to_string()
        };
        environment::set_env(&mut output, &format!("{key}_PUBLIC_PATH"), &path)?;
    }
    Ok(crate::access_settings::independent_owner(&output))
}
pub fn view(values: &BTreeMap<String, String>) -> Value {
    let mode = values
        .get("BOX_PUBLIC_ADDRESS_MODE")
        .map(String::as_str)
        .unwrap_or("independent");
    let mut output = json!({"publicAddressMode":mode,"sharedPublicAddress":values.get("BOX_SHARED_PUBLIC_ADDRESS").cloned().unwrap_or_default(),"publicServicePaths":{}});
    for (service, _, field, key, _) in SERVICES {
        let address = values
            .get(&format!("{key}_INDEPENDENT_PUBLIC_ADDRESS"))
            .or_else(|| values.get(&format!("{key}_PUBLIC_ADDRESS_OVERRIDE")))
            .cloned()
            .unwrap_or_default();
        output[field] = Value::String(address);
        output["publicServicePaths"][service] = Value::String(
            values
                .get(&format!("{key}_PUBLIC_PATH"))
                .cloned()
                .unwrap_or_default(),
        );
    }
    output
}
#[cfg(test)]
mod tests;
