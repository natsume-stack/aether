//! Production and staging share behavior while keeping download scopes separate.
pub const PRODUCTION_BASE: &str = "https://assets.box3.fun/local-engine";
pub const STAGING_BASE: &str = "https://assets.box3.fun/local-engine-staging";

// ---------------------------------------------------------------------------
// Self-hosted mirrors (opt-in, audited).
//
// Default behaviour is unchanged: only the production base and the CI-pinned
// staging base are accepted, so a catalog that nobody reviewed cannot be
// redirected. Private deployments enable a mirror by exporting BOTH
//
//   BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE=1              (must be exactly "1")
//   BOX3_RELEASE_CDN_URL_ALLOWLIST=<base>[,<base>] (pinned exactly, no wildcard)
//
// and the base still has to pass [`valid_mirror_base`]: HTTPS for any routable
// host, cleartext HTTP only for a loopback / RFC1918 / link-local address
// literal. Credentials, query strings, fragments, ".." segments and any other
// scheme are rejected even with the opt-in set. These two variables are read at
// runtime, so the same binary works against the CDN or an intranet mirror.
// ---------------------------------------------------------------------------

fn custom_download_base_enabled() -> bool {
    std::env::var("BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE").is_ok_and(|value| value == "1")
}

fn mirror_allowlist() -> Vec<String> {
    std::env::var("BOX3_RELEASE_CDN_URL_ALLOWLIST")
        .unwrap_or_default()
        .split([',', ';', ' ', '\t', '\n', '\r'])
        .map(|entry| entry.trim_end_matches('/').to_owned())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// True when `base` is an explicitly pinned, well-formed self-hosted mirror.
pub fn self_hosted_base(base: &str) -> bool {
    if !custom_download_base_enabled() {
        return false;
    }
    let pinned = base.trim_end_matches('/');
    valid_mirror_base(pinned) && mirror_allowlist().iter().any(|entry| entry == pinned)
}

fn valid_mirror_base(base: &str) -> bool {
    let scheme = if let Some(rest) = base.strip_prefix("https://") {
        Some(("https", rest))
    } else {
        base.strip_prefix("http://").map(|rest| ("http", rest))
    };
    let Some((scheme, rest)) = scheme else {
        return false;
    };
    if rest.is_empty()
        || rest.contains("..")
        || rest.contains('@')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('\\')
        || rest.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return false;
    }
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    // Path segments are plain names only: no empty segment, no dot-dot.
    if !path.is_empty()
        && !path[1..].split('/').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'~'))
        })
    {
        return false;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port))
            if !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                && !authority[..authority.len() - port.len() - 1].contains(':') =>
        {
            (host, Some(port))
        }
        // Bracketed IPv6 literals are not used by the published mirrors.
        _ => (authority, None),
    };
    if host.is_empty() {
        return false;
    }
    if let Some(port) = port {
        let Ok(port) = port.parse::<u32>() else {
            return false;
        };
        if port == 0 || port > 65535 {
            return false;
        }
    }
    if host.as_bytes()[0].is_ascii_digit() {
        let octets: Vec<&str> = host.split('.').collect();
        if octets.len() != 4 {
            return false;
        }
        let mut values = [0u32; 4];
        for (index, octet) in octets.iter().enumerate() {
            if octet.len() > 1 && octet.starts_with('0') {
                return false;
            }
            if !octet.bytes().all(|byte| byte.is_ascii_digit()) {
                return false;
            }
            let Ok(value) = octet.parse::<u32>() else {
                return false;
            };
            if value > 255 {
                return false;
            }
            values[index] = value;
        }
        if scheme == "http" {
            let private = values[0] == 10
                || values[0] == 127
                || (values[0] == 169 && values[1] == 254)
                || (values[0] == 172 && (16..=31).contains(&values[1]))
                || (values[0] == 192 && values[1] == 168);
            if !private {
                return false;
            }
        }
        return true;
    }
    if host == "localhost" {
        return true;
    }
    host.split('.').all(|label| {
        let bytes = label.as_bytes();
        !bytes.is_empty()
            && bytes.first().is_some_and(|b| b.is_ascii_alphabetic())
            && bytes.last().is_some_and(|b| b.is_ascii_alphanumeric())
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
    })
}

