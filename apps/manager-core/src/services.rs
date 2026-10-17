//! Service policy and sequencing. Hosts supply Docker, image acquisition and
//! configuration; neither transport owns a second startup workflow.
use serde::Serialize;

pub const APPLICATION_SERVICES: [&str; 5] = [
    "creator",
    "voxa",
    "play",
    "player-service",
    "player-auth-portal",
];
pub const MANAGED_SERVICES: [&str; 2] = ["managed-postgres", "managed-redis"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads: Option<Vec<ImageDownloadProgress>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDownloadProgress {
    pub image: String,
    pub bytes: u64,
    pub total: u64,
    pub percent: u8,
}

impl InstallProgress {
    /// One presentation contract for both native events and WebSocket events.
    pub fn for_downloads(mut downloads: Vec<ImageDownloadProgress>) -> Self {
        for row in &mut downloads {
            if APPLICATION_SERVICES.contains(&row.image.as_str()) {
                row.image = format!("box-local-engine-{}", row.image);
            }
        }
        downloads.sort_by_key(|row| APPLICATION_SERVICES.iter().position(|service| row.image == format!("box-local-engine-{service}")).unwrap_or(usize::MAX));
        let count = downloads.len();
        let complete = downloads.iter().filter(|row| row.percent == 100).count();
        let (bytes, total) = downloads.iter().fold((0u64, 0u64), |sum, row| (sum.0.saturating_add(row.bytes), sum.1.saturating_add(row.total)));
        Self { stage: "image-download".into(), message: format!("{count} 个镜像 · 已完成 {complete}/{count}"), percent: if complete == count { 100 } else { (bytes.saturating_mul(100) / total.max(1)).min(99) as u8 }, downloads: Some(downloads) }
    }
}

pub trait Runtime {
    fn prepare_images(&self, services: &[&str]) -> Result<(), String>;
    fn managed_enabled(&self, service: &str) -> bool;
    fn check_managed(&self, service: &str) -> Result<(), String>;
    fn compose(&self, args: &[&str]) -> Result<(), String>;
    fn progress(&self, stage: &str, message: &str, percent: u8);
}

pub fn scope_services(scope: &str) -> Result<&'static [&'static str], String> {
    match scope {
        "all" => Ok(&APPLICATION_SERVICES),
        "creator" => Ok(&["creator", "voxa", "player-service", "player-auth-portal"]),
        "play" => Ok(&["play", "player-service", "player-auth-portal"]),
        _ => Err("未知启动范围，只能选择全部服务、创作端或游玩端".into()),
    }
}

/// One-shot storage ownership jobs must run before their application, but
/// applications must not follow Compose `depends_on` from inside the Web
/// manager: that graph includes server-manager itself.
fn storage_initializers(services: &[&str]) -> Vec<&'static str> {
    [
        ("creator", "creator-storage-init"),
        ("play", "play-storage-init"),
        ("voxa", "voxa-storage-init"),
    ]
    .into_iter()
    .filter_map(|(service, initializer)| services.contains(&service).then_some(initializer))
    .collect()
}

fn start_applications(runtime: &impl Runtime, services: &[&str]) -> Result<(), String> {
    for initializer in storage_initializers(services) {
        // Run the ownership job in the foreground. Compose `wait` rejects an
        // already-exited one-shot container; `--exit-code-from` preserves the
        // job's actual exit status without following server-manager.
        runtime.compose(&[
            "up",
            "--no-build",
            "--no-deps",
            "--exit-code-from",
            initializer,
            initializer,
        ])?;
    }
    let mut args = vec!["up", "-d", "--no-build", "--no-deps"];
    if services == ["player-auth-portal"] {
        args.extend_from_slice(&["--wait", "--wait-timeout", "90"]);
    }
    args.extend_from_slice(services);
    runtime.compose(&args)
}

