//! Runtime inventory and per-map runtime profile persistence.

use crate::*;

pub(crate) fn decode_chunked_body(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::new();
    loop {
        let line_end = body.windows(2).position(|window| window == b"\r\n")?;
        let length = std::str::from_utf8(&body[..line_end])
            .ok()?
            .split(';')
            .next()?
            .trim();
        let length = usize::from_str_radix(length, 16).ok()?;
        body = &body[line_end + 2..];
        if length == 0 {
            return Some(decoded);
        }
        if body.len() < length + 2 || &body[length..length + 2] != b"\r\n" {
            return None;
        }
        decoded.extend_from_slice(&body[..length]);
        body = &body[length + 2..];
    }
}
/// Samples the runtime's local status endpoint with a short blocking timeout.
/// A failed sample becomes a stable stopped-state value, so one unavailable
/// map never makes the complete management catalog unavailable.
pub(crate) fn runtime_status(host: &str, port: u16, project_id: &str, prefix: &str) -> Value {
    let Ok(mut stream) = TcpStream::connect((host, port)) else {
        return crate::runtime::catalog::unavailable_runtime();
    };
    // Isolated map runtimes include a Docker stats lookup in this response.
    // On Docker Desktop that regularly takes longer than the old 1.2s
    // budget, causing a healthy runtime to be shown as disconnected.
    // This catalog is refreshed explicitly by the operator, so favour a
    // correct result over an aggressively short probe timeout.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let path = if prefix.is_empty() {
        format!("/{project_id}/__local_runtime/status")
    } else {
        format!("/{prefix}/{project_id}/__local_runtime/status")
    };
    if stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .is_err()
    {
        return crate::runtime::catalog::unavailable_runtime();
    }
    // Node's proxy uses chunked transfer encoding for this tiny document and
    // may keep the socket alive.  Read complete HTTP framing rather than
    // waiting for EOF or treating chunk markers as JSON.
    let mut raw = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 4096];
    while raw.len() < 16 * 1024 {
        let length = match stream.read(&mut chunk) {
            Ok(length) if length > 0 => length,
            _ => break,
        };
        raw.extend_from_slice(&chunk[..length]);
        if let Some(header_end) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&raw[..header_end]).to_ascii_lowercase();
            let body = &raw[header_end + 4..];
            if headers.contains("transfer-encoding: chunked") {
                if body.windows(5).any(|window| window == b"0\r\n\r\n") {
                    break;
                }
            } else if let Some(length) = headers.lines().find_map(|line| {
                line.strip_prefix("content-length:")?
                    .trim()
                    .parse::<usize>()
                    .ok()
            }) {
                if body.len() >= length {
                    break;
                }
            } else {
                break;
            }
        }
    }
    let response = String::from_utf8_lossy(&raw);
    if !(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")) {
        return crate::runtime::catalog::unavailable_runtime();
    }
    let Some((headers, body)) = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (&raw[..index], &raw[index + 4..]))
    else {
        return crate::runtime::catalog::unavailable_runtime();
    };
    let chunked = String::from_utf8_lossy(headers)
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let body = if chunked {
        decode_chunked_body(body)
    } else {
        Some(body.to_vec())
    };
    body.and_then(|body| serde_json::from_slice(&body).ok())
        .unwrap_or_else(crate::runtime::catalog::unavailable_runtime)
}
/// Builds the management catalog from published maps and their configured
/// runtime profiles. It intentionally returns partial data when a map fails
/// to report status so operators can still inspect the remaining maps.
pub(crate) fn runtime_catalog(app: &App) -> Value {
    let projects = |relative: &str, metadata: &str, is_creator: bool| {
        fs::read_dir(app.root.join(relative)).ok().into_iter().flatten().filter_map(Result::ok).filter_map(|entry| {
        if !entry.file_type().ok()?.is_dir() { return None }; let project_id=entry.file_name().to_string_lossy().to_string();
        let value:Value=serde_json::from_str(&fs::read_to_string(entry.path().join(metadata)).ok()?).ok()?;
        if !is_creator && value.get("id").and_then(Value::as_str)!=Some(project_id.as_str()) {return None}
        let edit = if is_creator { runtime_status("creator", 9967, &project_id, "") } else { crate::runtime::catalog::unavailable_runtime() };
        let play = if is_creator { crate::runtime::catalog::unavailable_runtime() } else { runtime_status("play", 3000, &project_id, "p") };
        Some(json!({"projectId":project_id,"permanentMapId":value.get("permanentMapId").and_then(Value::as_str).unwrap_or(""),"name":if is_creator{value.get("name").and_then(Value::as_str).unwrap_or("")}else{value.get("projectName").and_then(Value::as_str).unwrap_or("")},"mapRole":value.get("mapRole").and_then(Value::as_str).unwrap_or("main"),"mainProjectId":value.get("mainProjectId").and_then(Value::as_str).unwrap_or(""),"edit":edit,"play":play}))
    }).collect::<Vec<_>>()
    };
    json!({"creator":projects("apps/local-engine/projects","project.json",true),"play":projects("apps/local-engine/play-worlds","manifest.json",false)})
}

