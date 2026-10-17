//! Pure, idempotent migration of pre-HOST/MODE owner configuration.
//! Hosts persist the returned owner map (including migration markers HOST/MODE),
//! derive runtime configuration, then call `apply_url_overrides`. Form adapters
//! should remove a group's explicit overrides when the owner chooses to replace
//! its migrated custom URLs with newly generated UI addresses.

use crate::configuration::{host_from_http_url, origin_host, parse_database_url, validate_host};
use std::{collections::BTreeMap, net::IpAddr};

type Environment = BTreeMap<String, String>;

const PUBLIC_URLS: [(&str, bool, u16); 5] = [
    ("BOX_PLAY_PUBLIC_URL", false, 3121),
    ("BOX_PLAYER_SERVICE_PUBLIC_URL", false, 3124),
    ("BOX_AUTH_PORTAL_PUBLIC_URL", false, 3125),
    ("BOX_CREATOR_PUBLIC_URL", true, 3127),
    ("BOX_VOXA_PUBLIC_URL", true, 3123),
];

struct HttpUrl {
    value: String,
    host: String,
    origin: String,
    suffix: String,
    port: u16,
    secure: bool,
}

/// Validate before normalizing: even surrounding CR/LF and encoded controls
/// are rejected. No userinfo, backslashes, malformed escapes or opaque URLs.
fn http_url(value: &str, key: &str) -> Result<HttpUrl, String> {
    let invalid = || format!("{key} 必须是无凭据、无控制字符的有效 HTTP(S) URL");
    if value
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || "\\\"<>`{}|^".contains(c))
    {
        return Err(invalid());
    }
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let digits = bytes.get(index + 1..index + 3).ok_or_else(invalid)?;
            let hex = std::str::from_utf8(digits).map_err(|_| invalid())?;
            let decoded = u8::from_str_radix(hex, 16).map_err(|_| invalid())?;
            if decoded.is_ascii_control() || decoded == b'\\' {
                return Err(invalid());
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    if urlencoding::decode(value).is_ok_and(|decoded| decoded.chars().any(char::is_control)) {
        return Err(invalid());
    }
    let (scheme, rest) = value.split_once("://").ok_or_else(invalid)?;
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") {
        return Err(invalid());
    }
    let normalized = format!("{scheme}://{rest}");
    let host = host_from_http_url(&normalized).ok_or_else(invalid)?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('@') {
        return Err(invalid());
    }
    let secure = scheme == "https";
    let default_port = if secure { 443 } else { 80 };
    let port_text = if authority.starts_with('[') {
        authority
            .split_once(']')
            .and_then(|(_, suffix)| suffix.strip_prefix(':'))
    } else {
        authority.split_once(':').map(|(_, port)| port)
    };
    let port = port_text
        .map(str::parse::<u16>)
        .transpose()
        .map_err(|_| invalid())?
        .unwrap_or(default_port);
    let port_suffix = if port == default_port {
        String::new()
    } else {
        format!(":{port}")
    };
    let origin = format!("{scheme}://{}{port_suffix}", origin_host(&host)?);
    Ok(HttpUrl {
        value: normalized,
        host,
        origin,
        suffix: rest[authority_end..].into(),
        port,
        secure,
    })
}

pub fn normalize_public_url(value: &str, key: &str) -> Result<String, String> {
    http_url(value, key).map(|url| url.value)
}

pub fn public_url_parts(value: &str, key: &str) -> Result<(String, u16, bool, String), String> {
    http_url(value, key).map(|url| (url.host, url.port, url.secure, url.suffix))
}

fn loopback(host: &str) -> bool {
    host.trim_end_matches('.').eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}
fn unspecified(host: &str) -> bool {
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified())
}
fn nonempty<'a>(values: &'a Environment, key: &str) -> Option<&'a str> {
    values
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

/// A legacy template's loopback HTTP root URL is derived/default data, not an
/// explicit custom endpoint. In particular it must not defeat a wildcard bind.
fn template_url(url: &HttpUrl, port: u16) -> bool {
    !url.secure
        && loopback(&url.host)
        && url.port == port
        && matches!(url.suffix.as_str(), "" | "/")
}

