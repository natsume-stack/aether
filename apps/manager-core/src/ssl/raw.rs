//! Operator-edited managed Nginx configuration with validation and reload.
use super::runtime::{call, mount, name, owned, private, provider, replace};
use super::*;
use std::{fs, path::Path};
type Docker<'a> = dyn FnMut(&[String]) -> Result<String, String> + 'a;

const ACTIVE: &str = "https/nginx.conf";
const PENDING: &str = "https/nginx.raw-pending.conf";

/// Read the managed configuration that the built-in entry currently uses.
pub fn read_raw_nginx_config(root: &Path) -> Result<String, String> {
    let path = root.join(ACTIVE);
    if !path.is_file() {
        return Err("当前没有内置 Nginx 配置".into());
    }
    fs::read_to_string(&path).map_err(|error| format!("无法读取内置 Nginx 配置：{error}"))
}

/// Validate the edited text, then replace the live configuration and reload a
/// running managed entry. The live file stays untouched when validation fails.
/// Returns whether a running entry was reloaded; a stopped entry picks the new
/// configuration up on its next start.
pub fn save_raw_nginx_config(
    root: &Path,
    host_root: &Path,
    content: &str,
    docker: &mut Docker<'_>,
) -> Result<bool, String> {
    if content.trim().is_empty() {
        return Err("Nginx 配置不能为空".into());
    }
    let active = root.join(ACTIVE);
    if !active.is_file() {
        return Err("当前没有内置 Nginx 配置".into());
    }
    if provider(root, None) != "managed" {
        return Err("外部 Nginx 由你维护，启动器不能保存内置配置".into());
    }
    let pending = root.join(PENDING);
    if pending.exists() {
        fs::remove_file(&pending).map_err(|error| error.to_string())?;
    }
    private(&pending, content)?;
    let bind = mount(host_root)?;
    let validation = call(
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
            "/etc/box-https/nginx.raw-pending.conf",
        ],
    );
    let _ = fs::remove_file(&pending);
    validation.map_err(|error| format!("Nginx 配置校验失败，已保留原配置：{error}"))?;
    let previous = fs::read_to_string(&active).map_err(|error| error.to_string())?;
    replace(&active, content)?;
    if owned(root, docker)? != Some(true) {
        return Ok(false);
    }
    if let Err(error) = call(
        docker,
        &[
            "exec",
            &name(root),
            "nginx",
            "-t",
            "-c",
            "/etc/box-https/nginx.conf",
        ],
    ) {
        replace(&active, &previous)?;
        let _ = call(
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
        );
        return Err(format!("内置 Nginx 拒绝了新配置，已恢复原配置：{error}"));
    }
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
    )
    .map_err(|error| format!("配置已保存并通过校验，但重载失败：{error}"))?;
    Ok(true)
}