pub fn start(runtime: &impl Runtime, scope: &str) -> Result<(), String> {
    // Validate before touching images or containers.
    let targets = scope_services(scope)?;
    runtime.progress("images", "正在检查运行镜像…", 20);
    runtime.prepare_images(targets)?;
    for (service, stage, label, percent) in [
        (
            "managed-postgres",
            "database",
            "正在启动内置 PostgreSQL…",
            45,
        ),
        ("managed-redis", "redis", "正在启动内置 Redis…", 52),
    ] {
        if runtime.managed_enabled(service) {
            runtime.check_managed(service)?;
            runtime.progress(stage, label, percent);
            runtime.compose(&["up", "-d", "--no-build", "--wait", service])?;
        }
    }
    runtime.progress("start", "正在启动服务…", 65);
    start_applications(runtime, targets)?;
    runtime.progress("complete", "服务已启动", 100);
    Ok(())
}

pub fn control(runtime: &impl Runtime, service: &str, action: &str) -> Result<(), String> {
    let managed = MANAGED_SERVICES.contains(&service);
    if (!APPLICATION_SERVICES.contains(&service) && !managed)
        || !["start", "stop", "restart"].contains(&action)
    {
        return Err("操作名称或服务名称无效".into());
    }
    if managed {
        runtime.check_managed(service)?;
    }
    if action == "start" {
        if managed {
            runtime.compose(&["up", "-d", "--no-build", "--wait", service])?;
        } else {
            runtime.prepare_images(&[service])?;
            start_applications(runtime, &[service])?;
        }
    } else {
        runtime.compose(&[action, service])?;
    }
    runtime.progress("complete", "服务操作已完成", 100);
    Ok(())
}