pub(crate) fn map_runtime_profiles_path(app: &App) -> PathBuf {
    app.root
        .join("apps/local-engine/data/map-runtime-profiles.json")
}

pub(crate) fn read_map_runtime_profiles(app: &App) -> Result<MapRuntimeProfilesFile, String> {
    match fs::read_to_string(map_runtime_profiles_path(app)) {
        Ok(content) => {
            serde_json::from_str(&content).map_err(|error| format!("地图容器配置格式无效：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(MapRuntimeProfilesFile::default())
        }
        Err(error) => Err(format!("无法读取地图容器配置：{error}")),
    }
}

pub(crate) fn write_map_runtime_profiles(
    app: &App,
    document: &MapRuntimeProfilesFile,
) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(document)
        .map_err(|error| format!("无法编码地图容器配置：{error}"))?;
    private(&map_runtime_profiles_path(app), &encoded)
        .map_err(|error| format!("无法写入地图容器配置：{error}"))
}

pub(crate) fn list_map_runtime_profiles(app: &App) -> Result<Value, String> {
    let mut profiles = read_map_runtime_profiles(app)?.profiles;
    profiles.sort_by(|left, right| {
        (&left.permanent_map_id, &left.mode).cmp(&(&right.permanent_map_id, &right.mode))
    });
    serde_json::to_value(
        profiles
            .into_iter()
            .filter(|profile| profile.mode == "play")
            .collect::<Vec<_>>(),
    )
    .map_err(|error| format!("无法编码地图容器配置：{error}"))
}

pub(crate) fn save_map_runtime_profile(
    app: &App,
    profile: MapRuntimeProfile,
) -> Result<(), String> {
    validate_map_runtime_profile(&profile)?;
    let mut document = read_map_runtime_profiles(app)?;
    document.version = 1;
    document.profiles.retain(|candidate| {
        candidate.permanent_map_id != profile.permanent_map_id || candidate.mode != profile.mode
    });
    document.profiles.push(profile);
    write_map_runtime_profiles(app, &document)
}

pub(crate) fn delete_map_runtime_profile(
    app: &App,
    permanent_map_id: &str,
    mode: &str,
) -> Result<(), String> {
    if !valid_permanent_map_id(permanent_map_id) || mode != "play" {
        return Err("地图容器配置标识无效".into());
    }
    let mut document = read_map_runtime_profiles(app)?;
    document.profiles.retain(|candidate| {
        candidate.permanent_map_id != permanent_map_id || candidate.mode != mode
    });
    write_map_runtime_profiles(app, &document)
}

/// Removes a currently running map process/container without deleting its
/// published map package or profile. The next player request can create it.
pub(crate) fn destroy_runtime(
    project_id: &str,
    mode: &str,
    room_id: Option<&str>,
) -> Result<(), String> {
    if project_id.is_empty()
        || !project_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-')
    {
        return Err("作品 ID 无效".into());
    }
    if room_id.is_some_and(|value| {
        value.is_empty()
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    }) {
        return Err("房间 ID 无效".into());
    }
    let (host, port, prefix) = match mode {
        "creator" => ("creator", 9967, ""),
        "play" => ("play", 3000, "p"),
        _ => return Err("运行端类型无效".into()),
    };
    let path = match room_id {
        Some(room) if prefix.is_empty() => {
            format!("/{project_id}/__room/{room}/__local_runtime/destroy")
        }
        Some(room) => format!("/{prefix}/{project_id}/__room/{room}/__local_runtime/destroy"),
        None if prefix.is_empty() => format!("/{project_id}/__local_runtime/destroy"),
        None => format!("/{prefix}/{project_id}/__local_runtime/destroy"),
    };
    let mut stream =
        TcpStream::connect((host, port)).map_err(|error| format!("无法连接运行时：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream.write_all(format!("POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).map_err(|error|format!("无法发送销毁请求：{error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("无法读取销毁结果：{error}"))?;
    if response.starts_with("HTTP/1.1 204") || response.starts_with("HTTP/1.0 204") {
        Ok(())
    } else {
        Err(format!(
            "运行时拒绝销毁请求：{}",
            response.lines().next().unwrap_or("未知错误")
        ))
    }
}
