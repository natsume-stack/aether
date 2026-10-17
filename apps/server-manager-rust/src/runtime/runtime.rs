//! Isolated Play map runtime lifecycle.
//!
//! This module owns the small HTTP interface used by the Play Library and
//! hides Docker argument construction, runtime authentication, metrics and
//! cleanup behind it. The main application only wires these handlers into the
//! router.

use crate::*;

const RUNTIME_COMPOSE_PROJECT: &str = "box-local-engine-runtime";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeEnsureRequest {
    pub(crate) permanent_map_id: String,
    pub(crate) mode: String,
    pub(crate) project_id: String,
    pub(crate) room_id: Option<String>,
    pub(crate) cpu_milli: Option<u32>,
    pub(crate) memory_mb: Option<u32>,
    pub(crate) process_limit: Option<u32>,
    pub(crate) network_policy: Option<String>,
    pub(crate) bandwidth_mbps: Option<u32>,
    pub(crate) player_limit: u32,
    pub(crate) idle_timeout_ms: u64,
    pub(crate) teleport_control_url: String,
    pub(crate) teleport_internal_token: String,
}

/// Accepts only the private scheduler credential shared with Play. This is
/// intentionally separate from the browser management token.
fn runtime_auth(headers: &HeaderMap, app: &App) -> Result<(), Response> {
    let got = headers
        .get("x-box-runtime-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if got.len() == app.runtime_token.len()
        && got
            .as_bytes()
            .iter()
            .zip(app.runtime_token.as_bytes())
            .fold(0u8, |a, (x, y)| a | (x ^ y))
            == 0
    {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(Error {
                message: "运行时调度凭证无效".into(),
            }),
        )
            .into_response())
    }
}

pub(crate) fn runtime_container_name(request: &RuntimeEnsureRequest) -> Result<String, String> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 63
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    };
    if !valid(&request.permanent_map_id)
        || !valid(&request.project_id)
        || request.mode != "play"
        || request
            .room_id
            .as_deref()
            .is_some_and(|value| !valid(value))
    {
        return Err("地图运行时标识无效".into());
    }
    if request
        .cpu_milli
        .is_some_and(|value| !(1..=128_000).contains(&value))
        || request
            .memory_mb
            .is_some_and(|value| !(64..=1_048_576).contains(&value))
        || request
            .process_limit
            .is_some_and(|value| !(16..=4_096).contains(&value))
        || request
            .bandwidth_mbps
            .is_some_and(|value| !(1..=100_000).contains(&value))
        || request
            .network_policy
            .as_deref()
            .is_some_and(|value| value != "unrestricted" && value != "private")
    {
        return Err("地图运行时资源限制无效".into());
    }
    if !(1..=10_000).contains(&request.player_limit)
        || !(1_000..=604_800_000).contains(&request.idle_timeout_ms)
        || request.teleport_control_url != "http://play:9966/__local_teleport"
        || request.teleport_internal_token.len() < 32
    {
        return Err("地图运行时参数无效".into());
    }
    Ok(format!(
        "box-runtime-{}-{}{}",
        request.mode,
        request.permanent_map_id,
        request
            .room_id
            .as_ref()
            .map(|room| format!("-{room}"))
            .unwrap_or_default()
    ))
}

/// Gives dynamic `docker run` containers a distinct Compose-style group and a
/// searchable service name in Docker Desktop: `play-地图ID-房间号`.
pub(crate) fn runtime_compose_labels(request: &RuntimeEnsureRequest) -> [String; 2] {
    let room = request.room_id.as_deref().unwrap_or("public");
    [
        format!("com.docker.compose.project={RUNTIME_COMPOSE_PROJECT}"),
        format!(
            "com.docker.compose.service=play-{}-{room}",
            request.permanent_map_id
        ),
    ]
}

fn runtime_container_address(name: &str) -> Result<String, String> {
    let address = docker(&[
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        name,
    ])?;
    let address = address.trim();
    if address.parse::<std::net::IpAddr>().is_err() {
        return Err(format!("无法获取地图运行时容器地址：{name}"));
    }
    Ok(address.into())
}

