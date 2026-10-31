//! Sensitive configuration redaction, diagnostics.

use crate::*;

pub(crate) fn is_sensitive_env_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.contains("PASSWORD")
        || key.contains("SECRET")
        || key.contains("TOKEN")
        || key.contains("API_KEY")
        || key == "BOX_DATABASE_URL"
}
pub(crate) fn redact_text(text: String, values: &BTreeMap<String, String>) -> String {
    let mut redacted = text;
    for (key, value) in values {
        if !is_sensitive_env_key(key) || value.len() < 4 {
            continue;
        }
        redacted = redacted.replace(value.as_str(), "[REDACTED]");
    }
    redacted
}
/// Writes a support diagnostic with secrets redacted before it reaches disk.
/// Both the source and derived environment are included because deployment
/// problems often result from differences between those two documents.
pub(crate) fn export_diagnostics(app: &App) -> Result<String, String> {
    let directory = app.root.join("diagnostics");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let text = directory.join(format!("BOX-diagnostic-{stamp}.txt"));
    // The Web console offers this as the diagnostic download, so it carries
    // the same redacted configuration, status and logs the launcher exports.
    let environment = parse_env(&fs::read_to_string(env_path(app)).unwrap_or_default());
    let runtime_environment =
        parse_env(&fs::read_to_string(runtime_env_path(app)).unwrap_or_default());
    let safe_environment = environment
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                if is_sensitive_env_key(key) {
                    "[REDACTED]".to_string()
                } else {
                    value.clone()
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let docker_info = docker(&["info", "--format", "{{json .}}"])
        .unwrap_or_else(|error| format!("Docker info unavailable: {error}"));
    let compose_state = redact_text(
        compose(app, &["ps", "--all", "--format", "json"])
            .unwrap_or_else(|error| format!("Compose state unavailable: {error}")),
        &runtime_environment,
    );
    let logs = redact_text(
        redact_text(
            compose(app, &["logs", "--tail", "500", "--no-color"])
                .unwrap_or_else(|error| format!("Logs unavailable: {error}")),
            &runtime_environment,
        ),
        &environment,
    );
    let report = json!({
        "formatVersion": 1,
        "generatedAt": stamp,
        "applicationVersion": option_env!("BOX_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
        "platform": "linux",
        "architecture": env::consts::ARCH,
        "configuration": safe_environment,
        "dockerInfo": docker_info,
        "composeState": compose_state,
    });
    private(
        &text,
        &format!(
            "BOX3 Engine Linux diagnostic\ncreatedAt={stamp}\n此诊断文件已自动隐藏密码、令牌、API Key 和数据库连接串。发送前仍建议人工检查。\n\n== 配置 ==\n{}\n\n== Docker 信息 ==\n{}\n\n== Compose 状态 ==\n{}\n\n== 服务日志（最近 500 行） ==\n{}\n",
            serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?,
            report.get("dockerInfo").and_then(Value::as_str).unwrap_or(""),
            report.get("composeState").and_then(Value::as_str).unwrap_or(""),
            logs,
        ),
    )?;
    Ok(text
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string())
}
pub(crate) fn database_fields(value: Option<&String>) -> (String, String, String, String, String) {
    value
        .and_then(|url| shared_config::parse_database_url(url).ok())
        .map(|fields| {
            (
                fields.host,
                fields.port.to_string(),
                fields.database,
                fields.user,
                fields.password,
            )
        })
        .unwrap_or_else(|| {
            (
                String::new(),
                "5432".into(),
                "box".into(),
                String::new(),
                String::new(),
            )
        })
}
pub(crate) fn url_host(value: Option<&String>, fallback: &str) -> String {
    value
        .and_then(|url| shared_config::host_from_http_url(url))
        .unwrap_or_else(|| fallback.into())
}
