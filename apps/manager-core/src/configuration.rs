//! Shared configuration validation, URL migration and runtime derivation.
//! Hosts supply LAN detection, image/platform settings. No host I/O.

use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv6Addr},
};

pub fn validate_raw_environment(content: &str) -> Result<(), String> {
    if content.len() > 512 * 1024 {
        return Err(".env 内容不能超过 512 KB".into());
    }
    if content.contains('\0') {
        return Err(".env 不能包含空字符".into());
    }
    for (index, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, _)) = line.split_once('=') else {
            return Err(format!(".env 第 {} 行必须使用 KEY=VALUE 格式", index + 1));
        };
        let key = key.trim();
        let valid_key = key.chars().enumerate().all(|(index, character)| {
            character == '_'
                || character.is_ascii_uppercase()
                || (index > 0 && character.is_ascii_digit())
        });
        if key.is_empty() || !valid_key {
            return Err(format!(".env 第 {} 行的变量名无效", index + 1));
        }
    }
    Ok(())
}

/// Returns an unbracketed, canonical IP or ASCII DNS host (including Compose names).
pub fn validate_host(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    let invalid = || format!("{label}无效，请只填写 IP 或域名");
    if let Some(inner) = value.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return inner
            .parse::<Ipv6Addr>()
            .map(|ip| ip.to_string())
            .map_err(|_| invalid());
    }
    if let Ok(ip) = value.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    let dns = value.strip_suffix('.').unwrap_or(value);
    if dns.is_empty()
        || dns.len() > 253
        || !dns.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && part.as_bytes()[part.len() - 1].is_ascii_alphanumeric()
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        || (dns.contains('.') && dns.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
    {
        return Err(invalid());
    }
    Ok(value.to_ascii_lowercase())
}

pub fn validate_creator_host(value: &str) -> Result<String, String> {
    let host = validate_host(value, "创作端访问地址")?;
    if host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified()) {
        return Err("创作端访问地址不能使用监听地址".into());
    }
    Ok(host)
}

pub fn validate_public_host(value: &str) -> Result<String, String> {
    let host = validate_host(value, "公开访问地址")?;
    if host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified()) {
        return Err("公开访问地址不能使用监听地址".into());
    }
    Ok(host)
}

pub fn parse_public_address(value: &str, label: &str) -> Result<(String, &'static str), String> {
    let value = value.trim();
    if value.contains("://") {
        let (host, port, secure, suffix) =
            crate::configuration_migration::public_url_parts(value, label)?;
        let default_port = if secure { 443 } else { 80 };
        if port != default_port || !matches!(suffix.as_str(), "" | "/") {
            return Err(format!(
                "{label}只填写协议和 IP 或域名，端口请在各服务中设置"
            ));
        }
        return Ok((host, if secure { "https" } else { "http" }));
    }

    let host = validate_public_host(value).map_err(|error|format!("{label}：{error}"))?;
    Ok((host, "http"))
}

pub fn validate_public_address_override(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.contains("://") {
        return crate::configuration_migration::normalize_public_url(value, label);
    }
    let host = validate_public_host(value).map_err(|error|format!("{label}：{error}"))?;
    Ok(host)
}

pub fn normalize_public_endpoint_address(
    value: &str,
    label: &str,
    port: u16,
) -> Result<String, String> {
    let address = validate_public_address_override(value, label)?;
    if address.is_empty() || address.contains("://") {
        return Ok(address);
    }
    let host = origin_host(&address)?;
    Ok(format!("http://{host}:{port}"))
}

pub fn validate_network_mode(value: &str) -> Result<&str, String> {
    match value {
        "local" | "lan" | "public" => Ok(value),
        _ => Err("访问范围只能是本机、局域网或公网".into()),
    }
}

pub fn validate_database_mode(value: &str) -> Result<&str, String> {
    match value {
        "managed" | "external" => Ok(value),
        _ => Err("PostgreSQL 模式只能是内置数据库或外部数据库".into()),
    }
}

pub fn validate_redis_mode(value: &str) -> Result<&str, String> {
    match value {
        "disabled" | "managed" | "external" => Ok(value),
        _ => Err("Redis 模式只能是不启用、内置 Redis 或外部 Redis".into()),
    }
}

pub fn validate_port(value: &str) -> Result<u16, String> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(port @ 1..=65535) = value.parse::<u16>() {
            return Ok(port);
        }
    }
    Err("端口必须是 1-65535 之间的整数".into())
}

/// Default only when absent: a present but invalid value is an operator error.
pub fn env_port(
    values: &BTreeMap<String, String>,
    key: &str,
    fallback: u16,
) -> Result<u16, String> {
    validate_port(
        values
            .get(key)
            .map(String::as_str)
            .unwrap_or(&fallback.to_string()),
    )
    .map_err(|error| format!("{key}: {error}"))
}

pub fn origin_host(value: &str) -> Result<String, String> {
    let host = validate_host(value, "访问地址")?;
    Ok(if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    })
}

/// Parse a URI authority; IPv6 must be bracketed, unlike a standalone host field.
fn parse_authority(value: &str, fallback: u16) -> Result<(String, u16), String> {
    if value.chars().any(char::is_whitespace) {
        return Err("URL 地址不能包含空格".into());
    }
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let (ip, suffix) = rest.split_once(']').ok_or("IPv6 URL 缺少右括号")?;
        ip.parse::<Ipv6Addr>().map_err(|_| "IPv6 URL 地址无效")?;
        let port = if suffix.is_empty() {
            fallback
        } else {
            validate_port(suffix.strip_prefix(':').ok_or("IPv6 URL 端口无效")?)?
        };
        (ip, port)
    } else {
        match value.split_once(':') {
            Some((host, port)) => (host, validate_port(port)?),
            None => (value, fallback),
        }
    };
    Ok((validate_host(host, "URL 地址")?, port))
}

pub fn host_from_http_url(value: &str) -> Option<String> {
    let value = value.trim();
    let rest = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))?;
    if rest
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    parse_authority(authority, 80).ok().map(|(host, _)| host)
}

/// Split database fields. `query` is the encoded query without `?`, preserved
/// verbatim (not form-decoded: '+' remains '+'). No Debug to avoid secret leaks.
#[derive(Clone, PartialEq, Eq)]
pub struct DatabaseUrl {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub query: Option<String>,
}

fn valid_percent_encoding(value: &str) -> bool {
    let mut bytes = value.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%'
            && !(bytes.next().is_some_and(|b| b.is_ascii_hexdigit())
                && bytes.next().is_some_and(|b| b.is_ascii_hexdigit()))
        {
            return false;
        }
    }
    true
}