fn migrate_network(
    values: &Environment,
    result: &mut Environment,
    creator: bool,
) -> Result<(), String> {
    let (host_key, mode_key, public_key, bind_keys) = if creator {
        (
            "BOX_CREATOR_HOST",
            "BOX_CREATOR_NETWORK_MODE",
            "BOX_CREATOR_PUBLIC_URL",
            &["BOX_CREATOR_BIND_IP", "BOX_VOXA_BIND_IP"][..],
        )
    } else {
        (
            "BOX_PLAY_PUBLIC_HOST",
            "BOX_PLAY_NETWORK_MODE",
            "BOX_PLAY_PUBLIC_URL",
            &["BOX_BIND_IP"][..],
        )
    };
    let missing_host = !values.contains_key(host_key);
    let missing_mode = !values.contains_key(mode_key);
    if !missing_mode && values.keys().any(|key| key.ends_with("_PUBLIC_ADDRESS_OVERRIDE")) { return Ok(()); }
    // A partially adopted new schema is already an owner choice: fill missing
    // fields, but never turn its stale derived URLs into permanent overrides.
    let legacy = missing_host && missing_mode;
    if !missing_host && !missing_mode {
        return Ok(());
    }
    let old_url = if legacy {
        nonempty(values, public_key)
            .map(|v| http_url(v, public_key))
            .transpose()?
    } else {
        None
    };
    let binding = bind_keys
        .iter()
        .find_map(|key| nonempty(values, key))
        .map(|host| validate_host(host, "旧监听地址"))
        .transpose()?;
    let explicit_host = values.get(host_key).cloned();
    let old_host = old_url.as_ref().map(|url| url.host.clone());
    let fixed_host = explicit_host
        .or_else(|| old_host.clone().filter(|h| !loopback(h) && !unspecified(h)))
        .or_else(|| binding.clone().filter(|h| !loopback(h) && !unspecified(h)))
        .or_else(|| old_host.filter(|h| !unspecified(h)))
        .unwrap_or_else(|| "127.0.0.1".into());
    let wildcard = binding.as_deref().is_some_and(unspecified);
    let mode = if !loopback(&fixed_host) && !unspecified(&fixed_host) {
        // A known private/LAN IP must stay pinned even if the adapter cannot
        // detect LAN IPs (e.g. a legacy Web container lacking BOX_LAN_IP).
        "public"
    } else if wildcard {
        "lan"
    } else {
        "local"
    };
    if missing_host {
        result.insert(host_key.into(), fixed_host);
    }
    if missing_mode {
        result.insert(mode_key.into(), mode.into());
    }
    if legacy {
        for (key, group, default_port) in PUBLIC_URLS {
            if group != creator {
                continue;
            }
            let override_key = format!("{key}_OVERRIDE");
            if result.contains_key(&override_key) {
                continue;
            }
            if let Some(value) = nonempty(values, key) {
                let url = http_url(value, key)?;
                let port_key = key.replace("_PUBLIC_URL", "_PORT");
                let port = crate::configuration::env_port(values, &port_key, default_port)?;
                if !template_url(&url, port) && !unspecified(&url.host) {
                    result.insert(override_key, url.value);
                }
            }
        }
    }
    Ok(())
}

/// Return a new owner map; existing HOST/MODE and explicit overrides win.
/// Database query migration does not replace structured credentials or host.
/// Managed databases discard external URL query options, including sslmode.
pub fn migrate(values: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    let mut result = values.clone();
    migrate_network(values, &mut result, false)?;
    migrate_network(values, &mut result, true)?;
    if !result.contains_key("BOX_PLAYER_LOGIN_URL_OVERRIDE") {
        if let Some(login) = nonempty(values, "BOX_PLAYER_LOGIN_URL") {
            if Some(login) != nonempty(values, "BOX_AUTH_PORTAL_PUBLIC_URL") {
                result.insert(
                    "BOX_PLAYER_LOGIN_URL_OVERRIDE".into(),
                    http_url(login, "BOX_PLAYER_LOGIN_URL")?.value,
                );
            }
        }
    }
    match values.get("BOX_DATABASE_MODE").map(String::as_str) {
        Some("managed") => {
            result.remove("BOX_DATABASE_QUERY");
        }
        None | Some("external") if !values.contains_key("BOX_DATABASE_QUERY") => {
            if let Some(url) = nonempty(values, "BOX_DATABASE_URL") {
                if let Some(query) = parse_database_url(url)?.query {
                    result.insert("BOX_DATABASE_QUERY".into(), query);
                }
            }
        }
        _ => {}
    }
    Ok(result)
}

/// Apply only migration map differences to the owner document. Comments,
/// unrelated assignments and unchanged keys retain their original text; a
/// no-op migration returns the exact input, including its line endings.
pub fn migrate_document(content: &str) -> Result<String, String> {
    use crate::environment::{parse_env, remove_env, set_env};
    let before = parse_env(content);
    let after = migrate(&before)?;
    let mut result = content.to_string();
    for key in before.keys().filter(|key| !after.contains_key(*key)) {
        remove_env(&mut result, key);
    }
    for (key, value) in &after {
        if before.get(key) != Some(value) {
            set_env(&mut result, key, value)?;
        }
    }
    Ok(result)
}