fn runtime_network() -> Result<String, String> {
    if let Ok(configured) = env::var("BOX_RUNTIME_DOCKER_NETWORK") {
        if !configured.trim().is_empty() {
            return Ok(configured);
        }
    }
    let container_id = fs::read_to_string("/etc/hostname")
        .map_err(|error| format!("无法读取调度器容器标识：{error}"))?;
    let output = docker(&[
        "inspect",
        "--format",
        "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{\"\\n\"}}{{end}}",
        container_id.trim(),
    ])?;
    output
        .lines()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "无法确定地图运行时 Docker 网络".into())
}

fn required_runtime_value(values: &BTreeMap<String, String>, key: &str) -> Result<String, String> {
    values
        .get(key)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| format!("地图运行时缺少配置：{key}"))
}

fn runtime_env_arg(args: &mut Vec<String>, key: &str, value: impl AsRef<str>) {
    args.extend(["-e".into(), format!("{key}={}", value.as_ref())]);
}

fn runtime_container_running(name: &str) -> bool {
    docker(&["inspect", "--format", "{{.State.Running}}", name])
        .is_ok_and(|value| value.trim() == "true")
}

fn valid_runtime_container_id(value: &str) -> bool {
    value.starts_with("box-runtime-")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(crate) fn docker_bytes(value: &str) -> Option<u64> {
    let value = value.trim();
    let units = [
        ("TiB", 1024_f64.powi(4)),
        ("GiB", 1024_f64.powi(3)),
        ("MiB", 1024_f64.powi(2)),
        ("KiB", 1024_f64),
        ("TB", 1000_f64.powi(4)),
        ("GB", 1000_f64.powi(3)),
        ("MB", 1000_f64.powi(2)),
        ("kB", 1000_f64),
        ("B", 1_f64),
    ];
    for (unit, multiplier) in units {
        if let Some(number) = value.strip_suffix(unit) {
            let bytes = number.trim().parse::<f64>().ok()? * multiplier;
            return (bytes.is_finite() && bytes >= 0.0).then_some(bytes.round() as u64);
        }
    }
    None
}

fn runtime_container_stats(container_id: &str) -> Result<Value, String> {
    if !valid_runtime_container_id(container_id) {
        return Err("地图运行时容器标识无效".into());
    }
    if !runtime_container_running(container_id) {
        return Ok(json!({"running":false}));
    }
    let row: Value = serde_json::from_str(&docker(&[
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        container_id,
    ])?)
    .map_err(|error| format!("Docker 性能数据格式无效：{error}"))?;
    let cpu_percent = row
        .get("CPUPerc")
        .and_then(Value::as_str)
        .unwrap_or("0%")
        .trim_end_matches('%')
        .parse::<f64>()
        .unwrap_or(0.0);
    let memory = row
        .get("MemUsage")
        .and_then(Value::as_str)
        .unwrap_or("0B / 0B");
    let mut memory_parts = memory.split('/').map(str::trim);
    let memory_usage = memory_parts.next().and_then(docker_bytes).unwrap_or(0);
    let memory_limit = memory_parts.next().and_then(docker_bytes).unwrap_or(0);
    let started_at = docker(&["inspect", "--format", "{{.State.StartedAt}}", container_id])?;
    let uptime_ms = chrono::DateTime::parse_from_rfc3339(started_at.trim())
        .ok()
        .map(|started| {
            Utc::now()
                .signed_duration_since(started.with_timezone(&Utc))
                .num_milliseconds()
                .max(0) as u64
        })
        .unwrap_or(0);
    Ok(json!({
        "running": true,
        "cpuPercent": cpu_percent,
        "memoryBytes": memory_usage,
        "memoryLimitBytes": memory_limit,
        "uptimeMs": uptime_ms,
        "processCount": row.get("PIDs").and_then(Value::as_str).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0)
    }))
}