fn decode_component(value: &str) -> Result<String, String> {
    if !valid_percent_encoding(value) {
        return Err("数据库 URL 百分号编码无效".into());
    }
    urlencoding::decode(value)
        .map(|s| s.into_owned())
        .map_err(|_| "数据库 URL 编码不是 UTF-8".into())
}

fn validate_query(query: &str) -> Result<(), String> {
    if !valid_percent_encoding(query)
        || !query
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/?%".contains(&b))
    {
        return Err("数据库 URL 查询参数无效".into());
    }
    Ok(())
}

pub fn parse_database_url(value: &str) -> Result<DatabaseUrl, String> {
    let value = value.trim();
    let rest = value
        .strip_prefix("postgresql://")
        .or_else(|| value.strip_prefix("postgres://"))
        .ok_or("数据库 URL 必须使用 postgresql:// 或 postgres://")?;
    if rest
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\' || c == '#')
    {
        return Err("数据库 URL 包含未编码的非法字符".into());
    }
    let (rest, query) = match rest.split_once('?') {
        Some((rest, query)) => {
            validate_query(query)?;
            (rest, Some(query.to_string()))
        }
        None => (rest, None),
    };
    let (authority, database) = rest.split_once('/').ok_or("数据库 URL 缺少数据库名")?;
    if database.contains('/') {
        return Err("数据库名中的斜杠必须编码".into());
    }
    let (credentials, authority) = authority.split_once('@').ok_or("数据库 URL 缺少账号密码")?;
    let (user, password) = credentials.split_once(':').unwrap_or((credentials,""));
    let (host, port) = parse_authority(authority, 5432)?;
    let result = DatabaseUrl {
        host,
        port,
        database: decode_component(database)?,
        user: decode_component(user)?,
        password: decode_component(password)?,
        query,
    };
    build_database_url(&result)?;
    Ok(result)
}

pub fn build_database_url(fields: &DatabaseUrl) -> Result<String, String> {
    for (label, value) in [
        ("数据库名", &fields.database),
        ("数据库账号", &fields.user),
    ] {
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(format!("{label}不能为空或包含控制字符"));
        }
    }
    if fields.password.chars().any(char::is_control) {return Err("数据库密码不能包含控制字符".into());}
    let host = origin_host(&fields.host)?;
    if fields.port == 0 {
        return Err("数据库端口不能为 0".into());
    }
    let mut url = format!(
        "postgresql://{}:{}@{}:{}/{}",
        urlencoding::encode(&fields.user),
        urlencoding::encode(&fields.password),
        host,
        fields.port,
        urlencoding::encode(&fields.database)
    );
    if let Some(query) = &fields.query {
        validate_query(query)?;
        url.push('?');
        url.push_str(query);
    }
    Ok(url)
}

