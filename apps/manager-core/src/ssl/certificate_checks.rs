//! Validate certificate dates, covered hosts and private-key ownership.
use super::{
    runtime::{call, Docker},
    Settings, IMAGE,
};
use std::path::Path;

pub(super) fn openssl_command() -> std::process::Command {
    #[cfg(target_os = "macos")]
    for path in [
        "/opt/homebrew/opt/openssl@3/bin/openssl",
        "/usr/local/opt/openssl@3/bin/openssl",
    ] {
        if Path::new(path).is_file() {
            return std::process::Command::new(path);
        }
    }
    std::process::Command::new("openssl")
}
pub(super) fn check_local_key(staging: &Path, certificate: &str, key: &str) -> Result<(), String> {
    let public = |args: &[&str], file: &str| -> Result<Vec<u8>, String> {
        let output = openssl_command()
            .args(args)
            .arg(staging.join(file))
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("证书或私钥无法读取".into());
        }
        Ok(output.stdout)
    };
    if public(&["x509", "-pubkey", "-noout", "-in"], certificate)?
        != public(&["pkey", "-pubout", "-in"], key)?
    {
        return Err("证书与私钥不匹配".into());
    }
    Ok(())
}
pub(super) fn check_cert(
    docker: &mut Docker<'_>,
    bind: &str,
    revision: &str,
    settings: &Settings,
    certificate_file: &str,
    staging: &Path,
    require_valid: bool,
) -> Result<String, String> {
    let cert = format!("/etc/box-https/revisions/{revision}/{certificate_file}");
    let mut check = |args: &[&str]| {
        if settings.mode == "external" {
            let output = openssl_command()
                .args(["x509", "-in"])
                .arg(staging.join(certificate_file))
                .args(args)
                .output()
                .map_err(|_| {
                    "外部 Nginx 模式需在管理端安装支持 -checkhost 的 OpenSSL".to_string()
                })?;
            if !output.status.success() {
                return Err("OpenSSL 证书校验失败".into());
            }
            return Ok(String::from_utf8_lossy(&output.stdout).into());
        }
        let mut command = vec![
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            bind,
            IMAGE,
            "openssl",
            "x509",
            "-in",
            &cert,
        ];
        command.extend(args);
        call(docker, &command)
    };
    if require_valid {
        check(&["-noout", "-checkend", "0"]).map_err(|_| "证书已过期或无法读取".to_string())?;
        for route in &settings.routes {
            let output = check(&[
                "-noout",
                if route.domain.parse::<std::net::IpAddr>().is_ok() {
                    "-checkip"
                } else {
                    "-checkhost"
                },
                &route.domain,
            ])
            .map_err(|_| format!("证书未覆盖域名 {}", route.domain))?;
            if !output.contains("does match certificate") {
                return Err(format!("证书未覆盖域名 {}", route.domain));
            }
        }
    }
    let dates = check(&["-noout", "-startdate", "-enddate"])?;
    let parse = |prefix: &str| -> Result<chrono::DateTime<chrono::Utc>, String> {
        let value = dates
            .lines()
            .find_map(|l| l.strip_prefix(prefix))
            .ok_or("无法读取证书有效期")?;
        let date = chrono::NaiveDateTime::parse_from_str(value.trim(), "%b %e %H:%M:%S %Y GMT")
            .map_err(|_| "证书有效期格式无效")?;
        Ok(date.and_utc())
    };
    if require_valid && parse("notBefore=")? > chrono::Utc::now() {
        return Err("证书尚未生效".into());
    }
    Ok(parse("notAfter=")?.to_rfc3339())
}