pub fn stop(runtime: &impl Runtime) -> Result<(), String> {
    let mut args = vec!["stop"];
    args.extend_from_slice(&APPLICATION_SERVICES);
    args.extend_from_slice(&MANAGED_SERVICES);
    runtime.compose(&args)?;
    runtime.progress("complete", "服务已停止", 100);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<Vec<String>>>,
        prepared_images: RefCell<Vec<Vec<String>>>,
        dependency_fails: bool,
    }
    impl Runtime for Fake {
        fn prepare_images(&self, services: &[&str]) -> Result<(), String> {
            self.calls.borrow_mut().push(vec!["images".into()]);
            self.prepared_images
                .borrow_mut()
                .push(services.iter().map(|service| (*service).into()).collect());
            Ok(())
        }
        fn managed_enabled(&self, _: &str) -> bool {
            true
        }
        fn check_managed(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn compose(&self, args: &[&str]) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            if self.dependency_fails && args.contains(&"managed-postgres") {
                Err("database not ready".into())
            } else {
                Ok(())
            }
        }
        fn progress(&self, _: &str, _: &str, _: u8) {}
    }
    #[test]
    fn invalid_scope_and_action_have_no_side_effects() {
        let host = Fake::default();
        assert!(start(&host, "invalid").is_err());
        assert!(control(&host, "unknown", "start").is_err());
        assert!(control(&host, "creator", "unknown").is_err());
        assert!(host.calls.borrow().is_empty());
    }
    #[test]
    fn applying_login_image_prepares_it_and_recreates_only_the_healthy_portal() {
        let host = Fake {
            ..Fake::default()
        };
        control(&host, "player-auth-portal", "start").unwrap();
        let calls = host.calls.borrow();
        assert_eq!(calls[0], ["images"]);
        assert_eq!(
            calls[1],
            [
                "up",
                "-d",
                "--no-build",
                "--no-deps",
                "--wait",
                "--wait-timeout",
                "90",
                "player-auth-portal"
            ]
        );
        assert_eq!(calls.len(), 2);
    }
    #[test]
    fn dependencies_are_ready_before_selected_apps_are_started() {
        let host = Fake {
            ..Fake::default()
        };
        start(&host, "play").unwrap();
        assert_eq!(
            host.prepared_images.borrow()[0],
            ["play", "player-service", "player-auth-portal"]
        );
        let calls = host.calls.borrow();
        assert_eq!(
            calls[1],
            ["up", "-d", "--no-build", "--wait", "managed-postgres"]
        );
        assert_eq!(calls[2].last().unwrap(), "managed-redis");
        assert_eq!(
            calls[4],
            [
                "up",
                "-d",
                "--no-build",
                "--no-deps",
                "play",
                "player-service",
                "player-auth-portal"
            ]
        );
    }
    #[test]
    fn starting_apps_never_recreates_the_web_manager_dependency() {
        let host = Fake {
            ..Fake::default()
        };
        start(&host, "creator").unwrap();
        let calls = host.calls.borrow();
        let application_start = calls.last().unwrap();
        assert!(!application_start.contains(&"--force-recreate".into()));
        assert!(!application_start.contains(&"--remove-orphans".into()));
        assert!(application_start.contains(&"--no-deps".into()));
    }
    #[test]
    fn starting_one_app_never_recreates_the_web_manager_dependency() {
        let host = Fake {
            ..Fake::default()
        };
        control(&host, "creator", "start").unwrap();
        assert_eq!(host.prepared_images.borrow()[0], ["creator"]);
        let calls = host.calls.borrow();
        assert_eq!(calls[2], ["up", "-d", "--no-build", "--no-deps", "creator"]);
    }
    #[test]
    fn starting_creator_runs_its_initializer_then_starts_without_dependencies() {
        let host = Fake {
            ..Fake::default()
        };
        start(&host, "creator").unwrap();
        let calls = host.calls.borrow();
        assert_eq!(
            calls[3],
            [
                "up",
                "--no-build",
                "--no-deps",
                "--exit-code-from",
                "creator-storage-init",
                "creator-storage-init",
            ]
        );
        assert!(calls[5].contains(&"--no-deps".into()));
    }
    #[test]
    fn failed_dependency_never_starts_applications() {
        let host = Fake {
            dependency_fails: true,
            ..Fake::default()
        };
        assert!(start(&host, "all").is_err());
        assert_eq!(host.calls.borrow().len(), 2);
    }
    #[test]
    fn stop_does_not_stop_the_manager() {
        let host = Fake::default();
        stop(&host).unwrap();
        let calls = host.calls.borrow();
        assert_eq!(calls[0].len(), 8);
        assert!(!calls[0].iter().any(|name| name == "server-manager"));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub name: String,
    pub enabled: bool,
    pub running: bool,
    pub state: String,
}

pub fn enabled(service: &str, values: &std::collections::BTreeMap<String, String>) -> bool {
    match service {
        "managed-postgres" => values
            .get("BOX_DATABASE_MODE")
            .is_some_and(|mode| mode == "managed"),
        "managed-redis" => values
            .get("BOX_REDIS_MODE")
            .is_some_and(|mode| mode == "managed"),
        name => APPLICATION_SERVICES.contains(&name),
    }
}

pub fn compose_rows(output: &str) -> Vec<serde_json::Value> {
    serde_json::from_str::<Vec<serde_json::Value>>(output).unwrap_or_else(|_| {
        output
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    })
}

pub fn statuses(
    output: &str,
    values: &std::collections::BTreeMap<String, String>,
) -> Vec<ServiceStatus> {
    let rows = compose_rows(output);
    APPLICATION_SERVICES
        .iter()
        .chain(MANAGED_SERVICES.iter())
        .map(|name| {
            let row = rows.iter().find(|row| {
                row.get("Service")
                    .or_else(|| row.get("service"))
                    .and_then(serde_json::Value::as_str)
                    == Some(name)
            });
            let state = row
                .and_then(|row| row.get("State").or_else(|| row.get("state")))
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("stopped")
                .to_ascii_lowercase();
            ServiceStatus {
                name: (*name).into(),
                enabled: enabled(name, values),
                running: state == "running",
                state,
            }
        })
        .collect()
}