/// Call after `migrate_document`, before writing submitted form fields. Only
/// actual changes to submitted HOST/MODE/ports clear public URL overrides.
/// Independent login overrides remain advanced owner settings. Validation of
/// all relevant submitted fields completes before the document is modified.
pub fn clear_overrides_on_configuration_change(
    content: &mut String,
    config: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    use crate::configuration::{
        env_port, validate_creator_host, validate_network_mode, validate_port,
    };
    use crate::environment::{parse_env, remove_env};
    use serde_json::Value;
    let previous = parse_env(content);
    let mut changed_groups = [false; 2];
    for (field, key, creator, is_mode) in [
        ("publicHost", "BOX_PLAY_PUBLIC_HOST", false, false),
        ("playNetworkMode", "BOX_PLAY_NETWORK_MODE", false, true),
        ("creatorHost", "BOX_CREATOR_HOST", true, false),
        ("creatorNetworkMode", "BOX_CREATOR_NETWORK_MODE", true, true),
    ] {
        let Some(value) = config.get(field) else {
            continue;
        };
        let submitted = value
            .as_str()
            .ok_or_else(|| format!("{field} 必须是字符串"))?;
        let old = previous.get(key).map(String::as_str).unwrap_or(if is_mode {
            "local"
        } else {
            "127.0.0.1"
        });
        let changed = if is_mode {
            validate_network_mode(submitted)?;
            submitted != old
        } else {
            let submitted = validate_creator_host(submitted)?;
            // A bad old value must not prevent the owner from repairing it.
            validate_creator_host(old).ok().as_ref() != Some(&submitted)
        };
        changed_groups[usize::from(creator)] |= changed;
    }
    let mut remove = std::collections::BTreeSet::new();
    for ((key, creator, default_port), field) in PUBLIC_URLS.into_iter().zip([
        "playPort",
        "playerServicePort",
        "authPortalPort",
        "creatorPort",
        "voxaPort",
    ]) {
        let mut changed = changed_groups[usize::from(creator)];
        if let Some(value) = config.get(field) {
            let submitted = match value {
                Value::String(value) => validate_port(value)?,
                Value::Number(value) => {
                    let value = value
                        .as_f64()
                        .filter(|v| {
                            v.is_finite() && v.fract() == 0.0 && (1.0..=65535.0).contains(v)
                        })
                        .ok_or_else(|| format!("{field} 必须是 1-65535 之间的整数"))?;
                    value as u16
                }
                _ => return Err(format!("{field} 必须是 1-65535 之间的整数")),
            };
            let port_key = key.replace("_PUBLIC_URL", "_PORT");
            changed |= env_port(&previous, &port_key, default_port).ok() != Some(submitted);
        }
        let override_key = format!("{key}_OVERRIDE");
        if changed && previous.contains_key(&override_key) {
            remove.insert(override_key);
        }
    }
    for key in remove {
        remove_env(content, &key);
    }
    Ok(())
}

fn cors(urls: &[&HttpUrl]) -> String {
    let mut origins = Vec::new();
    for url in urls {
        if !origins.contains(&url.origin.as_str()) {
            origins.push(url.origin.as_str());
        }
    }
    origins.join(",")
}

