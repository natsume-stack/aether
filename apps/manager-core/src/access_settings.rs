//! Keep the public-address draft separate from the hosts selected by the access modes.
use std::collections::BTreeMap;
use std::net::IpAddr;

use crate::configuration::{origin_host, parse_public_address, resolve_network};
use crate::environment::set_env;

pub fn independent_owner(content: &str) -> String {
    let values = crate::environment::parse_env(content);
    if !values.keys().any(|key| key.ends_with("_PUBLIC_ADDRESS_OVERRIDE")) { return content.into(); }
    let mut result = content.to_string();
    for key in ["BOX_PLAY_PUBLIC_HOST", "BOX_CREATOR_HOST", "BOX_PUBLIC_ADDRESS", "BOX_PUBLIC_SCHEME"] {
        crate::environment::remove_env(&mut result, key);
    }
    result
}

/// Old configurations store the draft only in the host/scheme pair.
pub fn public_address(values: &BTreeMap<String, String>) -> String {
    if let Some(address) = values.get("BOX_PUBLIC_ADDRESS") {
        return address.clone();
    }
    let host = values
        .get("BOX_PLAY_PUBLIC_HOST")
        .map(String::as_str)
        .unwrap_or("127.0.0.1");
    if host.parse::<IpAddr>().is_ok() {
        return origin_host(host).unwrap_or_else(|_| host.into());
    }
    let scheme = values
        .get("BOX_PUBLIC_SCHEME")
        .map(String::as_str)
        .unwrap_or("http");
    format!("{scheme}://{host}")
}

