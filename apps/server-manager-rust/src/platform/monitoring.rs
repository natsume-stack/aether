//! Operational metrics, connectivity checks and image inventory.

use crate::*;

/// Aggregates Docker's one-shot statistics and associates them with managed
/// services. This never streams stats, keeping a browser refresh inexpensive.
pub(crate) fn performance(app: &App) -> Result<Value, String> {
    let output = Command::new("docker")
        .args(["stats", "--no-stream", "--format", "{{json .}}"])
        .output()
        .map_err(|error| format!("无法读取 Docker 性能数据：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let rows = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let environment = parse_env(&fs::read_to_string(env_path(app)).unwrap_or_default());
    let mut names = SERVICES.to_vec();
    names.extend(["managed-postgres", "managed-redis"]);
    let services = names
        .iter()
        .map(|service| {
            let row = rows.iter().find(|row| {
                row.get("Name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.contains(service))
            });
            let cpu = row
                .and_then(|row| row.get("CPUPerc"))
                .and_then(Value::as_str)
                .unwrap_or("0%")
                .trim_end_matches('%')
                .parse::<f64>()
                .unwrap_or(0.0);
            let memory = row
                .and_then(|row| row.get("MemUsage"))
                .and_then(Value::as_str)
                .unwrap_or("0B / 0B");
            let mut parts = memory.split('/').map(str::trim);
            let enabled = services::enabled(service, &environment);
            json!({
                "name": service,
                "enabled": enabled,
                "running": row.is_some(),
                "cpuPercent": cpu,
                "memoryUsage": parts.next().unwrap_or("0B"),
                "memoryLimit": parts.next().unwrap_or("0B"),
                "memoryPercent": row.and_then(|row|row.get("MemPerc")).and_then(Value::as_str).unwrap_or("0%").trim_end_matches('%').parse::<f64>().unwrap_or(0.0),
                "pids": row.and_then(|row|row.get("PIDs")).and_then(Value::as_str).and_then(|value|value.parse::<u64>().ok()).unwrap_or(0)
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "sampledAt": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "services": services
    }))
}
/// Tests the supplied external PostgreSQL or Redis settings without saving
/// them. Empty secret fields deliberately reuse the stored secret so the UI
/// can validate edits without echoing credentials back to the browser.
pub(crate) fn test_connection(app: &App, body: &BTreeMap<String, Value>) -> Result<Value, String> {
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let kind = text("kind");
    let host = text("host");
    if host.is_empty()
        || host.len() > 253
        || host
            .chars()
            .any(|value| !(value.is_ascii_alphanumeric() || ".:-".contains(value)))
    {
        return Err("服务器地址无效".into());
    }
    let port = body
        .get("port")
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|value| *value > 0 && *value <= 65535)
        .ok_or("服务器端口无效")? as u16;
    let stored = parse_env(&fs::read_to_string(env_path(app)).unwrap_or_default());
    if kind == "postgresql" {
        let database = if text("database").is_empty() {
            stored.get("BOX_DATABASE_NAME").cloned().unwrap_or_default()
        } else {
            text("database")
        };
        let user = if text("user").is_empty() {
            stored.get("BOX_DATABASE_USER").cloned().unwrap_or_default()
        } else {
            text("user")
        };
        let password = if text("password").is_empty() {
            stored
                .get("BOX_DATABASE_PASSWORD")
                .cloned()
                .unwrap_or_default()
        } else {
            text("password")
        };
        if database.is_empty() || user.is_empty() || password.is_empty() {
            return Err("请填写 PostgreSQL 数据库名、账号和密码后再测试".into());
        }
        postgres::Config::new()
            .host(&host)
            .port(port)
            .dbname(&database)
            .user(&user)
            .password(&password)
            .connect_timeout(Duration::from_secs(5))
            .connect(postgres::NoTls)
            .map_err(|error| format!("PostgreSQL 连接失败：{error}"))?;
        Ok(json!({"ok":true,"message":format!("PostgreSQL 服务连接并认证成功：{host}:{port}")}))
    } else if kind == "redis" {
        let password = if text("password").is_empty() {
            stored.get("REDIS_PASSWORD").cloned().unwrap_or_default()
        } else {
            text("password")
        };
        let redis_db = body
            .get("redisDb")
            .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
            .unwrap_or(0)
            .min(255);
        let client = redis::Client::open(format!("redis://{host}:{port}/"))
            .map_err(|error| format!("Redis 客户端初始化失败：{error}"))?;
        let mut connection = client
            .get_connection()
            .map_err(|error| format!("Redis 连接失败：{error}"))?;
        if !password.is_empty() {
            redis::cmd("AUTH")
                .arg(password)
                .query::<()>(&mut connection)
                .map_err(|error| format!("Redis 认证失败：{error}"))?;
        }
        redis::cmd("SELECT")
            .arg(redis_db)
            .query::<()>(&mut connection)
            .map_err(|error| format!("Redis 数据库选择失败：{error}"))?;
        redis::cmd("PING")
            .query::<String>(&mut connection)
            .map_err(|error| format!("Redis 协议检查失败：{error}"))?;
        Ok(json!({"ok":true,"message":format!("Redis 服务连接并认证成功：{host}:{port}")}))
    } else {
        Err("不支持的连接类型".into())
    }
}
pub(crate) fn service_images() -> Vec<Value> {
    let tag = env::var("BOX_IMAGE_TAG").unwrap_or_default();
    let platform = match env::consts::ARCH {
        "x86_64" => "linux/amd64",
        "aarch64" | "arm64" => "linux/arm64",
        _ => "linux",
    };
    let image_tag = if tag.is_empty() { "0.2.0".into() } else { tag };
    [
        ("地图创作工具 / 创作作品管理", "box-local-engine-creator"),
        ("模型创作工具", "box-local-engine-voxa"),
        ("游玩端", "box-local-engine-play"),
        ("账号服务", "box-local-engine-player-service"),
        ("登录页面", "box-local-engine-player-auth-portal"),
    ]
    .into_iter()
    .map(|(name, image)| {
        let full = format!("{image}:{image_tag}");
        let inspect = docker(&["image", "inspect", &full]);
        let (image_id, created_at, source_revision, build_source) = inspect
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
            .and_then(|mut list| list.pop())
            .map(|value| {
                let image_id = value
                    .get("Id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let created_at = value
                    .get("Created")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let labels = value.get("Config").and_then(|c| c.get("Labels")).cloned();
                let source_revision = labels
                    .as_ref()
                    .and_then(|l| l.get("org.opencontainers.image.revision"))
                    .and_then(Value::as_str)
                    .map(String::from)
                    .unwrap_or_else(|| {
                        option_env!("BOX_BUILD_COMMIT")
                            .unwrap_or("unknown")
                            .to_string()
                    });
                let build_source = labels
                    .as_ref()
                    .and_then(|l| l.get("org.opencontainers.image.source"))
                    .and_then(Value::as_str)
                    .map(String::from)
                    .unwrap_or_else(|| {
                        option_env!("BOX_BUILD_SOURCE")
                            .unwrap_or("local")
                            .to_string()
                    });
                (image_id, created_at, source_revision, build_source)
            })
            .unwrap_or_else(|| {
                (
                    "unknown".into(),
                    "unknown".into(),
                    option_env!("BOX_BUILD_COMMIT")
                        .unwrap_or("unknown")
                        .to_string(),
                    option_env!("BOX_BUILD_SOURCE")
                        .unwrap_or("local")
                        .to_string(),
                )
            });
        json!({
            "name": name,
            "image": image,
            "tag": image_tag,
            "platform": platform,
            "imageId": image_id,
            "createdAt": created_at,
            "sourceRevision": source_revision,
            "buildSource": build_source,
        })
    })
    .collect()
}

/// Shared snapshot for HTTP initial reads and WebSocket sampling.
pub(crate) fn system_status(app: &App) -> Result<Value, String> {
                let env = parse_env(&fs::read_to_string(env_path(app)).unwrap_or_default());
                let (mut docker_ready, docker_version, mut docker_message) = docker_check();
                let text = if docker_ready {
                    match compose(app, &["ps", "--all", "--format", "json"]) {
                        Ok(output) => output,
                        Err(error) => { docker_ready = false; docker_message = format!("无法读取服务状态：{error}"); String::new() }
                    }
                } else {
                    String::new()
                };
                let mut services = services::statuses(&text, &env);
                if !docker_ready { for service in &mut services { service.state = "unknown".into(); } }
                Ok(
                    json!({"dockerReady":docker_ready,"dockerCliAvailable":docker_ready || !docker_message.contains("无法运行 Docker"),"dockerCliVersion":docker_version,"dockerMessage":docker_message,"configured":env_path(app).is_file(),"allHealthy":services.iter().filter(|service|service.enabled).all(|service|service.running),"services":services,"dataDirectory":app.root}),
                )
}