/// Apply the six explicit overrides to an already generated runtime map.
/// Recompute CORS using URL origins (scheme/host/port), never paths or queries.
/// No changes are committed if any effective URL is invalid or missing.
pub fn apply_url_overrides(
    values: &BTreeMap<String, String>,
    derived: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let mut result = derived.clone();
    let mut urls = BTreeMap::new();
    for (key, _, _) in PUBLIC_URLS {
        let override_key = format!("{key}_OVERRIDE");
        let value = values
            .get(&override_key)
            .or_else(|| derived.get(key))
            .ok_or_else(|| format!("运行时配置缺少 {key}"))?;
        let url = http_url(value, &override_key)?;
        result.insert(key.into(), url.value.clone());
        urls.insert(key, url);
    }
    let login_key = "BOX_PLAYER_LOGIN_URL_OVERRIDE";
    let login = http_url(
        values
            .get(login_key)
            .map(String::as_str)
            .unwrap_or(&urls["BOX_AUTH_PORTAL_PUBLIC_URL"].value),
        login_key,
    )?;
    result.insert("BOX_PLAYER_LOGIN_URL".into(), login.value.clone());
    let creator = &urls["BOX_CREATOR_PUBLIC_URL"];
    let voxa = &urls["BOX_VOXA_PUBLIC_URL"];
    let play = &urls["BOX_PLAY_PUBLIC_URL"];
    let auth = &urls["BOX_AUTH_PORTAL_PUBLIC_URL"];
    let creator_origins = cors(&[voxa, creator]);
    result.insert("BOX_VOXA_ALLOWED_ORIGINS".into(), creator_origins.clone());
    result.insert("BOX_RESOURCE_ALLOWED_ORIGINS".into(), creator_origins);
    result.insert(
        "BOX_PLAYER_AUTH_ALLOWED_ORIGINS".into(),
        cors(&[play, creator, auth, &login]),
    );
    result.insert("BOX_CREATOR_ALLOWED_HOSTS".into(), creator.host.clone());
    *derived = result;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(pairs: &[(&str, &str)]) -> Environment {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }
    fn runtime() -> Environment {
        env(&[
            ("BOX_PLAY_PUBLIC_URL", "http://127.0.0.1:3121"),
            ("BOX_PLAYER_SERVICE_PUBLIC_URL", "http://127.0.0.1:3124"),
            ("BOX_AUTH_PORTAL_PUBLIC_URL", "http://127.0.0.1:3125"),
            ("BOX_CREATOR_PUBLIC_URL", "http://127.0.0.1:3127"),
            ("BOX_VOXA_PUBLIC_URL", "http://127.0.0.1:3123"),
            ("BOX_PLAYER_LOGIN_URL", "http://127.0.0.1:3125"),
            ("UNRELATED", "keep"),
        ])
    }
    #[test]
    fn legacy_public_urls_keep_lan_reachability_without_lan_detection() {
        let source = env(&[
            ("BOX_PLAY_PUBLIC_URL", "http://192.168.1.9:3121"),
            ("BOX_BIND_IP", "0.0.0.0"),
            ("BOX_CREATOR_PUBLIC_URL", "http://192.168.1.9:3127"),
            ("BOX_CREATOR_BIND_IP", "0.0.0.0"),
        ]);
        let result = migrate(&source).unwrap();
        assert_eq!(result["BOX_PLAY_PUBLIC_HOST"], "192.168.1.9");
        assert_eq!(result["BOX_PLAY_NETWORK_MODE"], "public");
        assert_eq!(result["BOX_CREATOR_NETWORK_MODE"], "public");
        let network = crate::configuration::resolve_network(&result, None).unwrap();
        assert_eq!(network.play_bind_ip, "0.0.0.0");
        assert_eq!(network.creator_bind_ip, "0.0.0.0");
        assert_eq!(network.creator_host, "192.168.1.9");
        assert_eq!(migrate(&result).unwrap(), result);
        assert!(!source.contains_key("BOX_PLAY_PUBLIC_HOST"));
    }
    #[test]
    fn wildcard_with_template_urls_uses_injected_lan_not_loopback_overrides() {
        let mut source = runtime();
        source.insert("BOX_BIND_IP".into(), "0.0.0.0".into());
        source.insert("BOX_CREATOR_BIND_IP".into(), "::".into());
        let migrated = migrate(&source).unwrap();
        assert_eq!(migrated["BOX_PLAY_NETWORK_MODE"], "lan");
        assert_eq!(migrated["BOX_CREATOR_NETWORK_MODE"], "lan");
        assert!(!migrated.contains_key("BOX_PLAY_PUBLIC_URL_OVERRIDE"));
        assert!(!migrated.contains_key("BOX_PLAYER_LOGIN_URL_OVERRIDE"));
        let network =
            crate::configuration::resolve_network(&migrated, Some("192.168.1.10")).unwrap();
        assert_eq!(network.play_host, "192.168.1.10");
        assert_eq!(network.creator_host, "192.168.1.10");
    }
    #[test]
    fn old_fixed_bind_and_ipv6_are_preserved() {
        let migrated = migrate(&env(&[
            ("BOX_BIND_IP", "192.168.2.5"),
            ("BOX_CREATOR_BIND_IP", "[fd00::7]"),
        ]))
        .unwrap();
        let network = crate::configuration::resolve_network(&migrated, None).unwrap();
        assert_eq!(network.play_host, "192.168.2.5");
        assert_eq!(network.creator_host, "fd00::7");
        assert_eq!(network.creator_bind_ip, "0.0.0.0");
    }
    #[test]
    fn explicit_https_and_independent_login_survive_with_origin_only_cors() {
        let source = env(&[
            ("BOX_PLAY_PUBLIC_URL", "https://play.example/worlds"),
            ("BOX_CREATOR_PUBLIC_URL", "https://create.example/editor"),
            ("BOX_VOXA_PUBLIC_URL", "https://assets.example:8443/assets"),
            ("BOX_AUTH_PORTAL_PUBLIC_URL", "https://auth.example/portal"),
            (
                "BOX_PLAYER_LOGIN_URL",
                "https://login.example/sign-in?next=%2Fworld#form",
            ),
        ]);
        let migrated = migrate(&source).unwrap();
        let mut derived = runtime();
        apply_url_overrides(&migrated, &mut derived).unwrap();
        assert_eq!(
            derived["BOX_PLAY_PUBLIC_URL"],
            "https://play.example/worlds"
        );
        assert_eq!(
            derived["BOX_PLAYER_LOGIN_URL"],
            source["BOX_PLAYER_LOGIN_URL"]
        );
        assert_eq!(
            derived["BOX_VOXA_ALLOWED_ORIGINS"],
            "https://assets.example:8443,https://create.example"
        );
        assert_eq!(
            derived["BOX_RESOURCE_ALLOWED_ORIGINS"],
            derived["BOX_VOXA_ALLOWED_ORIGINS"]
        );
        assert_eq!(derived["BOX_PLAYER_AUTH_ALLOWED_ORIGINS"], "https://play.example,https://create.example,https://auth.example,https://login.example");
        assert_eq!(derived["BOX_CREATOR_ALLOWED_HOSTS"], "create.example");
        assert_eq!(derived["UNRELATED"], "keep");
    }
    #[test]
    fn existing_or_partial_new_schema_never_freezes_old_derived_urls() {
        for fields in [
            env(&[("BOX_PLAY_PUBLIC_HOST", "new.example")]),
            env(&[("BOX_PLAY_NETWORK_MODE", "local")]),
            env(&[
                ("BOX_PLAY_PUBLIC_HOST", "new.example"),
                ("BOX_PLAY_NETWORK_MODE", "public"),
            ]),
        ] {
            let mut source = fields.clone();
            source.insert("BOX_PLAY_PUBLIC_URL".into(), "https://stale.example".into());
            let migrated = migrate(&source).unwrap();
            for (key, value) in fields {
                assert_eq!(migrated[&key], value);
            }
            assert!(!migrated.contains_key("BOX_PLAY_PUBLIC_URL_OVERRIDE"));
        }
    }
    #[test]
    fn removed_migrated_override_is_not_recreated_from_stale_url() {
        let mut migrated =
            migrate(&env(&[("BOX_PLAY_PUBLIC_URL", "https://old.example")])).unwrap();
        migrated.remove("BOX_PLAY_PUBLIC_URL_OVERRIDE");
        migrated.insert("BOX_PLAY_PUBLIC_HOST".into(), "new.example".into());
        migrated.insert("BOX_PLAY_NETWORK_MODE".into(), "public".into());
        assert!(!migrate(&migrated)
            .unwrap()
            .contains_key("BOX_PLAY_PUBLIC_URL_OVERRIDE"));
    }
    #[test]
    fn independent_login_migrates_even_when_new_network_fields_exist() {
        let source = env(&[
            ("BOX_PLAY_PUBLIC_HOST", "new.example"),
            ("BOX_PLAY_NETWORK_MODE", "public"),
            ("BOX_AUTH_PORTAL_PUBLIC_URL", "https://auth.example"),
            ("BOX_PLAYER_LOGIN_URL", "https://auth.example/login"),
        ]);
        let migrated = migrate(&source).unwrap();
        assert_eq!(
            migrated["BOX_PLAYER_LOGIN_URL_OVERRIDE"],
            "https://auth.example/login"
        );
        assert_eq!(migrate(&migrated).unwrap(), migrated);
    }
    #[test]
    fn existing_overrides_win_and_default_login_tracks_auth_override() {
        let source = env(&[
            ("BOX_PLAY_PUBLIC_URL", "https://old.example"),
            ("BOX_PLAY_PUBLIC_URL_OVERRIDE", "https://chosen.example"),
            (
                "BOX_AUTH_PORTAL_PUBLIC_URL_OVERRIDE",
                "https://auth.example/portal",
            ),
        ]);
        let migrated = migrate(&source).unwrap();
        assert_eq!(
            migrated["BOX_PLAY_PUBLIC_URL_OVERRIDE"],
            "https://chosen.example"
        );
        let mut derived = runtime();
        apply_url_overrides(&migrated, &mut derived).unwrap();
        assert_eq!(
            derived["BOX_PLAYER_LOGIN_URL"],
            "https://auth.example/portal"
        );
        assert_eq!(
            derived["BOX_PLAYER_AUTH_ALLOWED_ORIGINS"]
                .matches("https://auth.example")
                .count(),
            1
        );
    }
    #[test]
    fn external_query_migrates_with_split_credentials_and_is_idempotent() {
        let mut source = env(&[("BOX_DATABASE_MODE", "external"), ("BOX_DATABASE_HOST", "db.example"),
            ("BOX_DATABASE_NAME", "box"), ("BOX_DATABASE_USER", "owner"), ("BOX_DATABASE_PASSWORD", "secret"),
            ("BOX_DATABASE_URL", "postgres://old:old@old.example/old?sslmode=require&application_name=box%20manager&options=a+b")]);
        for explicit_mode in [true, false] {
            if !explicit_mode {
                source.remove("BOX_DATABASE_MODE");
            }
            let migrated = migrate(&source).unwrap();
            assert_eq!(
                migrated["BOX_DATABASE_QUERY"],
                "sslmode=require&application_name=box%20manager&options=a+b"
            );
            assert_eq!(migrated["BOX_DATABASE_PASSWORD"], "secret");
            assert!(crate::configuration::database_url(&migrated)
                .unwrap()
                .contains("@db.example:5432/box?sslmode=require"));
            assert_eq!(migrate(&migrated).unwrap(), migrated);
        }
    }
    #[test]
    fn explicit_empty_query_wins_and_managed_query_is_removed() {
        let mut source = env(&[
            ("BOX_DATABASE_URL", "postgres://u:p@db/box?sslmode=require"),
            ("BOX_DATABASE_QUERY", ""),
        ]);
        assert_eq!(migrate(&source).unwrap()["BOX_DATABASE_QUERY"], "");
        source.insert("BOX_DATABASE_MODE".into(), "managed".into());
        source.insert("BOX_DATABASE_QUERY".into(), "sslmode=require".into());
        let migrated = migrate(&source).unwrap();
        assert!(!migrated.contains_key("BOX_DATABASE_QUERY"));
        assert_eq!(migrate(&migrated).unwrap(), migrated);
        assert_eq!(migrated["BOX_DATABASE_URL"], source["BOX_DATABASE_URL"]);
    }
    #[test]
    fn malformed_legacy_database_url_is_not_silently_discarded() {
        assert!(migrate(&env(&[("BOX_DATABASE_URL", "postgres://u:p@db/box?x=%zz")])).is_err());
    }
    #[test]
    fn invalid_urls_are_rejected_atomically() {
        for invalid in [
            "",
            "ftp://host/path",
            "//host/path",
            "https://u:p@host",
            "https://u@host",
            "https://host\n",
            "https://host/\t",
            "https://host/%0d%0a",
            "https://host/%00",
            "https://host/%7f",
            "https://host/%zz",
            "https://host/%",
            "https://host\\evil/path",
            "https://host/%5cpath",
            "https://host:0",
            "https://host:65536",
            "https://[::1]evil/path",
            "https://::1/path",
            "https://ho%73t/path",
            "https://host/has space",
        ] {
            let mut derived = runtime();
            let before = derived.clone();
            let values = env(&[("BOX_PLAYER_LOGIN_URL_OVERRIDE", invalid)]);
            assert!(
                apply_url_overrides(&values, &mut derived).is_err(),
                "{invalid:?}"
            );
            assert_eq!(derived, before);
        }
    }
    #[test]
    fn all_public_overrides_are_validated_not_only_login() {
        for (key, _, _) in PUBLIC_URLS {
            let mut derived = runtime();
            let before = derived.clone();
            assert!(apply_url_overrides(
                &env(&[(&format!("{key}_OVERRIDE"), "https://user:pass@host")]),
                &mut derived
            )
            .is_err());
            assert_eq!(derived, before);
        }
    }
    #[test]
    fn cors_canonicalizes_default_ports_ipv6_and_deduplicates_origins() {
        let source = env(&[
            (
                "BOX_PLAY_PUBLIC_URL_OVERRIDE",
                "HTTPS://EXAMPLE.COM:443/play",
            ),
            (
                "BOX_CREATOR_PUBLIC_URL_OVERRIDE",
                "https://example.com/editor",
            ),
            (
                "BOX_AUTH_PORTAL_PUBLIC_URL_OVERRIDE",
                "https://[fd00::1]:8443/auth",
            ),
            (
                "BOX_PLAYER_LOGIN_URL_OVERRIDE",
                "https://[fd00::1]:8443/login?next=/",
            ),
        ]);
        let mut derived = runtime();
        apply_url_overrides(&source, &mut derived).unwrap();
        assert_eq!(
            derived["BOX_PLAYER_AUTH_ALLOWED_ORIGINS"],
            "https://example.com,https://[fd00::1]:8443"
        );
    }
    // Keep the pre-migration configuration API exercised across schema versions.
    #[test]
    fn old_configuration_interfaces_still_accept_migrated_owner_values() {
        let source = env(&[
            ("BOX_PLAY_PUBLIC_URL", "https://play.example/worlds"),
            ("BOX_CREATOR_PUBLIC_URL", "https://create.example/editor"),
            ("BOX_DATABASE_URL", "postgres://u:p@db/box?sslmode=require"),
        ]);
        let migrated = migrate(&source).unwrap();
        let mut derived = crate::configuration::runtime_environment(
            &migrated,
            &crate::configuration::RuntimeInputs {
                lan_ip: None,
                image_tag: "fixture",
                platform: "linux/amd64",
                database_required: true,
                web_manager: true,
            },
        )
        .unwrap();
        apply_url_overrides(&migrated, &mut derived).unwrap();
        assert_eq!(
            derived["BOX_PLAY_PUBLIC_URL"],
            "https://play.example/worlds"
        );
        assert_eq!(derived["BOX_BIND_IP"], "0.0.0.0");
        assert_eq!(derived["BOX_CREATOR_BIND_IP"], "0.0.0.0");
        assert_eq!(
            derived["BOX_DATABASE_URL"],
            "postgresql://u:p@db:5432/box?sslmode=require"
        );
        let once = derived.clone();
        apply_url_overrides(&migrated, &mut derived).unwrap();
        assert_eq!(derived, once);
    }
    #[test]
    fn missing_effective_url_and_encoded_unicode_controls_fail_atomically() {
        let mut derived = runtime();
        derived.remove("BOX_VOXA_PUBLIC_URL");
        let before = derived.clone();
        assert!(apply_url_overrides(&Environment::new(), &mut derived).is_err());
        assert_eq!(derived, before);
        for value in [
            "https://host/%C2%85",
            "https://host/<tag>",
            "https://host/\"x",
        ] {
            let mut derived = runtime();
            let before = derived.clone();
            assert!(apply_url_overrides(
                &env(&[("BOX_PLAYER_LOGIN_URL_OVERRIDE", value)]),
                &mut derived
            )
            .is_err());
            assert_eq!(derived, before);
        }
    }

    #[test]
    fn empty_legacy_config_is_local_and_migration_does_not_modify_input() {
        let source = Environment::new();
        let migrated = migrate(&source).unwrap();
        assert!(source.is_empty());
        assert_eq!(migrated["BOX_PLAY_NETWORK_MODE"], "local");
        assert_eq!(migrated["BOX_CREATOR_NETWORK_MODE"], "local");
        assert_eq!(migrate(&migrated).unwrap(), migrated);
    }
}