/// Structured owner fields are authoritative; adapters explicitly migrate old URLs.
/// Optional BOX_DATABASE_QUERY retains the legacy encoded query during migration.
pub fn database_url(values: &BTreeMap<String, String>) -> Result<String, String> {
    let get = |key| values.get(key).map(String::as_str).unwrap_or("");
    let mode = validate_database_mode(
        values
            .get("BOX_DATABASE_MODE")
            .map(String::as_str)
            .unwrap_or("external"),
    )?;
    let host = if mode == "managed" {
        "managed-postgres"
    } else {
        get("BOX_DATABASE_HOST").trim()
    };
    if host.is_empty() {
        if let Some(url) = values
            .get("BOX_DATABASE_URL")
            .filter(|url| !url.trim().is_empty())
        {
            return build_database_url(&parse_database_url(url)?);
        }
        return Err("外部 PostgreSQL 模式必须配置数据库地址后才能启动服务".into());
    }
    build_database_url(&DatabaseUrl {
        host: host.into(),
        port: env_port(values, "BOX_DATABASE_PORT", 5432)?,
        database: get("BOX_DATABASE_NAME").trim().into(),
        user: get("BOX_DATABASE_USER").trim().into(),
        password: get("BOX_DATABASE_PASSWORD").into(),
        query: values.get("BOX_DATABASE_QUERY").cloned(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkHosts {
    pub play_host: String,
    pub creator_host: String,
    pub play_bind_ip: &'static str,
    pub creator_bind_ip: &'static str,
}

pub fn resolve_network(
    values: &BTreeMap<String, String>,
    lan_ip: Option<&str>,
) -> Result<NetworkHosts, String> {
    let get = |key, default| values.get(key).map(String::as_str).unwrap_or(default);
    let play_mode = validate_network_mode(get("BOX_PLAY_NETWORK_MODE", "local"))?;
    let creator_mode = validate_network_mode(get("BOX_CREATOR_NETWORK_MODE", "local"))?;
    let lan = || -> Result<String, String> {
        let ip = lan_ip
            .ok_or("已选择局域网模式，但当前未检测到可用的局域网 IP")?
            .trim()
            .parse::<IpAddr>()
            .map_err(|_| "局域网地址必须是 IP")?;
        if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
            return Err("局域网地址不能是回环、监听或多播地址".into());
        }
        Ok(ip.to_string())
    };
    let service_host = |address_key: &str, legacy: &str| -> Result<String, String> {
        if let Some(address) = values.get(address_key) {
            let address = validate_public_address_override(address, "服务公网地址")?;
            if address.is_empty() { return Ok("127.0.0.1".into()); }
            if address.contains("://") { return crate::configuration_migration::public_url_parts(&address, "服务公网地址").map(|parts| parts.0); }
            return Ok(address);
        }
        Ok(values.get(legacy).cloned().unwrap_or_else(|| "127.0.0.1".into()))
    };
    let play_host = match play_mode {
        "local" => "127.0.0.1".into(),
        "lan" => lan()?,
        _ => validate_public_host(&service_host("BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE", "BOX_PLAY_PUBLIC_HOST")?)?,
    };
    let creator_host = match creator_mode {
        "local" => "127.0.0.1".into(),
        "lan" => lan()?,
        _ => validate_creator_host(&service_host("BOX_CREATOR_PUBLIC_ADDRESS_OVERRIDE", "BOX_CREATOR_HOST")?)?,
    };
    let loopback = play_host.trim_end_matches('.') == "localhost"
        || play_host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    Ok(NetworkHosts {
        play_host,
        creator_host,
        play_bind_ip: if loopback { "127.0.0.1" } else { "0.0.0.0" },
        creator_bind_ip: if creator_mode == "local" {
            "127.0.0.1"
        } else {
            "0.0.0.0"
        },
    })
}

/// Platform-specific values are supplied by the adapter; paths are opaque strings.
pub struct RuntimeInputs<'a> {
    pub lan_ip: Option<&'a str>,
    pub image_tag: &'a str,
    pub platform: &'a str,
    /// Keep setup/status/stop available before the database step is complete.
    pub database_required: bool,
    pub web_manager: bool,
}

/// Produces only derived assignments. Does not mutate or serialize owner values.
/// An incomplete database is an error; setup screens should skip this until ready.
pub fn runtime_environment(
    values: &BTreeMap<String, String>,
    input: &RuntimeInputs<'_>,
) -> Result<BTreeMap<String, String>, String> {
    let migrated = crate::configuration_migration::migrate(values)?;
    let values = &migrated;
    let network = resolve_network(values, input.lan_ip)?;
    let public_scheme = if values
        .get("BOX_PLAY_NETWORK_MODE")
        .map(String::as_str)
        .unwrap_or("local")
        == "public"
    {
        if let Some(address) = values.get("BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE") {
            if address.to_ascii_lowercase().starts_with("https://") { "https" } else { "http" }
        } else { values
            .get("BOX_PUBLIC_SCHEME")
            .map(String::as_str)
            .unwrap_or("http") }
    } else {
        "http"
    };
    if !matches!(public_scheme, "http" | "https") {
        return Err("公网地址协议只能是 HTTP 或 HTTPS".into());
    }
    let db = match database_url(values) {
        Ok(url) => url,
        Err(error) if input.database_required => return Err(error),
        Err(_) => String::new(),
    };
    let redis_mode = validate_redis_mode(
        values
            .get("BOX_REDIS_MODE")
            .map(String::as_str)
            .unwrap_or("disabled"),
    )?;
    let mut result = BTreeMap::new();
    let mut profiles = Vec::new();
    if values
        .get("BOX_DATABASE_MODE")
        .is_some_and(|mode| mode == "managed")
    {
        profiles.push("desktop-postgres");
    }
    if redis_mode == "managed" {
        profiles.push("desktop-redis");
    }
    profiles.extend(["player-service", "auth-portal", "creator", "play", "voxa"]);
    if input.web_manager {
        profiles.push("server-manager");
    }
    for (key, value) in [
        ("COMPOSE_PROFILES", profiles.join(",")),
        ("BOX_IMAGE_TAG", input.image_tag.into()),
        (
            "BOX_AUTH_PORTAL_IMAGE",
            crate::auth_portal::image(values, input.image_tag)?,
        ),
        ("BOX_PLAY_PLATFORM", input.platform.into()),
        ("BOX_BIND_IP", network.play_bind_ip.into()),
        ("BOX_PUBLIC_SCHEME", public_scheme.into()),
        ("BOX_PLAY_PUBLIC_HOST", network.play_host.clone()),
        ("BOX_CREATOR_HOST", network.creator_host.clone()),
        ("BOX_CREATOR_BIND_IP", network.creator_bind_ip.into()),
        ("BOX_VOXA_BIND_IP", network.creator_bind_ip.into()),
        ("BOX_DATABASE_URL", db),
        ("BOX_CREATOR_ALLOWED_HOSTS", network.creator_host.clone()),
        (
            "BOX_PLAYER_SERVICE_INTERNAL_URL",
            "http://player-service:3213".into(),
        ),
    ] {
        result.insert(key.to_string(), value);
    }
    let play = origin_host(&network.play_host)?;
    let creator = origin_host(&network.creator_host)?;
    let mut ports = Vec::new();
    for (name, fallback, host) in [
        ("PLAY", 3121, &play),
        ("VOXA", 3123, &creator),
        ("CREATOR", 3127, &creator),
        ("PLAYER_SERVICE", 3124, &play),
        ("AUTH_PORTAL", 3125, &play),
    ] {
        let key = format!("BOX_{name}_PORT");
        let port = env_port(values, &key, fallback)?;
        if ports.contains(&port) {
            return Err(format!("服务不能使用同一个端口 {port}"));
        }
        ports.push(port);
        result.insert(key, port.to_string());
        let mode_key = if matches!(name, "CREATOR" | "VOXA") {
            "BOX_CREATOR_NETWORK_MODE"
        } else {
            "BOX_PLAY_NETWORK_MODE"
        };
        let scheme = if values.get(mode_key).map(String::as_str) == Some("public") {
            public_scheme
        } else {
            "http"
        };
        result.insert(format!("BOX_{name}_PUBLIC_URL"), format!("{scheme}://{host}:{port}"));
    }
    let origins = format!(
        "{},{}",
        result["BOX_VOXA_PUBLIC_URL"], result["BOX_CREATOR_PUBLIC_URL"]
    );
    result.insert("BOX_VOXA_ALLOWED_ORIGINS".into(), origins.clone());
    result.insert("BOX_RESOURCE_ALLOWED_ORIGINS".into(), origins);
    result.insert(
        "BOX_PLAYER_LOGIN_URL".into(),
        result["BOX_AUTH_PORTAL_PUBLIC_URL"].clone(),
    );
    result.insert(
        "BOX_PLAYER_AUTH_ALLOWED_ORIGINS".into(),
        format!(
            "{},{},{}",
            result["BOX_PLAY_PUBLIC_URL"],
            result["BOX_CREATOR_PUBLIC_URL"],
            result["BOX_AUTH_PORTAL_PUBLIC_URL"]
        ),
    );
    if result.values().any(|v| v.chars().any(char::is_control)) {
        return Err("运行时配置不能包含控制字符".into());
    }
    let mut url_override_values = values.clone();
    for (address_key, legacy_host_key, url_key, port_key, port_default, mode_key) in [
        (
            "BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_PLAY_PUBLIC_HOST_OVERRIDE",
            "BOX_PLAY_PUBLIC_URL",
            "BOX_PLAY_PORT",
            3121,
            "BOX_PLAY_NETWORK_MODE",
        ),
        (
            "BOX_PLAYER_SERVICE_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_PLAYER_SERVICE_PUBLIC_HOST_OVERRIDE",
            "BOX_PLAYER_SERVICE_PUBLIC_URL",
            "BOX_PLAYER_SERVICE_PORT",
            3124,
            "BOX_PLAY_NETWORK_MODE",
        ),
        (
            "BOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_AUTH_PORTAL_PUBLIC_HOST_OVERRIDE",
            "BOX_AUTH_PORTAL_PUBLIC_URL",
            "BOX_AUTH_PORTAL_PORT",
            3125,
            "BOX_PLAY_NETWORK_MODE",
        ),
        (
            "BOX_CREATOR_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_CREATOR_PUBLIC_HOST_OVERRIDE",
            "BOX_CREATOR_PUBLIC_URL",
            "BOX_CREATOR_PORT",
            3127,
            "BOX_CREATOR_NETWORK_MODE",
        ),
        (
            "BOX_VOXA_PUBLIC_ADDRESS_OVERRIDE",
            "BOX_VOXA_PUBLIC_HOST_OVERRIDE",
            "BOX_VOXA_PUBLIC_URL",
            "BOX_VOXA_PORT",
            3123,
            "BOX_CREATOR_NETWORK_MODE",
        ),
    ] {
        if values.get(mode_key).map(String::as_str).unwrap_or("local") != "public" {
            url_override_values.remove(&format!("{url_key}_OVERRIDE"));
            if url_key == "BOX_AUTH_PORTAL_PUBLIC_URL" {
                url_override_values.remove("BOX_PLAYER_LOGIN_URL_OVERRIDE");
            }
            continue;
        }
        let legacy_address = values.get(legacy_host_key).map(|host| {
            if host.parse::<IpAddr>().is_ok() {
                host.clone()
            } else {
                format!("https://{host}")
            }
        });
        if values.get(address_key).is_some_and(|address| address.trim().is_empty()) {
            let port = env_port(values, port_key, port_default)?;
            let url = format!("http://127.0.0.1:{port}");
            url_override_values.insert(format!("{url_key}_OVERRIDE"), url.clone());
            if url_key == "BOX_AUTH_PORTAL_PUBLIC_URL" {
                url_override_values.insert("BOX_PLAYER_LOGIN_URL_OVERRIDE".into(), url);
            }
            continue;
        }
        let Some(address) = values
            .get(address_key)
            .or(legacy_address.as_ref())
            .map(String::as_str)
            .filter(|address| !address.trim().is_empty())
        else {
            continue;
        };
        let port = env_port(values, port_key, port_default)?;
        let url = normalize_public_endpoint_address(address, address_key, port)?;
        url_override_values.insert(format!("{url_key}_OVERRIDE"), url.clone());
        if url_key == "BOX_AUTH_PORTAL_PUBLIC_URL" {
            url_override_values.insert("BOX_PLAYER_LOGIN_URL_OVERRIDE".into(), url);
        }
    }
    crate::configuration_migration::apply_url_overrides(&url_override_values, &mut result)?;
    Ok(result)
}

fn config_number(config: &Map<String, Value>, key: &str) -> Option<f64> {
    match config.get(key)? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// Validate supplied camelCase form fields after merging adapter defaults or prior state.
pub fn independent_public_base(config: &Map<String, Value>) -> Result<Option<String>, String> {
    let fields = [("playPublicAddressOverride", "Play 公网地址"), ("creatorPublicAddressOverride", "ARENA 公网地址"), ("voxaPublicAddressOverride", "VOXA 公网地址"), ("playerServicePublicAddressOverride", "后台管理公网地址"), ("authPortalPublicAddressOverride", "登录页面公网地址")];
    if !fields.iter().any(|(key, _)| config.contains_key(*key)) { return Ok(None); }
    let mut primary = None;
    for (key, label) in fields {
        let Some(value) = config.get(key) else { continue; };
        let address = validate_public_address_override(value.as_str().ok_or_else(|| format!("{label}必须是字符串"))?, label)?;
        if address.is_empty() { continue; }
        if primary.is_none() {
            let base = if address.contains("://") {
                let (host, _, secure, _) = crate::configuration_migration::public_url_parts(&address, label)?;
                format!("{}://{}", if secure { "https" } else { "http" }, origin_host(&host)?)
            } else { address };
            primary = Some(base);
        }
    }
    Ok(Some(primary.unwrap_or_else(|| "127.0.0.1".into())))
}

pub fn validate_configuration(config: &Map<String, Value>) -> Result<(), String> {
    let independent = independent_public_base(config)?.is_some();
    for key in ["redisDb", "storageCacheRedisDb", "storageCacheRedisTtl"] {
        if let Some(value) = config.get(key) {
            if !value.as_u64().is_some_and(|value| value <= 255) {
                return Err(format!("{key} 必须是 0 到 255 之间的整数"));
            }
        }
    }
    for key in [
        "autoBackupEnabled",
        "databaseSsl",
        "registrationEnabled",
        "libraryManagementEnabled",
    ] {
        if config.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(format!("{key} 必须是布尔值"));
        }
    }
    // Validate present values before range checks; malformed strings and null must
    // never be silently treated as omitted. Integer fields match desktop u32/u16.
    for key in [
        "playPort",
        "voxaPort",
        "creatorPort",
        "playerServicePort",
        "authPortalPort",
        "autoBackupIntervalMinutes",
        "autoBackupRetentionCount",
        "autoBackupRetentionDays",
        "playerLimit",
        "creatorEditPrewarmRuntimes",
        "creatorEditRuntimes",
        "playPrewarmRuntimes",
        "playRuntimes",
        "creatorPlayRuntimes",
        "scriptMemoryMb",
        "runtimeIdleMinutes",
        "runtimeStartTimeoutMinutes",
        "teleportMaxRooms",
        "teleportRoomIdleMinutes",
        "databasePoolSize",
        "playerServiceMemoryMb",
        "authPortalMemoryMb",
        "creatorMemoryMb",
        "playMemoryMb",
        "playerServiceCpuLimit",
        "authPortalCpuLimit",
        "creatorCpuLimit",
        "playCpuLimit",
    ] {
        if config.contains_key(key) {
            let value = config_number(config, key).ok_or_else(|| format!("{key} 必须是数字"))?;
            if !value.is_finite()
                || (!key.ends_with("CpuLimit")
                    && (value.fract() != 0.0 || !(0.0..=u32::MAX as f64).contains(&value)))
            {
                return Err(format!(
                    "{key} 必须是有效范围内的{}",
                    if key.ends_with("CpuLimit") {
                        "数字"
                    } else {
                        "非负整数"
                    }
                ));
            }
        }
    }
    for key in [
        "databaseMode",
        "redisMode",
        "playNetworkMode",
        "creatorNetworkMode",
        "publicHost",
        "publicAddress",
        "authPortalImage",
        "creatorHost",
        "playPublicAddressOverride",
        "creatorPublicAddressOverride",
        "voxaPublicAddressOverride",
        "playerServicePublicAddressOverride",
        "authPortalPublicAddressOverride",
        "databaseHost",
        "redisHost",
        "databasePort",
        "redisPort",
    ] {
        if let Some(value) = config.get(key) {
            let value = value
                .as_str()
                .ok_or_else(|| format!("{key} 必须是字符串"))?;
            match key {
                "databaseMode" => {
                    validate_database_mode(value)?;
                }
                "redisMode" => {
                    validate_redis_mode(value)?;
                }
                "playNetworkMode" | "creatorNetworkMode" => {
                    validate_network_mode(value)?;
                }
                "publicHost" => {
                    validate_public_host(value)?;
                }
                "publicAddress" => {
                    if !independent && (!value.trim().is_empty() || config.get("playNetworkMode").and_then(Value::as_str) == Some("public")) {
                        parse_public_address(value, "公网地址")?;
                    }
                }
                "authPortalImage" => {
                    crate::auth_portal::validate_image(value)?;
                }
                "creatorHost" => {
                    validate_creator_host(value)?;
                }
                "playPublicAddressOverride"
                | "playerServicePublicAddressOverride"
                | "authPortalPublicAddressOverride"
                | "creatorPublicAddressOverride"
                | "voxaPublicAddressOverride" => {
                    validate_public_address_override(value, key)?;
                }
                "databasePort" => {
                    let required =
                        config.get("databaseMode").and_then(Value::as_str) == Some("external");
                    if required || (!config.contains_key("databaseMode") && !value.trim().is_empty()) {
                        validate_port(value)
                            .map_err(|_| "PostgreSQL 端口必须是 1-65535 之间的整数".to_string())?;
                    }
                }
                "redisPort" => {
                    let required =
                        config.get("redisMode").and_then(Value::as_str) == Some("external");
                    if required || (!config.contains_key("redisMode") && !value.trim().is_empty()) {
                        validate_port(value)
                            .map_err(|_| "Redis 端口必须是 1-65535 之间的整数".to_string())?;
                    }
                }
                "databaseHost" if config.get("databaseMode").and_then(Value::as_str)==Some("managed") => {},
                "redisHost" if config.get("redisMode").and_then(Value::as_str).is_some_and(|mode| mode!="external") => {},
                _ if !value.trim().is_empty() => {
                    validate_host(value, key)?;
                }
                _ => {} // Empty inactive service hosts are allowed by both forms.
            }
        }
    }

    let ports = [
        ("Play", "playPort"),
        ("VOXA", "voxaPort"),
        ("Creator", "creatorPort"),
        ("账号服务", "playerServicePort"),
        ("登录页面", "authPortalPort"),
    ];
    let mut seen: Vec<(&str, u64)> = Vec::new();
    for (label, key) in ports {
        let Some(value) = config_number(config, key) else {
            continue;
        };
        if !(1.0..=65535.0).contains(&value) || value.fract() != 0.0 {
            return Err(format!("{label} 端口必须在 1 到 65535 之间"));
        }
        let value = value as u64;
        if let Some((other, _)) = seen.iter().find(|(_, port)| *port == value) {
            return Err(format!("{label} 与 {other} 不能使用同一个端口 {value}"));
        }
        seen.push((label, value));
    }
    if let Some(value) = config_number(config, "autoBackupIntervalMinutes") {
        if !(1.0..=10_080.0).contains(&value) {
            return Err("自动备份间隔必须在 1 到 10080 分钟之间".into());
        }
    }
    if let Some(value) = config_number(config, "autoBackupRetentionCount") {
        if !(1.0..=1_000.0).contains(&value) {
            return Err("每地图备份保留份数必须在 1 到 1000 之间".into());
        }
    }
    if let Some(value) = config_number(config, "autoBackupRetentionDays") {
        if !(1.0..=3_650.0).contains(&value) {
            return Err("自动备份最长保留天数必须在 1 到 3650 天之间".into());
        }
    }
    if let Some(value) = config_number(config, "playerLimit") {
        if !(1.0..=1_000.0).contains(&value) {
            return Err("单实例玩家上限必须在 1 到 1000 之间".into());
        }
    }
    for (label, prewarm_key, maximum_key) in [
        (
            "Creator 编辑预热数量",
            "creatorEditPrewarmRuntimes",
            "creatorEditRuntimes",
        ),
        ("Play 预热数量", "playPrewarmRuntimes", "playRuntimes"),
    ] {
        let (Some(prewarm), Some(maximum)) = (
            config_number(config, prewarm_key),
            config_number(config, maximum_key),
        ) else {
            continue;
        };
        if prewarm > maximum {
            return Err(format!(
                "{label}不能超过对应的运行时上限 {}",
                maximum as u64
            ));
        }
    }
    if let Some(value) = config_number(config, "scriptMemoryMb") {
        if !(128.0..=8_192.0).contains(&value) {
            return Err("单运行时脚本内存必须在 128 到 8192 MiB 之间".into());
        }
    }
    for (label, key, minimum, maximum) in [
        ("运行时空闲回收时间", "runtimeIdleMinutes", 1.0, 10_080.0),
        ("运行时启动超时", "runtimeStartTimeoutMinutes", 1.0, 1_440.0),
        ("Teleport 私有房间上限", "teleportMaxRooms", 1.0, 1_024.0),
        (
            "Teleport 房间空闲回收时间",
            "teleportRoomIdleMinutes",
            1.0,
            10_080.0,
        ),
        ("数据库连接池", "databasePoolSize", 1.0, 100.0),
        ("账号服务内存", "playerServiceMemoryMb", 128.0, 262_144.0),
        ("登录页面内存", "authPortalMemoryMb", 64.0, 262_144.0),
        ("Creator 内存", "creatorMemoryMb", 512.0, 262_144.0),
        ("Play 内存", "playMemoryMb", 512.0, 262_144.0),
    ] {
        let Some(value) = config_number(config, key) else {
            continue;
        };
        if !(minimum..=maximum).contains(&value) {
            return Err(format!(
                "{label}必须在 {} 到 {} 之间",
                minimum as u64, maximum as u64
            ));
        }
    }
    for (label, key) in [
        ("Play 运行时数量", "playRuntimes"),
        ("Creator 编辑运行时数量", "creatorEditRuntimes"),
        ("Creator 游玩运行时数量", "creatorPlayRuntimes"),
    ] {
        if config_number(config, key).is_some_and(|value| value < 1.0) {
            return Err(format!("{label}必须大于 0"));
        }
    }
    for (label, key) in [
        ("账号服务 CPU", "playerServiceCpuLimit"),
        ("登录页面 CPU", "authPortalCpuLimit"),
        ("Creator CPU", "creatorCpuLimit"),
        ("Play CPU", "playCpuLimit"),
    ] {
        let Some(value) = config_number(config, key) else {
            continue;
        };
        if !value.is_finite() || !(0.1..=256.0).contains(&value) {
            return Err(format!("{label}限制必须在 0.1 到 256 核之间"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn owner() -> BTreeMap<String, String> {
        [
            ("BOX_DATABASE_MODE", "managed"),
            ("BOX_DATABASE_NAME", "box"),
            ("BOX_DATABASE_USER", "box"),
            ("BOX_DATABASE_PASSWORD", " p@ss $word "),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect()
    }

    #[test]
    fn raw_env_preserves_values_and_checks_syntax_and_size() {
        assert!(validate_raw_environment("# note\r\n A_1=x=y # $HOME ; `cmd`\r\nA_1=\n").is_ok());
        for value in ["A", "=x", "1A=x", "a=x", "A-B=x", "A=x\0", "export A=x"] {
            assert!(validate_raw_environment(value).is_err(), "{value:?}");
        }
        assert!(validate_raw_environment(&format!("A={}", "x".repeat(512 * 1024 - 2))).is_ok());
        assert!(validate_raw_environment(&format!("A={}", "x".repeat(512 * 1024 - 1))).is_err());
        assert!(validate_raw_environment("# comment\ninvalid")
            .unwrap_err()
            .contains("2"));
    }

    #[test]
    fn hosts_are_normalized_and_not_uri_or_command_fragments() {
        for (input, expected) in [
            (" EXAMPLE.com ", "example.com"),
            ("managed-postgres", "managed-postgres"),
            ("[2001:0db8::1]", "2001:db8::1"),
            ("::1", "::1"),
            ("127.0.0.1", "127.0.0.1"),
            ("http-server", "http-server"),
        ] {
            assert_eq!(validate_host(input, "host").unwrap(), expected);
        }
        for host in [
            "",
            "a:5432",
            "[::1]:80",
            "a/",
            "http://a",
            "a@b",
            "a b",
            "a\tb",
            "a\nb",
            "a\\b",
            "a?x",
            "a#x",
            "a;id",
            "$(id)",
            "`id`",
            "a'",
            "a\"",
            "a\0b",
            "a_b",
            "-a",
            "a-",
            "a..b",
            "[not-ip]",
            "fe80::1%en0",
            "999.2.3.4",
        ] {
            assert!(validate_host(host, "host").is_err(), "{host:?}");
        }
        for host in ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"] {
            assert!(validate_creator_host(host).is_err());
        }
        assert_eq!(origin_host("[::1]").unwrap(), "[::1]");
    }

    #[test]
    fn ports_have_one_strict_policy() {
        assert_eq!(validate_port(" 65535 ").unwrap(), 65535);
        assert_eq!(validate_port("1").unwrap(), 1);
        for port in ["0", "65536", "-1", "+1", "1.0", "1e3", "", "1 2", "80;id"] {
            assert!(validate_port(port).is_err(), "{port}");
        }
        assert_eq!(env_port(&BTreeMap::new(), "PORT", 80).unwrap(), 80);
        assert!(env_port(&BTreeMap::from([("PORT".into(), "bad".into())]), "PORT", 80).is_err());
    }

    #[test]
    fn http_url_ipv6_and_authority_validation() {
        assert_eq!(
            host_from_http_url("https://[fd00::10]:3002/path"),
            Some("fd00::10".into())
        );
        assert_eq!(
            host_from_http_url("http://example.com?x=1"),
            Some("example.com".into())
        );
        for url in [
            "ftp://example.com",
            "http://u@host",
            "http://[::1]evil",
            "http://[::1]:0",
            "http://a:65536",
            "http://a:bad",
            "http://::1/",
            "http://a\nb/",
        ] {
            assert!(host_from_http_url(url).is_none(), "{url}");
        }
    }

    #[test]
    fn database_round_trip_preserves_secrets_and_ssl_query() {
        let fields = DatabaseUrl {
            host: "[2001:db8::7]".into(),
            port: 5444,
            database: " db /?#中文 ".into(),
            user: "user @".into(),
            password: " p@ss:/?#%+$'` ".into(),
            query: Some("sslmode=verify-full&application_name=box%20manager".into()),
        };
        let url = build_database_url(&fields).unwrap();
        assert!(url.contains("@[2001:db8::7]:5444/"));
        assert!(!url.contains(' '));
        let parsed = parse_database_url(&url).unwrap();
        assert_eq!(parsed.host, "2001:db8::7");
        assert_eq!(parsed.password, fields.password);
        assert_eq!(parsed.database, fields.database);
        assert_eq!(parsed.user, fields.user);
        assert_eq!(parsed.query, fields.query);
        assert_eq!(build_database_url(&parsed).unwrap(), url);
        assert_eq!(
            parse_database_url("postgres://u:p@db/name").unwrap().port,
            5432
        );
        assert_eq!(
            parse_database_url("postgres://u:a+b@db/name")
                .unwrap()
                .password,
            "a+b"
        );
    }

    #[test]
    fn database_rejects_invalid_encoded_and_unencoded_inputs() {
        for url in [
            "mysql://u:p@db:1/n",
            "postgres://u:p@db:0/n",
            "postgres://u:p@db:65536/n",
            "postgres://u:p@db:bad/n",
            "postgres://u:p@[::1]evil/n",
            "postgres://u:p@::1/n",
            "postgres://u:p@db/n#fragment",
            "postgres://u:p@db/n/m",
            "postgres://u:p@db/%xx",
            "postgres://u:p@db/%FF",
            "postgres://u:%00@db/n",
            "postgres://u:%0a@db/n",
            "postgres://u:p@db/n?x=%zz",
            "postgres://u:p@db/n?x=\ny",
            "postgres://u:p@db/",
            "postgres://u:p@a;b/n",
        ] {
            assert!(parse_database_url(url).is_err(), "{url}");
        }
        let mut values = owner();
        assert!(database_url(&values)
            .unwrap()
            .contains("@managed-postgres:5432/box"));
        values.insert("BOX_DATABASE_PORT".into(), "0".into());
        assert!(database_url(&values).is_err());
        values.remove("BOX_DATABASE_PORT");
        values.insert("BOX_DATABASE_MODE".into(), "typo".into());
        assert!(database_url(&values).is_err());
        values.insert("BOX_DATABASE_MODE".into(), "external".into());
        values.insert("BOX_DATABASE_URL".into(), "postgres://u:p@old/n".into());
        assert_eq!(
            database_url(&values).unwrap(),
            "postgresql://u:p@old:5432/n"
        );
        values.insert("BOX_DATABASE_URL".into(), "postgres://u:p@old:0/n".into());
        assert!(database_url(&values).is_err());
    }

    #[test]
    fn mode_resolution_uses_only_injected_lan_address() {
        for mode in ["local", "lan", "public"] {
            assert!(validate_network_mode(mode).is_ok());
        }
        for mode in ["", "LOCAL", " lan", "disabled", "lan;id"] {
            assert!(validate_network_mode(mode).is_err());
        }
        assert!(validate_database_mode("disabled").is_err());
        assert!(validate_redis_mode("disabled").is_ok());
        let mut values = owner();
        values.insert("BOX_CREATOR_HOST".into(), "public.example".into());
        assert_eq!(
            resolve_network(&values, None).unwrap().creator_host,
            "127.0.0.1"
        );
        values.insert("BOX_CREATOR_NETWORK_MODE".into(), "public".into());
        assert_eq!(
            resolve_network(&values, None).unwrap().creator_host,
            "public.example"
        );
        values.insert("BOX_PLAY_NETWORK_MODE".into(), "lan".into());
        assert!(resolve_network(&values, None).is_err());
        for ip in ["localhost", "127.0.0.1", "::", "224.0.0.1"] {
            assert!(resolve_network(&values, Some(ip)).is_err());
        }
        assert_eq!(
            resolve_network(&values, Some("fd00::1")).unwrap().play_host,
            "fd00::1"
        );
        values.insert("BOX_PLAY_NETWORK_MODE".into(), "typo".into());
        assert!(resolve_network(&values, Some("fd00::1")).is_err());
    }

    #[test]
    fn local_mode_does_not_use_the_previous_public_domain_for_play_or_creator() {
        let values = BTreeMap::from([
            ("BOX_PLAY_NETWORK_MODE".into(), "local".into()),
            ("BOX_CREATOR_NETWORK_MODE".into(), "local".into()),
            ("BOX_PLAY_PUBLIC_HOST".into(), "user.box3lab.com".into()),
            ("BOX_CREATOR_HOST".into(), "user.box3lab.com".into()),
        ]);
        let network = resolve_network(&values, Some("192.168.1.20")).unwrap();
        assert_eq!(network.play_host, "127.0.0.1");
        assert_eq!(network.creator_host, "127.0.0.1");
        assert_eq!(network.play_bind_ip, "127.0.0.1");
    }

    #[test]
    fn runtime_derivation_is_pure_and_consistent() {
        let mut values = owner();
        values.insert("BOX_CREATOR_NETWORK_MODE".into(), "lan".into());
        values.insert("BOX_REDIS_MODE".into(), "managed".into());
        let before = values.clone();
        let input = RuntimeInputs {
            lan_ip: Some("fd00::10"),
            image_tag: "test",
            platform: "linux/arm64",
            database_required: true,
            web_manager: false,
        };
        let runtime = runtime_environment(&values, &input).unwrap();
        assert_eq!(values, before);
        assert_eq!(runtime["BOX_CREATOR_PUBLIC_URL"], "http://[fd00::10]:3127");
        assert_eq!(runtime["BOX_PLAY_PUBLIC_URL"], "http://127.0.0.1:3121");
        assert_eq!(runtime["BOX_CREATOR_ALLOWED_HOSTS"], "fd00::10");
        assert_eq!(
            runtime["BOX_PLAYER_LOGIN_URL"],
            runtime["BOX_AUTH_PORTAL_PUBLIC_URL"]
        );
        assert!(runtime["COMPOSE_PROFILES"].starts_with("desktop-postgres,desktop-redis,"));
        values.insert("BOX_PLAY_PORT".into(), "3123".into());
        assert!(runtime_environment(&values, &input).is_err());
        values.insert("BOX_PLAY_PORT".into(), "bad".into());
        assert!(runtime_environment(&values, &input).is_err());
    }

    #[test]
    fn form_validation_rejects_web_type_and_range_bypasses() {
        let validate = |v: Value| validate_configuration(v.as_object().unwrap());
        assert!(validate(json!({"playNetworkMode":"lan","creatorNetworkMode":"local"})).is_ok());
        assert!(
            validate(json!({"playPort":" 3121 ","voxaPort":3123,"playRuntimes":2,
            "playPrewarmRuntimes":1,"creatorCpuLimit":0.5}))
            .is_ok()
        );
        assert!(
            validate(json!({"redisMode":"disabled","redisHost":"","redisPort":""})).is_ok(),
            "disabled Redis must not require a hidden port"
        );
        for bad in [
            json!({"playPort":0}),
            json!({"playPort":65536}),
            json!({"playPort":1,"voxaPort":1}),
            json!({"playRuntimes":0}),
            json!({"playPrewarmRuntimes":-1}),
            json!({"playRuntimes":1,"playPrewarmRuntimes":2}),
            json!({"creatorCpuLimit":"NaN"}),
            json!({"playPort":"bad"}),
            json!({"playPort":null}),
            json!({"playerLimit":1.5}),
            json!({"creatorCpuLimit":257}),
            json!({"creatorCpuLimit":0.09}),
            json!({"autoBackupIntervalMinutes":10081}),
            json!({"databasePoolSize":101}),
            json!({"scriptMemoryMb":127}),
            json!({"playMemoryMb":511}),
            json!({"databaseMode":"invalid"}),
        ] {
            assert!(validate(bad.clone()).is_err(), "{bad}");
        }
        assert_eq!(
            validate(json!({"databaseMode":"external","databasePort":""})).unwrap_err(),
            "PostgreSQL 端口必须是 1-65535 之间的整数"
        );
        assert!(validate(json!({"databaseMode":"managed","databasePort":""})).is_ok());
        assert_eq!(
            validate(json!({"redisMode":"external","redisPort":""})).unwrap_err(),
            "Redis 端口必须是 1-65535 之间的整数"
        );
        assert_eq!(
            validate(json!({"redisPort":"bad"})).unwrap_err(),
            "Redis 端口必须是 1-65535 之间的整数"
        );
    }
}

#[cfg(test)]
mod independent_address_tests {
    use super::*;
    #[test]
    fn explicit_empty_service_address_does_not_inherit_a_legacy_shared_host() {
        let values = BTreeMap::from([
            ("BOX_PLAY_NETWORK_MODE".into(), "public".into()),
            ("BOX_CREATOR_NETWORK_MODE".into(), "local".into()),
            ("BOX_PLAY_PUBLIC_HOST".into(), "legacy-shared.example.test".into()),
            ("BOX_PUBLIC_SCHEME".into(), "https".into()),
            ("BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE".into(), "https://play.example.test".into()),
            ("BOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE".into(), String::new()),
        ]);
        let result = runtime_environment(&values, &RuntimeInputs {lan_ip:None,image_tag:"test",platform:"linux/arm64",database_required:false,web_manager:false}).unwrap();
        assert_eq!(result["BOX_PLAY_PUBLIC_URL"], "https://play.example.test");
        assert_eq!(result["BOX_AUTH_PORTAL_PUBLIC_URL"], "http://127.0.0.1:3125");
        assert_eq!(result["BOX_PLAYER_LOGIN_URL"], "http://127.0.0.1:3125");
    }
}

#[cfg(test)]
mod individual_validation_tests {
    use super::*;
    #[test]
    fn service_validation_reports_its_own_label_and_ignores_removed_shared_inputs() {
        let config = serde_json::json!({"playNetworkMode":"public","publicAddress":"stale-shared-value","playPublicAddressOverride":"http://play.example.test:4121","authPortalPublicAddressOverride":""});
        assert_eq!(independent_public_base(config.as_object().unwrap()).unwrap(), Some("http://play.example.test".into()));
        validate_configuration(config.as_object().unwrap()).unwrap();
        let invalid = serde_json::json!({"playPublicAddressOverride":"not a valid domain"});
        let error = independent_public_base(invalid.as_object().unwrap()).unwrap_err();
        assert!(error.contains("Play 公网地址"));
        assert!(!error.contains("共用"));
        let empty = serde_json::json!({"playPublicAddressOverride":"","authPortalPublicAddressOverride":""});
        assert_eq!(independent_public_base(empty.as_object().unwrap()).unwrap(), Some("127.0.0.1".into()));
    }
}

#[cfg(test)]
mod access_conflict_regressions {
    use super::*;
    fn runtime(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        let values = pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect();
        runtime_environment(&values, &RuntimeInputs { lan_ip:Some("192.168.1.9"),image_tag:"test",platform:"linux/amd64",database_required:false,web_manager:true }).unwrap()
    }
    #[test]
    fn all_access_mode_pairs_use_matching_urls_and_origins() {
        for play in ["local", "lan", "public"] {
            for creator in ["local", "lan", "public"] {
                let result = runtime(&[
                    ("BOX_PLAY_NETWORK_MODE", play),
                    ("BOX_CREATOR_NETWORK_MODE", creator),
                    ("BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE", "https://play.example.test/play"),
                    ("BOX_CREATOR_PUBLIC_ADDRESS_OVERRIDE", "https://arena.example.test/arena"),
                    ("BOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE", "https://auth.example.test/accounts"),
                    ("BOX_PLAYER_LOGIN_URL_OVERRIDE", "http://172.31.9.78:3125"),
                ]);
                for (mode, key, public, port) in [
                    (play, "BOX_PLAY_PUBLIC_URL", "https://play.example.test/play", 3121),
                    (creator, "BOX_CREATOR_PUBLIC_URL", "https://arena.example.test/arena", 3127),
                    (play, "BOX_AUTH_PORTAL_PUBLIC_URL", "https://auth.example.test/accounts", 3125),
                ] {
                    let expected = match mode {
                        "public" => public.to_string(),
                        "lan" => format!("http://192.168.1.9:{port}"),
                        _ => format!("http://127.0.0.1:{port}"),
                    };
                    assert_eq!(result[key], expected, "{play}/{creator}: {key}");
                }
                assert_eq!(result["BOX_PLAYER_LOGIN_URL"], result["BOX_AUTH_PORTAL_PUBLIC_URL"]);
                assert!(!result["BOX_PLAYER_AUTH_ALLOWED_ORIGINS"].contains("/accounts"));
                assert!(!result["BOX_PLAYER_AUTH_ALLOWED_ORIGINS"].contains("172.31.9.78"));
            }
        }
    }

    #[test]
    fn public_https_play_does_not_turn_local_creator_into_https() {
        let result = runtime(&[("BOX_PLAY_NETWORK_MODE","public"),("BOX_CREATOR_NETWORK_MODE","local"),("BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE","https://play.example.test"),("BOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE","https://auth.example.test")]);
        assert_eq!(result["BOX_CREATOR_PUBLIC_URL"], "http://127.0.0.1:3127");
        assert_eq!(result["BOX_VOXA_PUBLIC_URL"], "http://127.0.0.1:3123");
        assert!(!result["BOX_PLAYER_AUTH_ALLOWED_ORIGINS"].contains("https://127.0.0.1"));
    }
    #[test]
    fn local_mode_ignores_old_public_url_and_login_overrides() {
        let result = runtime(&[("BOX_PLAY_NETWORK_MODE","local"),("BOX_CREATOR_NETWORK_MODE","local"),("BOX_PLAY_PUBLIC_HOST","127.0.0.1"),("BOX_CREATOR_HOST","127.0.0.1"),("BOX_PLAY_PUBLIC_URL_OVERRIDE","https://old.example.test/play"),("BOX_PLAYER_LOGIN_URL_OVERRIDE","https://old.example.test/login")]);
        assert_eq!(result["BOX_PLAY_PUBLIC_URL"], "http://127.0.0.1:3121");
        assert_eq!(result["BOX_PLAYER_LOGIN_URL"], "http://127.0.0.1:3125");
    }
}

#[cfg(test)]
mod flexible_configuration_tests {
    use super::*;
    #[test]
    fn independent_access_ranges_and_passwordless_postgres_are_supported() {
        let config=serde_json::json!({"playNetworkMode":"public","creatorNetworkMode":"local"});
        validate_configuration(config.as_object().unwrap()).unwrap();
        let parsed=parse_database_url("postgresql://owner@db:5432/box?sslmode=require").unwrap();
        assert!(parsed.password.is_empty());
        assert!(build_database_url(&parsed).unwrap().contains("owner:@db"));
    }
}

#[cfg(test)]
mod inactive_dependency_tests {
    use super::*;
    #[test]
    fn switching_away_from_unfinished_external_dependencies_ignores_hidden_fields() {
        let form=serde_json::json!({"databaseMode":"managed","databaseHost":"https://unfinished","databasePort":"invalid","redisMode":"disabled","redisHost":"unfinished:port","redisPort":"invalid"});
        validate_configuration(form.as_object().unwrap()).unwrap();
        let form=serde_json::json!({"databaseMode":"external","databaseHost":"https://unfinished","databasePort":"invalid"});
        assert!(validate_configuration(form.as_object().unwrap()).is_err());
    }
}
