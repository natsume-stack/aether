//! Managed Nginx container arguments and listener ports.
use super::runtime::{call, identity, name};
use super::*;
use std::path::Path;
type Docker<'a> = dyn FnMut(&[String]) -> Result<String, String> + 'a;

pub(super) fn ports(settings: &Settings) -> std::collections::BTreeSet<u16> {
    settings
        .routes
        .iter()
        .map(|route| {
            route.port.unwrap_or(if route.secure {
                settings.https_port
            } else {
                80
            })
        })
        .collect()
}
/// Docker bindings include both the public port and Nginx's internal listener.
/// A protocol change can retain the public port while changing the listener.
pub(super) fn bindings(settings: &Settings) -> std::collections::BTreeSet<(u16, u16)> {
    settings
        .routes
        .iter()
        .map(|route| {
            let internal = route.port.unwrap_or(if route.secure { 443 } else { 80 });
            let public = route.port.unwrap_or(if route.secure {
                settings.https_port
            } else {
                80
            });
            (public, internal)
        })
        .collect()
}
pub(super) fn run_proxy(
    root: &Path,
    network: &str,
    bind: &str,
    settings: &Settings,
    docker: &mut Docker<'_>,
) -> Result<(), String> {
    let mut args = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        name(root),
        "--label".into(),
        format!("box.https.owner={}", identity(root)),
        "--restart".into(),
        "unless-stopped".into(),
        "--network".into(),
        network.into(),
        "--mount".into(),
        bind.into(),
    ];
    for (public, internal) in bindings(settings) {
        args.extend(["-p".into(), format!("{public}:{internal}")]);
    }
    args.extend([
        IMAGE.into(),
        "nginx".into(),
        "-g".into(),
        "daemon off;".into(),
        "-c".into(),
        "/etc/box-https/nginx.conf".into(),
    ]);
    docker(&args)?;
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
    // Container creation can race the master's initial config read on a bind
    // mount. Confirm actual listeners, retrying graceful reload while it starts.
    let listeners = bindings(settings)
        .into_iter()
        .map(|(_, internal)| internal.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    let probe = format!(
        "for port in {listeners}; do (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null || exit 1; done"
    );
    for _ in 0..30 {
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
        std::thread::sleep(std::time::Duration::from_millis(100));
        if call(docker, &["exec", &name(root), "bash", "-c", &probe]).is_ok() {
            return Ok(());
        }
    }
    Err("Nginx 配置已校验，但新入口监听未就绪".into())
}