pub fn is_dev(version: &str) -> bool {
    version.ends_with("-dev") || version.ends_with(".dev")
}

pub fn is_staging(version: &str) -> bool {
    version.ends_with("-staging") || version.ends_with(".staging")
}

pub fn release_base(version: &str) -> &'static str {
    if is_staging(version) {
        STAGING_BASE
    } else {
        PRODUCTION_BASE
    }
}

fn valid_version(version: &str) -> bool {
    let base = version.strip_suffix("-staging").unwrap_or(version);
    let parts: Vec<_> = base.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 9
                && (part.len() == 1 || !part.starts_with('0'))
                && part.bytes().all(|b| b.is_ascii_digit())
        })
}

pub fn image_download_url(base: Option<&str>, archive: &str) -> Result<String, String> {
    let base = base.unwrap_or(PRODUCTION_BASE);
    if base != PRODUCTION_BASE && !self_hosted_base(base) {
        // Not an explicitly pinned mirror: keep the original staging-only rule,
        // which accepts nothing outside the CDN scopes and never falls back.
        let pinned = base
            .strip_prefix(&format!("{STAGING_BASE}/v"))
            .ok_or("镜像下载来源无效")?;
        let (version, commit) = pinned.split_once('/').ok_or("预发布镜像来源缺少提交号")?;
        if !is_staging(version)
            || !valid_version(version)
            || commit.len() != 40
            || !commit.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("预发布镜像下载来源无效".into());
        }
    }
    if archive.is_empty()
        || archive.contains("..")
        || !archive
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err("镜像归档名称无效".into());
    }
    Ok(format!("{base}/{archive}"))
}

