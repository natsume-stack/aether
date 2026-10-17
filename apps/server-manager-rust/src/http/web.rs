//! HTTP transport helpers: health, static UI and archive transfer.

use crate::*;

pub(crate) async fn health() -> Json<Value> {
    Json(json!({"ok":true}))
}
pub(crate) fn manager_port() -> u16 {
    env::var("BOX_SERVER_MANAGER_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3130)
}
pub(crate) fn run_healthcheck() -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], manager_port()));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| format!("管理服务不可达：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| format!("无法发送健康检查：{error}"))?;
    let mut response = [0_u8; 64];
    let length = stream
        .read(&mut response)
        .map_err(|error| format!("无法读取健康检查：{error}"))?;
    if response[..length].starts_with(b"HTTP/1.1 200") {
        Ok(())
    } else {
        Err("管理服务健康检查返回异常状态".into())
    }
}
pub(crate) fn public_directory() -> PathBuf {
    env::var("BOX_SERVER_MANAGER_PUBLIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/app/public"))
}
pub(crate) async fn index() -> Result<Html<String>, StatusCode> {
    fs::read_to_string(public_directory().join("index.html"))
        .map(Html)
        .map_err(|_| StatusCode::NOT_FOUND)
}
pub(crate) async fn download_backup(
    State(app): State<Arc<App>>,
    Path(archive): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = auth(&headers, &app) {
        return response;
    }
    let result = (|| -> Result<Response, String> {
        let path = backup_file(&app, &archive)?;
        let bytes = fs::read(path).map_err(|_| "备份不存在")?;
        let mut response = Response::new(bytes.into());
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            if archive.to_ascii_lowercase().ends_with(".zip") {
                "application/zip"
            } else if archive.to_ascii_lowercase().ends_with(".tar") {
                "application/x-tar"
            } else {
                "application/gzip"
            }
            .parse()
            .unwrap(),
        );
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename*=UTF-8''{}",
                urlencoding::encode(&archive)
            )
            .parse()
            .map_err(|_| "备份文件名无效")?,
        );
        Ok(response)
    })();
    result.unwrap_or_else(fail)
}
pub(crate) async fn download_diagnostics(
    State(app): State<Arc<App>>,
    Path(archive): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = auth(&headers, &app) {
        return response;
    }
    let result = (|| -> Result<Response, String> {
        let name = FsPath::new(&archive)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("诊断文件名无效")?;
        if name != archive || !name.starts_with("BOX-diagnostic-") || !name.ends_with(".txt") {
            return Err("诊断文件名无效".into());
        }
        let bytes =
            fs::read(app.root.join("diagnostics").join(name)).map_err(|_| "诊断文件不存在")?;
        let mut response = Response::new(bytes.into());
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            "text/plain; charset=utf-8".parse().unwrap(),
        );
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\"")
                .parse()
                .map_err(|_| "诊断文件名无效")?,
        );
        Ok(response)
    })();
    result.unwrap_or_else(fail)
}
/// Receives a backup archive after token and filename validation. Raw upload
/// bytes are never interpreted as configuration or shell input.
pub(crate) async fn upload_backup(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = auth(&headers, &app) {
        return response;
    }
    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let _operation = box_manager_core::operation::mutation_guard()?;
        if body.len() > 512 * 1024 * 1024 {
            return Err("备份文件不能超过 512 MB".into());
        }
        let encoded = headers
            .get("x-backup-name")
            .and_then(|v| v.to_str().ok())
            .ok_or("缺少备份文件名")?;
        let name = urlencoding::decode(encoded).map_err(|_| "备份文件名无效")?;
        let name = backup_store::import_bytes(&backup_dir(&app), &name, &body)?;
        Ok(json!({"path":name}))
    })
    .await
    .unwrap_or_else(|error| Err(format!("上传任务异常结束：{error}")));
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => fail(error),
    }
}
pub(crate) async fn operation_progress(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = auth(&headers, &app) {
        return response;
    }
    match app.operations.get(&id) {
        Some(progress) => Json(progress).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Applies one security policy to both the static console and JSON endpoints.
/// In particular, the CSP prevents a compromised diagnostic or error string
/// from becoming executable browser content.
pub(crate) async fn security(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    response
}