#[cfg(test)]
mod document_tests {
    use super::*;
    use crate::environment::{parse_env, set_env};
    use serde_json::json;

    fn document() -> String {
        let mut result = String::from(
            "# keep this comment\nUNRELATED = a=b\nBOX_PLAY_PUBLIC_HOST=play.example\nBOX_PLAY_NETWORK_MODE=public\nBOX_CREATOR_HOST=create.example\nBOX_CREATOR_NETWORK_MODE=public\nBOX_PLAYER_LOGIN_URL_OVERRIDE=https://login.example/sign-in?next=/\n",
        );
        for (key, _, _) in PUBLIC_URLS {
            set_env(
                &mut result,
                &format!("{key}_OVERRIDE"),
                "https://override.example/path",
            )
            .unwrap();
        }
        result
    }
    fn clear(content: &mut String, config: serde_json::Value) -> Result<(), String> {
        clear_overrides_on_configuration_change(content, config.as_object().unwrap())
    }
    #[test]
    fn document_migrates_only_map_differences_and_preserves_comments() {
        let source = "# keep me\n OTHER = first\nOTHER=second=value\nBOX_PLAY_PUBLIC_URL=https://play.example/path\nBOX_DATABASE_URL=postgres://u:p@db/box?sslmode=require\n";
        let migrated = migrate_document(source).unwrap();
        assert!(migrated.starts_with(source));
        let values = parse_env(&migrated);
        assert_eq!(values, migrate(&parse_env(source)).unwrap());
        assert_eq!(values["BOX_DATABASE_QUERY"], "sslmode=require");
        assert_eq!(migrate_document(&migrated).unwrap(), migrated);
        let no_op = document().replace('\n', "\r\n");
        assert_eq!(migrate_document(&no_op).unwrap(), no_op);
    }
    #[test]
    fn managed_document_removes_all_query_assignments_but_not_comments() {
        let source = format!("{}# BOX_DATABASE_QUERY=keep comment\nBOX_DATABASE_MODE=managed\n BOX_DATABASE_QUERY = sslmode=require\nBOX_DATABASE_QUERY=options=x\n", document());
        let migrated = migrate_document(&source).unwrap();
        assert!(!parse_env(&migrated).contains_key("BOX_DATABASE_QUERY"));
        assert!(migrated.contains("# BOX_DATABASE_QUERY=keep comment"));
        assert!(migrated.contains("UNRELATED = a=b"));
        assert_eq!(migrate_document(&migrated).unwrap(), migrated);
    }
    #[test]
    fn unchanged_submissions_preserve_document_and_all_overrides() {
        let mut source = document();
        let before = source.clone();
        clear(
            &mut source,
            json!({
                "publicHost":" PLAY.EXAMPLE ", "playNetworkMode":"public",
                "creatorHost":"create.example", "creatorNetworkMode":"public",
                "playPort":3121, "playerServicePort":"03124", "authPortalPort":3125,
                "creatorPort":3127.0, "voxaPort":" 3123 ", "databaseMode":"managed",
            }),
        )
        .unwrap();
        assert_eq!(source, before);
        clear(&mut source, json!({})).unwrap();
        assert_eq!(source, before);
    }
    #[test]
    fn actual_host_or_mode_change_clears_only_its_group() {
        for (config, changed_group) in [
            (json!({"publicHost":"new.example"}), false),
            (json!({"playNetworkMode":"lan"}), false),
            (json!({"creatorHost":"new.example"}), true),
            (json!({"creatorNetworkMode":"local"}), true),
        ] {
            let mut source = document();
            clear(&mut source, config).unwrap();
            let values = parse_env(&source);
            for (key, creator, _) in PUBLIC_URLS {
                assert_eq!(
                    values.contains_key(&format!("{key}_OVERRIDE")),
                    creator != changed_group
                );
            }
            assert_eq!(
                values["BOX_PLAYER_LOGIN_URL_OVERRIDE"],
                "https://login.example/sign-in?next=/"
            );
            // Clearing does not write any of the submitted UI fields.
            assert_eq!(values["BOX_PLAY_PUBLIC_HOST"], "play.example");
            assert!(source.contains("# keep this comment\nUNRELATED = a=b\n"));
        }
    }
    #[test]
    fn each_changed_port_clears_only_its_url() {
        for (field, target) in [
            ("playPort", "BOX_PLAY_PUBLIC_URL"),
            ("playerServicePort", "BOX_PLAYER_SERVICE_PUBLIC_URL"),
            ("authPortalPort", "BOX_AUTH_PORTAL_PUBLIC_URL"),
            ("creatorPort", "BOX_CREATOR_PUBLIC_URL"),
            ("voxaPort", "BOX_VOXA_PUBLIC_URL"),
        ] {
            let mut source = document();
            clear(&mut source, json!({field: "4000"})).unwrap();
            let values = parse_env(&source);
            for (key, _, _) in PUBLIC_URLS {
                assert_eq!(
                    values.contains_key(&format!("{key}_OVERRIDE")),
                    key != target
                );
            }
            assert!(values.contains_key("BOX_PLAYER_LOGIN_URL_OVERRIDE"));
        }
    }
    #[test]
    fn explicit_old_port_compares_numerically_and_duplicate_overrides_are_removed() {
        let mut source = document();
        source.push_str(
            "BOX_PLAY_PORT = 04000\n BOX_PLAY_PUBLIC_URL_OVERRIDE = https://duplicate.example\n",
        );
        let before = source.clone();
        clear(&mut source, json!({"playPort":4000})).unwrap();
        assert_eq!(source, before);
        clear(&mut source, json!({"playPort":3121})).unwrap();
        assert!(!parse_env(&source).contains_key("BOX_PLAY_PUBLIC_URL_OVERRIDE"));
        assert!(!source.contains("https://duplicate.example"));
    }
    #[test]
    fn equivalent_ipv6_host_does_not_clear_override() {
        let mut source = document();
        set_env(&mut source, "BOX_CREATOR_HOST", "fd00::1").unwrap();
        let before = source.clone();
        clear(&mut source, json!({"creatorHost":"[fd00:0:0:0:0:0:0:1]"})).unwrap();
        assert_eq!(source, before);
    }
    #[test]
    fn malformed_submissions_never_partially_clear_overrides() {
        for invalid in [
            json!({"publicHost":"new.example", "voxaPort":null}),
            json!({"publicHost":"new.example", "voxaPort":1.5}),
            json!({"publicHost":"new.example", "voxaPort":65536}),
            json!({"publicHost":"new.example", "voxaPort":true}),
            json!({"publicHost":"new.example", "voxaPort":"bad"}),
            json!({"publicHost":"new.example", "creatorNetworkMode":"typo"}),
            json!({"publicHost":"new.example", "creatorHost":"https://host/path"}),
            json!({"publicHost":null}),
        ] {
            let mut source = document();
            let before = source.clone();
            assert!(clear(&mut source, invalid).is_err());
            assert_eq!(source, before);
        }
    }
    #[test]
    fn adapter_sequence_migrate_clear_write_remigrate_does_not_restore_public_overrides() {
        let legacy = "BOX_PLAY_PUBLIC_URL=https://old.example/play\nBOX_AUTH_PORTAL_PUBLIC_URL=https://auth.example/\nBOX_PLAYER_LOGIN_URL=https://login.example/custom\n";
        let mut source = migrate_document(legacy).unwrap();
        clear(
            &mut source,
            json!({"publicHost":"new.example", "playNetworkMode":"public", "playPort":4000}),
        )
        .unwrap();
        set_env(&mut source, "BOX_PLAY_PUBLIC_HOST", "new.example").unwrap();
        set_env(&mut source, "BOX_PLAY_NETWORK_MODE", "public").unwrap();
        set_env(&mut source, "BOX_PLAY_PORT", "4000").unwrap();
        let source = migrate_document(&source).unwrap();
        let values = parse_env(&source);
        assert!(!values.contains_key("BOX_PLAY_PUBLIC_URL_OVERRIDE"));
        assert!(!values.contains_key("BOX_AUTH_PORTAL_PUBLIC_URL_OVERRIDE"));
        assert_eq!(
            values["BOX_PLAYER_LOGIN_URL_OVERRIDE"],
            "https://login.example/custom"
        );
        assert_eq!(values["BOX_PLAY_PUBLIC_HOST"], "new.example");
    }
}