/// Pure transformation used by both launchers. LAN IP comes from the host adapter,
/// never a browser-supplied address. Validate everything before modifying the document.
pub fn save(
    content: &str,
    address: &str,
    play_mode: &str,
    creator_mode: &str,
    lan_ip: Option<&str>,
) -> Result<String, String> {
    let values = crate::environment::parse_env(content);
    if values.keys().any(|key| key.ends_with("_PUBLIC_ADDRESS_OVERRIDE")) {
        let mut independent = values;
        independent.insert("BOX_PLAY_NETWORK_MODE".into(), play_mode.into());
        independent.insert("BOX_CREATOR_NETWORK_MODE".into(), creator_mode.into());
        resolve_network(&independent, lan_ip)?;
        let mut result = independent_owner(content);
        set_env(&mut result, "BOX_PLAY_NETWORK_MODE", play_mode)?;
        set_env(&mut result, "BOX_CREATOR_NETWORK_MODE", creator_mode)?;
        return Ok(result);
    }
    let address = address.trim();
    let (host, scheme) = if address.is_empty() {
        if play_mode == "public" || creator_mode == "public" {
            return Err("公网模式请填写公网地址".into());
        }
        ("127.0.0.1".into(), "http")
    } else {
        parse_public_address(address, "公网地址")?
    };
    let network = resolve_network(
        &BTreeMap::from([
            ("BOX_PLAY_PUBLIC_HOST".into(), host.clone()),
            ("BOX_CREATOR_HOST".into(), host),
            ("BOX_PLAY_NETWORK_MODE".into(), play_mode.into()),
            ("BOX_CREATOR_NETWORK_MODE".into(), creator_mode.into()),
        ]),
        lan_ip,
    )?;
    let mut result = content.to_string();
    for (key, value) in [
        ("BOX_PUBLIC_ADDRESS", address),
        ("BOX_PUBLIC_SCHEME", scheme),
        ("BOX_PLAY_NETWORK_MODE", play_mode),
        ("BOX_CREATOR_NETWORK_MODE", creator_mode),
        ("BOX_PLAY_PUBLIC_HOST", network.play_host.as_str()),
        ("BOX_CREATOR_HOST", network.creator_host.as_str()),
    ] {
        set_env(&mut result, key, value)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::parse_env;

    #[test]
    fn save_local_lan_public_changes_real_hosts_without_losing_public_draft() {
        let original = "# preserve\nBOX_PLAY_PUBLIC_HOST=user.box3lab.com\nBOX_CREATOR_HOST=user.box3lab.com\nBOX_AUTH_PORTAL_IMAGE=my-login:1.0\n";
        let address = "https://user.box3lab.com";
        let local = save(original, address, "local", "local", None).unwrap();
        let values = parse_env(&local);
        assert_eq!(values["BOX_PLAY_PUBLIC_HOST"], "127.0.0.1");
        assert_eq!(values["BOX_CREATOR_HOST"], "127.0.0.1");
        assert_eq!(public_address(&values), address);
        let lan = save(&local, address, "lan", "lan", Some("192.168.1.20")).unwrap();
        let values = parse_env(&lan);
        assert_eq!(values["BOX_PLAY_PUBLIC_HOST"], "192.168.1.20");
        assert_eq!(values["BOX_CREATOR_HOST"], "192.168.1.20");
        let public = save(&lan, &public_address(&values), "public", "public", None).unwrap();
        let values = parse_env(&public);
        assert_eq!(values["BOX_PLAY_PUBLIC_HOST"], "user.box3lab.com");
        assert_eq!(values["BOX_CREATOR_HOST"], "user.box3lab.com");
        assert_eq!(values["BOX_AUTH_PORTAL_IMAGE"], "my-login:1.0");
        assert!(public.starts_with("# preserve\n"));
    }

    #[test]
    fn unavailable_lan_does_not_silently_reuse_public_domain() {
        assert!(save("", "http://user.box3lab.com", "lan", "lan", None).is_err());
        assert!(save("", "", "public", "public", None).is_err());
    }

    #[test]
    fn runtime_hosts_urls_and_scheme_match_the_saved_access_mode() {
        for (mode, expected, scheme) in [
            ("local", "127.0.0.1", "http"),
            ("lan", "192.168.1.20", "http"),
            ("public", "user.box3lab.com", "https"),
        ] {
            let saved = save(
                "",
                "https://user.box3lab.com",
                mode,
                mode,
                Some("192.168.1.20"),
            )
            .unwrap();
            let runtime = crate::configuration::runtime_environment(
                &parse_env(&saved),
                &crate::configuration::RuntimeInputs {
                    lan_ip: Some("192.168.1.20"),
                    image_tag: "0.2.0",
                    platform: "linux/arm64",
                    database_required: false,
                    web_manager: false,
                },
            )
            .unwrap();
            assert_eq!(runtime["BOX_PLAY_PUBLIC_HOST"], expected);
            assert_eq!(runtime["BOX_CREATOR_HOST"], expected);
            assert_eq!(runtime["BOX_PUBLIC_SCHEME"], scheme);
            assert_eq!(
                runtime["BOX_PLAY_PUBLIC_URL"],
                format!("{scheme}://{expected}:3121")
            );
            assert_eq!(
                runtime["BOX_CREATOR_PUBLIC_URL"],
                format!("{scheme}://{expected}:3127")
            );
            assert_eq!(
                runtime["BOX_BIND_IP"],
                if mode == "local" {
                    "127.0.0.1"
                } else {
                    "0.0.0.0"
                }
            );
        }
    }
}

#[cfg(test)]
mod independent_owner_tests {
    use super::*;
    #[test]
    fn individual_save_removes_shared_owner_hosts_and_migration_does_not_restore_them() {
        let source = "BOX_PLAY_NETWORK_MODE=public\nBOX_CREATOR_NETWORK_MODE=public\nBOX_PLAY_PUBLIC_HOST=old.example.test\nBOX_CREATOR_HOST=old.example.test\nBOX_PUBLIC_ADDRESS=https://old.example.test\nBOX_PUBLIC_SCHEME=https\nBOX_PLAY_PUBLIC_ADDRESS_OVERRIDE=https://play.example.test\nBOX_CREATOR_PUBLIC_ADDRESS_OVERRIDE=https://arena.example.test\n";
        let saved = save(source, "", "public", "public", None).unwrap();
        let migrated = crate::configuration_migration::migrate_document(&saved).unwrap();
        let values = crate::environment::parse_env(&migrated);
        assert!(!values.contains_key("BOX_PLAY_PUBLIC_HOST"));
        assert!(!values.contains_key("BOX_CREATOR_HOST"));
        assert!(!values.contains_key("BOX_PUBLIC_ADDRESS"));
        assert!(!values.contains_key("BOX_PUBLIC_SCHEME"));
        let network = resolve_network(&values, None).unwrap();
        assert_eq!(network.play_host, "play.example.test");
        assert_eq!(network.creator_host, "arena.example.test");
        assert_eq!(network.play_bind_ip, "0.0.0.0");
    }
}

/// Other settings pages must not rewrite network fields owned by external Nginx.
pub fn preserve_network(previous: &str, next: &str) -> Result<String, String> {
    let before = crate::environment::parse_env(previous);
    let after = crate::environment::parse_env(next);
    let network_key = |key: &str| {
        key.contains("_PUBLIC_") || key.ends_with("_NETWORK_MODE") || key.ends_with("_BASE_PATH") ||
        ["BOX_PUBLIC_ADDRESS", "BOX_PUBLIC_SCHEME", "BOX_CREATOR_HOST", "BOX_BIND_IP", "BOX_CREATOR_BIND_IP", "BOX_VOXA_BIND_IP", "BOX_PLAYER_LOGIN_URL", "BOX_PLAYER_LOGIN_URL_OVERRIDE", "BOX_PLAY_PORT", "BOX_CREATOR_PORT", "BOX_VOXA_PORT", "BOX_AUTH_PORTAL_PORT", "BOX_PLAYER_SERVICE_PORT"].contains(&key)
    };
    let mut output = next.to_string();
    for key in before.keys().chain(after.keys()).filter(|key| network_key(key)) {
        crate::environment::remove_env(&mut output,key);
        if let Some(value) = before.get(key) { set_env(&mut output,key,value)?; }
    }
    Ok(output)
}

#[cfg(test)]
mod external_network_tests {
    #[test]
    fn unrelated_save_preserves_operator_network_and_changes_database() {
        let before = "BOX_PLAY_NETWORK_MODE=public\nBOX_PLAY_PUBLIC_ADDRESS_OVERRIDE=https://example.test/play\nBOX_BIND_IP=127.0.0.1\nBOX_PLAY_PORT=4121\nBOX_DATABASE_NAME=old\n";
        let after = "BOX_PLAY_NETWORK_MODE=local\nBOX_PLAY_PUBLIC_ADDRESS_OVERRIDE=http://127.0.0.1\nBOX_PLAY_PORT=3121\nBOX_PUBLIC_ADDRESS=stale.test\nBOX_DATABASE_NAME=new\n";
        let result=super::preserve_network(before,after).unwrap();
        let values=crate::environment::parse_env(&result);
        assert_eq!(values["BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE"],"https://example.test/play");
        assert_eq!(values["BOX_PLAY_NETWORK_MODE"],"public");
        assert_eq!(values["BOX_BIND_IP"],"127.0.0.1");
        assert_eq!(values["BOX_PLAY_PORT"],"4121");
        assert_eq!(values["BOX_DATABASE_NAME"],"new");
        assert!(!values.contains_key("BOX_PUBLIC_ADDRESS"));
    }
}