pub(crate) fn runtime_entrypoint_command(needs_privileged_init: bool) -> String {
    let game_command = "node /app/apps/local-engine/src/moderation-runtime-launch.js";
    if needs_privileged_init {
        format!(
            "if [ \"$BOX_RUNTIME_NETWORK_POLICY\" = private ]; then \
              iptables -P OUTPUT DROP; \
              iptables -A OUTPUT -o lo -j ACCEPT; \
              iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; \
              iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT; \
              iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT; \
              iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT; \
            fi; \
            if [ \"${{BOX_RUNTIME_BANDWIDTH_MBPS:-0}}\" -gt 0 ]; then \
              tc qdisc replace dev eth0 root tbf rate \"${{BOX_RUNTIME_BANDWIDTH_MBPS}}mbit\" burst 64kb latency 400ms; \
            fi; \
            exec setpriv --reuid=node --regid=node --init-groups --bounding-set=-all {game_command}"
        )
    } else {
        format!("exec {game_command}")
    }
}

/// Creates an isolated Play runtime only after validating the published map
/// identity. The validation prevents a caller from mounting another map's
/// files or reusing a resource profile across map IDs.
pub(crate) async fn ensure_runtime_container(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(request): Json<RuntimeEnsureRequest>,
) -> Response {
    if let Err(response) = runtime_auth(&headers, &app) {
        return response;
    }
    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let name = runtime_container_name(&request)?;
        if !runtime_container_running(&name) {
            let _ = docker(&["rm", "-f", &name]);
            let values = parse_env(
                &fs::read_to_string(runtime_env_path(&app))
                    .map_err(|error| format!("无法读取运行配置：{error}"))?,
            );
            let tag = data_image_tag(&app);
            let data_root = configured_data_directory(&app)?;
            let readable_data_root = container_visible_path(&app, &data_root)?;
            let world_root = data_root.join("apps/local-engine/play-worlds").join(&request.project_id);
            let readable_world_root = readable_data_root
                .join("apps/local-engine/play-worlds")
                .join(&request.project_id);
            let manifest_path = readable_world_root.join("manifest.json");
            let manifest: Value = serde_json::from_str(
                &fs::read_to_string(&manifest_path)
                    .map_err(|error| format!("无法读取发布地图 {}：{error}", manifest_path.display()))?,
            )
            .map_err(|error| format!("发布地图清单无效：{error}"))?;
            if manifest.get("id").and_then(Value::as_str) != Some(request.project_id.as_str())
                || manifest.get("permanentMapId").and_then(Value::as_str)
                    != Some(request.permanent_map_id.as_str())
            {
                return Err("发布地图身份与调度请求不匹配".into());
            }
            let permission_hash = manifest
                .get("permissionHash")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or("发布地图缺少 permissionHash")?;
            let project_name = manifest
                .get("projectName")
                .and_then(Value::as_str)
                .unwrap_or(&request.project_id);
            let group_namespace = manifest
                .get("permanentMapGroupId")
                .and_then(Value::as_str)
                .unwrap_or(&request.permanent_map_id);
            let network = runtime_network()?;
            let world_mount = format!("{}:/app/world:ro", world_root.display());
            let data_mount = format!(
                "{}:/app/apps/local-engine/data:ro",
                data_root.join("apps/local-engine/data").display()
            );
            let secret = required_runtime_value(&values, "PERMISSION_TOKEN_SECRET")?;
            let database_url = required_runtime_value(&values, "BOX_DATABASE_URL")?;
            let image = format!("box-local-engine-play:{tag}");
            let server_id = request.room_id.as_deref().unwrap_or(&request.permanent_map_id);
            let process_limit = request.process_limit.unwrap_or(512);
            let network_policy = request.network_policy.as_deref().unwrap_or("unrestricted");
            let bandwidth_mbps = request.bandwidth_mbps.unwrap_or(0);
            let [runtime_project_label, runtime_service_label] = runtime_compose_labels(&request);
            let mut args = vec![
                "run".into(), "-d".into(), "--name".into(), name.clone(),
                "--label".into(), runtime_project_label,
                "--label".into(), runtime_service_label,
                "--network".into(), network, "--network-alias".into(), name.clone(),
                "--read-only".into(), "--security-opt".into(), "no-new-privileges:true".into(),
                "--cap-drop".into(), "ALL".into(), "--pids-limit".into(), process_limit.to_string(),
                "--tmpfs".into(), "/tmp:size=1g,mode=1777".into(),
                "--health-cmd".into(),
                "node -e \"fetch('http://127.0.0.1:9966/api/health-check').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"".into(),
                "--health-interval".into(), "5s".into(),
                "--health-timeout".into(), "3s".into(),
                "--health-retries".into(), "12".into(),
                "--health-start-period".into(), "30s".into(),
                "-v".into(), world_mount, "-v".into(), data_mount,
            ];
            let needs_privileged_init = network_policy == "private" || bandwidth_mbps > 0;
            if needs_privileged_init {
                args.extend([
                    "--user".into(), "0".into(),
                    "--cap-add".into(), "NET_ADMIN".into(),
                    "--cap-add".into(), "CHOWN".into(),
                    "--cap-add".into(), "SETUID".into(),
                    "--cap-add".into(), "SETGID".into(),
                ]);
            }
            if let Some(cpu) = request.cpu_milli {
                args.extend(["--cpus".into(), format!("{}", cpu as f64 / 1000.0)])
            }
            if let Some(memory) = request.memory_mb {
                args.extend(["--memory".into(), format!("{memory}m")])
            }
            for (key, value) in [
                ("METHOD", "local"), ("MODE", "play"), ("LOGIN", ""),
                ("IS_HTTPS", "false"), ("PORT", "9966"), ("HOST_IP", "0.0.0.0"),
                ("STORAGE_PATH", "/app/world/data"),
                ("BOX_PROJECT_STATE_PATH", "/app/world/data/project-state.json"),
                ("BOX_DERIVED_STORAGE_PATH", "/tmp/derived"), ("HASH", permission_hash),
                ("VM", "isolate"), ("CONTENT_ID", &request.project_id),
                ("BOX_DATA_STORAGE_NAMESPACE", &request.permanent_map_id),
                ("BOX_WORLD_PERMANENT_MAP_ID", &request.permanent_map_id),
                ("BOX_GROUP_STORAGE_NAMESPACE", group_namespace), ("BOX_SERVER_NAME", project_name),
                ("BOX_WORLD_PUBLIC_ID", manifest.get("publicId").and_then(Value::as_str).unwrap_or(&request.project_id)),
                ("BOX_WORLD_DESCRIPTION", manifest.get("description").and_then(Value::as_str).unwrap_or("")),
                ("BOX_WORLD_VERSION", manifest.get("version").and_then(Value::as_str).unwrap_or("")),
                ("CONTAINER_NAME", &request.project_id), ("SERVER_ID", server_id),
                ("TYPE", if request.room_id.is_some() { "teleport" } else { "public" }),
                ("TELEPORT_ACCESS", "true"), ("PLAYER_LIMIT", &request.player_limit.to_string()),
                ("MAX_ZERO_PLAYER_TIME", &request.idle_timeout_ms.to_string()),
                ("BOX_RUNTIME_NETWORK_POLICY", network_policy),
                ("BOX_RUNTIME_BANDWIDTH_MBPS", &bandwidth_mbps.to_string()),
                ("PERMISSION_TOKEN_SECRET", &secret), ("BOX_DATABASE_URL", &database_url),
                ("BOX_MODERATION_SIGNING_SECRET", values.get("BOX_MODERATION_SIGNING_SECRET").map(String::as_str).unwrap_or("")),
                ("BOX_TELEPORT_CONTROL_URL", &request.teleport_control_url),
                ("BOX_TELEPORT_INTERNAL_TOKEN", &request.teleport_internal_token),
                ("BOX_DIRECT_SESSION_API", "false"),
                ("BOX_PLAYER_SERVICE_INTERNAL_URL", values.get("BOX_PLAYER_SERVICE_INTERNAL_URL").map(String::as_str).unwrap_or("http://player-service:3213")),
                ("BOX_DATABASE_SCHEMA", values.get("BOX_DATABASE_SCHEMA").map(String::as_str).unwrap_or("box_engine")),
                ("BOX_DATABASE_POOL_SIZE", values.get("BOX_DATABASE_POOL_SIZE").map(String::as_str).unwrap_or("4")),
                ("BOX_DATABASE_SSL", values.get("BOX_DATABASE_SSL").map(String::as_str).unwrap_or("false")),
                ("BOX_DATABASE_SSL_REJECT_UNAUTHORIZED", values.get("BOX_DATABASE_SSL_REJECT_UNAUTHORIZED").map(String::as_str).unwrap_or("true")),
                ("REDIS_HOST", values.get("REDIS_HOST").map(String::as_str).unwrap_or("")),
                ("REDIS_PORT", values.get("REDIS_PORT").map(String::as_str).unwrap_or("6379")),
                ("REDIS_PASSWORD", values.get("REDIS_PASSWORD").map(String::as_str).unwrap_or("")),
                ("REDIS_DB", values.get("REDIS_DB").map(String::as_str).unwrap_or("0")),
                ("STORAGE_CACHE_REDIS_DB", values.get("STORAGE_CACHE_REDIS_DB").map(String::as_str).unwrap_or("1")),
                ("STORAGE_CACHE_REDIS_TTL", values.get("STORAGE_CACHE_REDIS_TTL").map(String::as_str).unwrap_or("240")),
                ("BOX_BUNDLED_CONTENT_PATH", "/app/apps/local-engine/data/blobs"),
                ("BOX_LOCAL_CONFIG_PATH", "/app/apps/local-engine/config/local.config.json"),
                ("BOX_LOCAL_ENGINE_ROOT", "/app/apps/local-engine"),
                ("NEXT_PUBLIC_APP_ENV", "development"),
                ("NEXT_PUBLIC_APP_EDITION", "createra"),
                ("NEXT_PUBLIC_APP_REGION", "cn"),
                ("NODE_ENV", "production"),
            ] {
                runtime_env_arg(&mut args, key, value);
            }
            args.extend([
                image,
                "sh".into(),
                "-ec".into(),
                runtime_entrypoint_command(needs_privileged_init),
            ]);
            let argv = args.iter().map(String::as_str).collect::<Vec<_>>();
            docker(&argv)?;
        }
        let hostname = runtime_container_address(&name)?;
        Ok(json!({"containerId":name,"hostname":hostname,"port":9966,"startedAt":Utc::now().to_rfc3339()}))
    })
    .await
    .unwrap_or_else(|error| Err(format!("运行时容器任务异常：{error}")));
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => fail(error),
    }
}

pub(crate) async fn delete_runtime_container(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(container_id): Path<String>,
) -> Response {
    if let Err(response) = runtime_auth(&headers, &app) {
        return response;
    }
    if !valid_runtime_container_id(&container_id) {
        return fail("地图运行时容器标识无效");
    }
    match tokio::task::spawn_blocking(move || docker(&["rm", "-f", &container_id])).await {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) if error.contains("No such container") => {
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(error)) => fail(error),
        Err(error) => fail(format!("运行时容器销毁异常：{error}")),
    }
}

pub(crate) async fn get_runtime_container_stats(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(container_id): Path<String>,
) -> Response {
    if let Err(response) = runtime_auth(&headers, &app) {
        return response;
    }
    match tokio::task::spawn_blocking(move || runtime_container_stats(&container_id)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => fail(error),
        Err(error) => fail(format!("读取地图容器性能异常：{error}")),
    }
}