pub fn valid_installer_url(url: &str, current_version: &str) -> bool {
    if is_dev(current_version) {
        return false;
    }
    // The official channel scope stays the default. Pinned mirrors are only
    // consulted once the operator has opted in, and a mirror that is not a
    // well-formed base is ignored rather than trusted.
    let mut bases = vec![release_base(current_version).to_owned()];
    if custom_download_base_enabled() {
        bases.extend(
            mirror_allowlist()
                .into_iter()
                .filter(|base| valid_mirror_base(base)),
        );
    }
    bases.iter().any(|base| {
        let Some(name) = url.strip_prefix(&format!("{base}/BOX-Local-Engine-")) else {
            return false;
        };
        [
            "windows-amd64",
            "windows-arm64",
            "macos-arm64",
            "linux-amd64",
            "linux-arm64",
        ]
        .iter()
        .any(|target| {
            let Some(version) = name.strip_suffix(&format!("-{target}.zip")) else {
                return false;
            };
            valid_version(version) && is_staging(version) == is_staging(current_version)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dev_installers_cannot_download_online_updates() {
        for version in ["2026.1.4-dev", "2026.1.4-beta.1.dev"] {
            assert!(is_dev(version));
            assert!(!valid_installer_url(
                &format!("{PRODUCTION_BASE}/BOX-Local-Engine-2026.1.5-macos-arm64.zip"),
                version,
            ));
            assert!(!valid_installer_url(
                &format!("{STAGING_BASE}/BOX-Local-Engine-2026.1.5-staging-macos-arm64.zip"),
                version,
            ));
        }
    }
    #[test]
    fn channels_cannot_download_each_others_installers() {
        let stable = format!("{PRODUCTION_BASE}/BOX-Local-Engine-0.4.0-macos-arm64.zip");
        let staging = format!("{STAGING_BASE}/BOX-Local-Engine-0.4.0-staging-macos-arm64.zip");
        assert!(valid_installer_url(&stable, "0.3.0"));
        assert!(!valid_installer_url(&staging, "0.3.0"));
        assert!(valid_installer_url(&staging, "0.3.0-staging"));
        assert!(!valid_installer_url(&stable, "0.3.0-staging"));
        assert!(!valid_installer_url(
            &(staging + "?next=production"),
            "0.3.0-staging"
        ));
    }
    #[test]
    fn staging_image_sources_are_pinned_without_fallback() {
        let base = format!("{STAGING_BASE}/v0.3.0-staging/{}", "a".repeat(40));
        assert_eq!(
            image_download_url(Some(&base), "image.tar.gz").unwrap(),
            format!("{base}/image.tar.gz")
        );
        for invalid in [
            STAGING_BASE,
            "https://evil.test/local-engine",
            "https://assets.box3.fun/local-engine-staging/v0.3.0-staging/../production",
        ] {
            assert!(image_download_url(Some(invalid), "image.tar.gz").is_err());
        }
        assert!(image_download_url(Some(&base), "../image.tar.gz").is_err());
    }

    #[test]
    fn self_hosted_base_is_inert_without_the_explicit_opt_in() {
        // Nothing in the environment: the exact behaviour the shipped binaries
        // have always had. Kept in one test because it mutates process env.
        for (key, _) in [
            ("BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE", ""),
            ("BOX3_RELEASE_CDN_URL_ALLOWLIST", ""),
        ] {
            std::env::remove_var(key);
        }
        assert!(!self_hosted_base("http://192.168.1.20:8080/local-engine"));
        assert!(image_download_url(
            Some("http://192.168.1.20:8080/local-engine"),
            "image.tar.gz"
        )
        .is_err());
        // Opt-in alone is not enough: the base has to be pinned exactly.
        std::env::set_var("BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE", "1");
        std::env::remove_var("BOX3_RELEASE_CDN_URL_ALLOWLIST");
        assert!(!self_hosted_base("http://192.168.1.20:8080/local-engine"));
        assert!(image_download_url(
            Some("http://192.168.1.20:8080/local-engine"),
            "image.tar.gz"
        )
        .is_err());
        // Pinned: accepted, and the archive is appended verbatim.
        std::env::set_var(
            "BOX3_RELEASE_CDN_URL_ALLOWLIST",
            "http://192.168.1.20:8080/local-engine",
        );
        assert!(self_hosted_base("http://192.168.1.20:8080/local-engine"));
        assert_eq!(
            image_download_url(
                Some("http://192.168.1.20:8080/local-engine"),
                "image.tar.gz"
            )
            .unwrap(),
            "http://192.168.1.20:8080/local-engine/image.tar.gz"
        );
        assert!(image_download_url(
            Some("http://192.168.1.20:8080/local-engine"),
            "../image.tar.gz"
        )
        .is_err());
        // Not pinned, or pinned but malformed, or cleartext to a routable host.
        for rejected in [
            "http://10.99.0.7/local-engine",
            "http://evil.test/local-engine",
            "https://203.0.113.9:8080/local-engine",
            "javascript:alert(1)",
            "http://192.168.1.20:8080/local-engine/../etc",
            "http://192.168.1.20@evil.test/local-engine",
            "http://192.168.1.20:8080/local-engine?next=evil",
            "http://192.168.1.20:99999/local-engine",
            "http://010.0.0.1/local-engine",
            "",
        ] {
            assert!(
                image_download_url(Some(rejected), "image.tar.gz").is_err(),
                "{rejected} must stay rejected"
            );
        }
        // HTTPS mirrors are accepted once pinned, including path prefixes.
        std::env::set_var(
            "BOX3_RELEASE_CDN_URL_ALLOWLIST",
            "https://mirror.intranet.example/box3/local-engine, https://10.0.0.8:8443/mirrors/b3",
        );
        assert!(self_hosted_base("https://mirror.intranet.example/box3/local-engine"));
        assert!(self_hosted_base("https://10.0.0.8:8443/mirrors/b3"));
        assert!(!self_hosted_base("https://mirror.intranet.example/box3/other"));
        assert!(!self_hosted_base("https://mirror.intranet.example/box3/local-engine/../other"));
        std::env::remove_var("BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE");
        std::env::remove_var("BOX3_RELEASE_CDN_URL_ALLOWLIST");
    }
}