#[cfg(test)]
mod status_tests {
    use super::*;
    use std::collections::BTreeMap;
    #[test]
    fn array_and_json_lines_report_identical_services_without_raw_profiles() {
        let mut env = BTreeMap::new();
        env.insert("BOX_DATABASE_MODE".into(), "managed".into());
        let array = r#"[{"Service":"creator","State":"running"},{"service":"managed-postgres","state":"RUNNING"}]"#;
        let lines = "{\"Service\":\"creator\",\"State\":\"running\"}\n{\"service\":\"managed-postgres\",\"state\":\"RUNNING\"}";
        let a = statuses(array, &env);
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::to_value(statuses(lines, &env)).unwrap()
        );
        assert!(a.iter().find(|s| s.name == "creator").unwrap().running);
        assert!(a.iter().find(|s| s.name == "play").unwrap().enabled);
        assert!(
            !a.iter()
                .find(|s| s.name == "managed-redis")
                .unwrap()
                .enabled
        );
        assert_eq!(a.len(), 7);
    }
}

/// Inspection and stopping must work even when owner configuration is invalid.
/// Select already-created containers by Compose labels, never by an env file.
/// The manager container is excluded from both the inventory and stop targets.
pub fn control_existing(
    args: &[&str],
    project_name: &str,
    docker: impl Fn(&[&str]) -> Result<String, String>,
) -> Option<Result<String, String>> {
    if !matches!(args.first(), Some(&"ps") | Some(&"stop")) {
        return None;
    }
    Some((|| {
        let output = docker(&[
            "ps",
            "--all",
            "--filter",
            &format!("label=com.docker.compose.project={project_name}"),
            "--format",
            "{{json .}}",
        ])?;
        let mut rows = Vec::new();
        for mut row in compose_rows(&output) {
            let service = row
                .get("Labels")
                .and_then(serde_json::Value::as_str)
                .and_then(|labels| {
                    labels
                        .split(',')
                        .find_map(|item| item.strip_prefix("com.docker.compose.service="))
                })
                .map(str::to_string);
            if let Some(service) = service.filter(|s| {
                APPLICATION_SERVICES.contains(&s.as_str()) || MANAGED_SERVICES.contains(&s.as_str())
            }) {
                row["Service"] = serde_json::Value::String(service);
                rows.push(row);
            }
        }
        if args[0] == "ps" {
            return serde_json::to_string(&rows).map_err(|e| e.to_string());
        }
        let ids = rows
            .iter()
            .filter(|row| {
                args.len() == 1
                    || row
                        .get("Service")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|s| args[1..].contains(&s))
            })
            .filter_map(|row| row.get("ID").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(String::new());
        }
        let mut stop = vec!["stop"];
        stop.extend(ids);
        docker(&stop)
    })())
}

#[cfg(test)]
mod existing_tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn invalid_configuration_cannot_prevent_stop_or_include_the_manager() {
        let calls = RefCell::new(Vec::new());
        let result = control_existing(&["stop", "creator", "play"], "box-local-engine", |args| {
            calls.borrow_mut().push(args.iter().map(|s|s.to_string()).collect::<Vec<_>>());
            if args[0]=="ps" { Ok(concat!(
                "{\"ID\":\"creator-id\",\"State\":\"running\",\"Labels\":\"com.docker.compose.service=creator\"}\n",
                "{\"ID\":\"manager-id\",\"State\":\"running\",\"Labels\":\"com.docker.compose.service=server-manager\"}").into()) }
            else { Ok(String::new()) }
        }).unwrap();
        assert!(result.is_ok());
        assert_eq!(calls.borrow()[1], ["stop", "creator-id"]);
    }
    #[test]
    fn inspection_errors_are_not_empty_inventories() {
        assert_eq!(
            control_existing(&["ps"], "box-local-engine", |_| Err(
                "daemon unavailable".into()
            ))
            .unwrap()
            .unwrap_err(),
            "daemon unavailable"
        );
    }
}
