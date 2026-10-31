//! Deployment configuration, host paths and Compose orchestration.

use crate::*;

pub(crate) fn env_path(app: &App) -> PathBuf {
    app.environment_file.clone()
}
use box_manager_core::environment::parse_env;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteImageCatalog {
    format_version: u8,
    platform: String,
    image_tag: String,
    images: Vec<RemoteImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteImage {
    image: String,
    image_id: String,
    image_ids: Vec<String>,
    archive: String,
    sha256: String,
    image_tag: String,
    platform: String,
    size: u64,
    #[serde(default)]
    download_base_url: Option<String>,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn image_catalog(app: &App, service: &str, image_tag: &str) -> Result<RemoteImage, String> {
    let catalog_path = app.root.join("BOX3-IMAGE-CATALOG.json");
    let catalog: RemoteImageCatalog = serde_json::from_slice(
        &fs::read(&catalog_path).map_err(|_| "缺少按需镜像清单，请更新 Linux 管理器安装包".to_string())?,
    )
    .map_err(|error| format!("按需镜像清单无效：{error}"))?;
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return Err("当前服务器架构不支持按需下载镜像".into()),
    };
    let platform = format!("linux/{architecture}");
    if catalog.format_version != 2
        || catalog.platform != platform
        || catalog.image_tag != image_tag
    {
        return Err("按需镜像清单与当前版本或服务器架构不匹配".into());
    }
    let image_name = format!("box-local-engine-{service}");
    let mut matches = catalog.images.into_iter().filter(|image| image.image == image_name);
    let image = matches.next().ok_or_else(|| format!("镜像清单缺少 {service}"))?;
    if matches.next().is_some()
        || image.platform != platform
        || image.image_tag != image_tag
        || image.size == 0
        || !valid_sha256(&image.sha256)
        || image.image_id.strip_prefix("sha256:").is_none_or(|digest| !valid_sha256(digest))
        || image.image_ids.is_empty()
        || image.image_ids.len() > 2
        || !image.image_ids.contains(&image.image_id)
        || image.image_ids.iter().any(|id| {
            id.strip_prefix("sha256:")
                .is_none_or(|digest| !valid_sha256(digest))
        })
        || image.archive
            != format!("box-local-engine-image-{service}-{architecture}-{}.tar.gz", image.sha256)
    {
        return Err(format!("{service} 镜像清单字段无效"));
    }
    Ok(image)
}

fn verified_archive(path: &FsPath, image: &RemoteImage) -> bool {
    if fs::metadata(path).map(|metadata| metadata.len()).ok() != Some(image.size) {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else { return false };
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => hash.update(&buffer[..length]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hash.finalize()).eq_ignore_ascii_case(&image.sha256)
}

fn download_image_archive(
    app: &App,
    image: &RemoteImage,
    service: &str,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, String> {
    if image.image_tag.contains("-staging-linux-") != image.download_base_url.as_deref().is_some_and(|base| base.starts_with("https://assets.box3.fun/local-engine-staging/")) {
        return Err("镜像下载渠道与版本不一致".into());
    }
    let url = box_manager_core::release_channel::image_download_url(image.download_base_url.as_deref(), &image.archive)?;
    download_image_archive_from(app, image, service, progress, &url)
}

fn download_image_archive_from(
    app: &App,
    image: &RemoteImage,
    service: &str,
    progress: &mut dyn FnMut(u64, u64),
    url: &str,
) -> Result<PathBuf, String> {
    let cache = app.root.join("cache/engine-images");
    fs::create_dir_all(&cache).map_err(|error| format!("无法创建镜像缓存目录：{error}"))?;
    let destination = cache.join(&image.archive);
    if verified_archive(&destination, image) {
        progress(image.size, image.size);
        app.image_download_complete(&image.image);
        return Ok(destination);
    }
    let local = match fs::read_to_string(app.root.join("BOX3-PACKAGE-MODE.json")) {
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|_| "打包模式清单无效")?;
            match value["mode"].as_str() {
                Some("local") => true,
                Some("slim") => false,
                _ => return Err("打包模式清单无效".into()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("无法读取打包模式清单：{error}")),
    };
    if local { return Err(format!("{service} 的本地镜像归档缺失或损坏，请重新生成本地测试包")); }
    let partial = destination.with_extension("part");
    let mut offset = fs::metadata(&partial).map(|metadata| metadata.len()).unwrap_or(0);
    if offset >= image.size {
        fs::remove_file(&partial).map_err(|error| error.to_string())?;
        offset = 0;
    }
    progress(offset, image.size);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|error| error.to_string())?;
    let request = |offset: u64| {
        let mut request = client.get(url).header(reqwest::header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        request.send().map_err(|error| format!("无法下载 {service} 镜像，下载进度已保留：{error}"))
    };
    let mut response = request(offset)?;
    if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
        offset = 0;
        response = request(0)?;
    }
    if !matches!(response.status(), reqwest::StatusCode::OK | reqwest::StatusCode::PARTIAL_CONTENT) {
        return Err(format!("下载 {service} 镜像失败（HTTP {}）", response.status()));
    }
    if response.status() == reqwest::StatusCode::OK {
        offset = 0;
    } else {
        let expected_prefix = format!("bytes {offset}-");
        let range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()).unwrap_or("");
        if !range.starts_with(&expected_prefix) || !range.ends_with(&format!("/{}", image.size)) {
            return Err("镜像续传响应范围无效，请重试".into());
        }
    }
    let mut file = if offset == 0 {
        fs::File::create(&partial)
    } else {
        fs::OpenOptions::new().append(true).open(&partial)
    }.map_err(|error| error.to_string())?;
    let mut total = offset;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let length = response.read(&mut buffer).map_err(|error| format!("镜像下载中断，已保留进度：{error}"))?;
        if length == 0 { break; }
        file.write_all(&buffer[..length]).map_err(|error| error.to_string())?;
        total = total.saturating_add(length as u64);
        progress(total, image.size);
    }
    file.sync_all().map_err(|error| error.to_string())?;
    if total != image.size || !verified_archive(&partial, image) {
        return Err(format!("{service} 镜像下载校验失败；重试时会重新校验缓存"));
    }
    fs::rename(&partial, &destination).map_err(|error| error.to_string())?;
    progress(image.size, image.size);
    app.image_download_complete(&image.image);
    Ok(destination)
}

#[cfg(test)]
#[path = "image_download_tests.rs"]
mod image_download_tests;

pub(crate) struct PreparedApplicationImage {
    image: RemoteImage,
    local_id: Option<String>,
    archive: Option<PathBuf>,
}

impl PreparedApplicationImage {
    pub(crate) fn download_row(&self) -> Option<box_manager_core::services::ImageDownloadProgress> {
        self.local_id.is_none().then(|| box_manager_core::services::ImageDownloadProgress { image: self.image.image.clone(), bytes: 0, total: self.image.size, percent: 0 })
    }
}

pub(crate) fn plan_application_image(
    app: &App,
    service: &str,
    image_tag: &str,
) -> Result<PreparedApplicationImage, String> {
    let image = image_catalog(app, service, image_tag)?;
    let target = format!("{}:{}", image.image, image.image_tag);
    let content_tag = image.image_id.strip_prefix("sha256:").ok_or("镜像摘要无效")?;
    let content = format!("{}:launcher-content-{content_tag}", image.image);
    let accepts = |id: &str| image.image_ids.iter().any(|expected| expected == id.trim());
    let mut loaded_id = docker(&["image", "inspect", "--format", "{{.Id}}", &target]).ok().filter(|id| accepts(id));
    if loaded_id.is_none() {
        loaded_id = docker(&["image", "inspect", "--format", "{{.Id}}", &content]).ok().filter(|id| accepts(id));
    }
    if loaded_id.is_none() {
        loaded_id = image.image_ids.iter().find_map(|id| {
            docker(&["image", "inspect", "--format", "{{.Id}}", id]).ok().filter(|actual| accepts(actual))
        });
    }
    Ok(PreparedApplicationImage { image, local_id: loaded_id, archive: None })
}

pub(crate) fn acquire_application_image(app: &App, mut prepared: PreparedApplicationImage) -> Result<PreparedApplicationImage, String> {
    if prepared.local_id.is_none() {
        let service = prepared.image.image.strip_prefix("box-local-engine-").ok_or("镜像名称无效")?;
        prepared.archive = Some(download_image_archive(app, &prepared.image, service, &mut |bytes, total| app.image_progress(&prepared.image.image, bytes, total))?);
    }
    Ok(prepared)
}

pub(crate) fn import_application_image(app: &App, prepared: PreparedApplicationImage) -> Result<(), String> {
    let image = prepared.image;
    let service = image.image.strip_prefix("box-local-engine-").ok_or("镜像名称无效")?;
    let target = format!("{}:{}", image.image, image.image_tag);
    let content = format!("{}:launcher-content-{}", image.image, image.image_id.strip_prefix("sha256:").ok_or("镜像摘要无效")?);
    let mut loaded_id = prepared.local_id;
    if let Some(archive) = prepared.archive {
        app.progress("image-import", &format!("{} 下载完成，正在导入 Docker…", image.image), 100);
        docker(&["load", "-i", archive.to_str().ok_or("镜像缓存路径无效")?])?;
        loaded_id = Some(docker(&["image", "inspect", "--format", "{{.Id}}", &content])?);
    }
    let loaded_id = loaded_id.ok_or("导入镜像未找到")?;
    if !image.image_ids.iter().any(|expected| expected == loaded_id.trim()) {
        return Err(format!("{service} 镜像摘要与发行清单不匹配"));
    }
    docker(&["tag", loaded_id.trim(), &target])?;
    let target_id = docker(&["image", "inspect", "--format", "{{.Id}}", &target])?;
    if target_id.trim() != loaded_id.trim() {
        return Err(format!("{service} 目标镜像标签指向错误的摘要"));
    }
    let _ = docker(&["image", "rm", &content]);
    Ok(())
}

pub(crate) fn set_env(mut source: String, key: &str, value: &str) -> Result<String, String> {
    box_manager_core::environment::set_env(&mut source, key, value)?;
    Ok(source)
}
pub(crate) fn json_value(value: &Value) -> Result<String, String> {
    let rendered = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => return Err("配置项格式无效".into()),
    };
    if rendered.len() > 2048 || rendered.contains(['\r', '\n', '\0']) {
        return Err("配置项内容无效".into());
    }
    Ok(rendered)
}
pub(crate) fn port(value: &Value, label: &str) -> Result<String, String> {
    let value = json_value(value)?;
    match value.parse::<u16>() {
        Ok(1..=65535) => Ok(value),
        _ => Err(format!("{label} 必须在 1–65535 之间")),
    }
}
/// Verifies both same-origin requests and the management Bearer token.
///
/// The manager controls Docker through a mounted socket, therefore a valid
/// token alone is not enough for a browser request from an unrelated origin.
pub(crate) fn auth(headers: &HeaderMap, app: &App) -> Result<(), Response> {
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let matches = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"))
            .map(|value| value.trim_end_matches('/'))
            == Some(host);
        if !matches {
            return Err((
                StatusCode::FORBIDDEN,
                Json(Error {
                    message: "拒绝跨站管理请求".into(),
                }),
            )
                .into_response());
        }
    }
    let got = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if got.len() == app.token.len()
        && got
            .as_bytes()
            .iter()
            .zip(app.token.as_bytes())
            .fold(0u8, |a, (x, y)| a | (x ^ y))
            == 0
    {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(Error {
                message: "管理令牌无效".into(),
            }),
        )
            .into_response())
    }
}
/// Resolves the deployment directory as seen by the Docker daemon.
///
/// In the container the manager sees `/workspace`, while Docker bind mounts
/// require the host path. The explicit environment variable wins; otherwise
/// the path is derived from this container's own bind mount.
pub(crate) fn host_project_root(app: &App) -> Result<PathBuf, String> {
    if let Some(root) = env::var("BOX_SERVER_MANAGER_HOST_ROOT")
        .ok()
        .filter(|root| !root.trim().is_empty())
    {
        let root = PathBuf::from(root);
        if root.is_absolute() {
            return Ok(root);
        }
        return Err("BOX_SERVER_MANAGER_HOST_ROOT 必须是宿主机绝对路径".into());
    }
    if !in_container() {
        return Ok(app.root.clone());
    }
    let container = env::var("HOSTNAME")
        .map_err(|_| "无法定位管理容器，请配置 BOX_SERVER_MANAGER_HOST_ROOT")?;
    let mounts: Value = serde_json::from_str(&docker(&[
        "inspect",
        "--format",
        "{{json .Mounts}}",
        &container,
    ])?)
    .map_err(|e| e.to_string())?;
    mapped_host_root(&app.root, &mounts)
}
pub(crate) fn mapped_host_root(root: &FsPath, mounts: &Value) -> Result<PathBuf, String> {
    mounts
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|mount| {
            if mount.get("Type")?.as_str()? != "bind" {
                return None;
            }
            let destination = PathBuf::from(mount.get("Destination")?.as_str()?);
            let relative = root.strip_prefix(&destination).ok()?;
            let source = PathBuf::from(mount.get("Source")?.as_str()?);
            source
                .is_absolute()
                .then(|| (destination.components().count(), source.join(relative)))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, root)| root)
        .ok_or_else(|| {
            "无法定位部署目录的宿主机挂载路径，请配置 BOX_SERVER_MANAGER_HOST_ROOT".into()
        })
}
/// Runs a fixed Compose subcommand against the managed Engine project.
///
/// Runtime configuration is regenerated before each call, so direct edits to
/// the owner `.env` cannot leave Docker using stale derived endpoints.
pub(crate) fn compose(app: &App, args: &[&str]) -> Result<String, String> {
    if box_manager_core::ssl::routing_settings(&app.root)?.is_none() { if let Some(result) = services::control_existing(args, "box-local-engine", docker) {
        return result;
    }}
    let environment = generate_runtime_environment(app)?;
    let source=fs::read_to_string(&app.compose_file).map_err(|error|error.to_string())?;
    let compose_file=app.root.join(".runtime-compose.yml");
    private(&compose_file,&box_manager_core::ssl::compose_source(&app.root,&source)?)?;
    let mut command = Command::new("docker");
    command
        .args([
            "compose",
            "--project-name",
            "box-local-engine",
            "--project-directory",
        ])
        .arg(host_project_root(app)?)
        .arg("--env-file")
        .arg(&environment)
        .arg("-f")
        .arg(&compose_file)
        .current_dir(&app.root);
    if args.first() == Some(&"up") {
        // Images are acquired and verified by the manager before Compose runs.
        // Never fall back to an unrelated Docker Hub repository on a missing tag.
        command.arg("up").args(["--pull", "never"]).args(&args[1..]);
    } else {
        command.args(args);
    }
    for key in
        parse_env(&fs::read_to_string(&environment).map_err(|error| error.to_string())?).keys()
    {
        command.env_remove(key);
    }
    // These variables configure the manager process, not host-side bind paths.
    command
        .env_remove("BOX_SERVER_MANAGER_ROOT")
        .env_remove("BOX_SERVER_MANAGER_COMPOSE_FILE");
    let output = command
        .output()
        .map_err(|e| format!("无法运行 Docker：{e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into())
    }
}
pub(crate) fn docker(args: &[&str]) -> Result<String, String> {
    let output = Command::new("docker")
        .args(args)
        .output()
        .map_err(|error| format!("无法运行 Docker：{error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub(crate) fn pull_image_with_progress(
    image: &str,
    label: &str,
    progress: &mut dyn FnMut(u8, String),
) -> Result<(), String> {
    let mut command = Command::new("docker");
    command.args(["pull", image]);
    box_manager_core::docker_pull::run(command, label, progress).map(|_| ())
}

fn stable_version(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.strip_prefix('v').unwrap_or(value).split('.');
    let parsed = [parts.next()?, parts.next()?, parts.next()?]
        .map(|part| {
            (!part.is_empty()
                && (part.len() == 1 || !part.starts_with('0'))
                && part.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| part.parse::<u64>().ok())
            .flatten()
        });
    if parts.next().is_some() || parsed.iter().any(Option::is_none) {
        return None;
    }
    Some([parsed[0]?, parsed[1]?, parsed[2]?])
}

pub(crate) fn start_server_update(app: &App, requested_version: &str) -> Result<String, String> {
    let requested = requested_version.trim().trim_start_matches('v');
    let target_version = stable_version(requested.trim_end_matches("-staging")).ok_or("更新版本格式无效")?;
    let current_version = option_env!("BOX_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    if box_manager_core::release_channel::is_dev(current_version) {
        return Err("开发版本请重新打包更新".into());
    }
    if box_manager_core::release_channel::is_staging(requested) != box_manager_core::release_channel::is_staging(current_version) {
        return Err("更新渠道与当前管理器不一致".into());
    }
    let current = stable_version(current_version.trim_end_matches("-staging")).ok_or("当前管理器版本格式无效")?;
    if target_version <= current {
        return Err("当前 Web 管理器已经是该版本或更新版本".into());
    }
    let values = parse_env(&fs::read_to_string(env_path(app)).map_err(|error| error.to_string())?);
    let image_tag = values
        .get("BOX_IMAGE_TAG")
        .filter(|tag| tag.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)))
        .ok_or("当前服务器镜像版本配置无效")?;
    let manager_image = format!("box-local-engine-server-manager:{image_tag}");
    docker(&["image", "inspect", &manager_image])
        .map_err(|_| "当前 Web 管理器镜像不可用，无法安全启动更新任务".to_string())?;

    let host_root = host_project_root(app)?;
    let host_root_text = host_root
        .to_str()
        .filter(|value| value.starts_with('/') && !value.contains([',', '\n', '\r']))
        .ok_or("安装目录必须是有效的 Linux 绝对路径")?;
    let socket = values
        .get("BOX_DOCKER_SOCKET")
        .filter(|value| value.starts_with('/') && !value.contains([',', '\n', '\r']))
        .map(String::as_str)
        .unwrap_or("/var/run/docker.sock");
    let bind_ip = values
        .get("BOX_SERVER_MANAGER_BIND_IP")
        .map(String::as_str)
        .unwrap_or("0.0.0.0");
    if !matches!(bind_ip, "127.0.0.1" | "0.0.0.0") {
        return Err("管理器监听地址无效，无法启动更新任务".into());
    }
    let updater_name = format!("box3-server-manager-updater-{}", random_hex(8));
    let socket_mount = format!("type=bind,source={socket},target=/var/run/docker.sock");
    let root_mount = format!("type=bind,source={host_root_text},target={host_root_text}");
    let directory = format!("BOX3_INSTALL_DIRECTORY={host_root_text}");
    let version = format!("BOX3_VERSION={requested}");
    let bind = format!("BOX3_MANAGER_BIND_IP={bind_ip}");
    let helper_name = format!("BOX3_UPDATE_HELPER_NAME={updater_name}");
    let web_update = "BOX3_WEB_UPDATE=1";
    let release_cdn = format!("BOX3_RELEASE_CDN_URL={}", box_manager_core::release_channel::release_base(current_version));
    let output = Command::new("docker")
        .args([
            "run",
            "--detach",
            "--name",
            &updater_name,
            "--network",
            "host",
            "--mount",
            &socket_mount,
            "--mount",
            &root_mount,
            "--env",
            &directory,
            "--env",
            &version,
            "--env",
            &bind,
            "--env",
            &helper_name,
            "--env",
            web_update,
            "--env",
            &release_cdn,
            &manager_image,
            "/bin/sh",
            "/app/bootstrap.sh",
        ])
        .output()
        .map_err(|error| format!("无法启动 Web 管理器更新任务：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let container = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if container.is_empty() {
        return Err("Docker 未返回更新任务容器 ID".into());
    }
    Ok(updater_name)
}

pub(crate) fn linux_data_directory(value: &str) -> Result<PathBuf, String> {
    let path = value.trim();
    if path.is_empty() || !path.starts_with('/') {
        return Err("数据目录必须是 Linux 服务器上的绝对路径".into());
    }
    if path.len() > 512
        || !path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
    {
        return Err("数据目录只能包含字母、数字、/、.、_ 和 -".into());
    }
    Ok(PathBuf::from(path))
}

pub(crate) fn configured_data_directory(app: &App) -> Result<PathBuf, String> {
    let values = parse_env(&fs::read_to_string(env_path(app)).map_err(|error| error.to_string())?);
    values
        .get("BOX_DATA_DIRECTORY")
        .filter(|value| !value.trim().is_empty())
        .map(|value| linux_data_directory(value))
        .transpose()?
        .map(Ok)
        .unwrap_or_else(|| host_project_root(app))
}

/// Translate a host path used for Docker bind mounts back into the path that
/// the manager container can read through its `/workspace` bind mount.
pub(crate) fn container_visible_path(app: &App, host_path: &FsPath) -> Result<PathBuf, String> {
    if !in_container() {
        return Ok(host_path.to_path_buf());
    }
    let host_root = host_project_root(app)?;
    let relative = host_path.strip_prefix(&host_root).map_err(|_| {
        format!(
            "数据目录 {} 不在管理器已挂载的部署目录 {} 内",
            host_path.display(),
            host_root.display()
        )
    })?;
    Ok(app.root.join(relative))
}

pub(crate) fn has_running_application_services() -> Result<bool, String> {
    let output = docker(&[
        "ps",
        "--filter",
        "label=com.docker.compose.project=box-local-engine",
        "--filter",
        "status=running",
        "--format",
        "{{.Label \"com.docker.compose.service\"}}",
    ])?;
    Ok(output.lines().any(|service| {
        SERVICES.contains(&service.trim())
            || matches!(service.trim(), "managed-postgres" | "managed-redis")
    }))
}

pub(crate) fn data_image_tag(app: &App) -> String {
    parse_env(&fs::read_to_string(env_path(app)).unwrap_or_default())
        .get("BOX_IMAGE_TAG")
        .cloned()
        .or_else(|| env::var("BOX_IMAGE_TAG").ok())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into())
}

/// Moves persisted deployment data only after all application services stop.
/// This prevents a live database or map writer from producing a split copy.
pub(crate) fn migrate_data_directory(app: &App, requested: &str) -> Result<Value, String> {
    let source = configured_data_directory(app)?;
    let destination = linux_data_directory(requested)?;
    if source == destination {
        return Ok(json!({"path": destination, "usingDefault": false}));
    }
    if has_running_application_services()? {
        return Err("请先在服务总览停止全部服务，再迁移数据目录".into());
    }
    let image = format!("box-local-engine-server-manager:{}", data_image_tag(app));
    let source_mount = format!("{}:/source", source.display());
    let destination_mount = format!("{}:/target", destination.display());
    app.progress("data-copy", "正在迁移地图、模型与备份…", 25);
    docker(&[
        "run", "--rm", "-v", &source_mount, "-v", &destination_mount, "--entrypoint", "/bin/sh",
        &image, "-c",
        "set -eu; test -z \"$(ls -A /target)\"; for path in apps/local-engine/projects apps/local-engine/dist apps/local-engine/backups apps/local-engine/play-worlds apps/voxa/data; do if [ -e /source/$path ]; then mkdir -p /target/$(dirname $path); cp -a /source/$path /target/$path; fi; done",
    ])?;
    let content = fs::read_to_string(env_path(app)).map_err(|error| error.to_string())?;
    let content = set_env(
        content,
        "BOX_DATA_DIRECTORY",
        &destination.to_string_lossy(),
    )?;
    private(&env_path(app), &content)?;
    generate_runtime_environment(app)?;
    app.progress("data-switch", "正在切换数据目录…", 80);
    docker(&[
        "run", "--rm", "-v", &source_mount, "-v", &destination_mount, "--entrypoint", "/bin/sh",
        &image, "-c",
        "set -eu; for path in apps/local-engine/projects apps/local-engine/dist apps/local-engine/backups apps/local-engine/play-worlds apps/voxa/data; do rm -rf /source/$path; mkdir -p /source/$(dirname $path); ln -s /target/$path /source/$path; done",
    ])?;
    app.progress("complete", "数据目录已迁移，请从服务总览重新启动服务", 100);
    Ok(json!({"path": destination, "usingDefault": false}))
}
pub(crate) fn docker_check() -> (bool, String, String) {
    match Command::new("docker")
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
    {
        Ok(output) if output.status.success() => (
            true,
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
            String::new(),
        ),
        Ok(output) => (
            false,
            String::new(),
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ),
        Err(error) => (false, String::new(), format!("无法运行 Docker：{error}")),
    }
}
pub(crate) fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    OsRng.fill_bytes(&mut value);
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub(crate) fn managed_value(values: &BTreeMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .cloned()
        .filter(|value| !value.trim().is_empty())
}
pub(crate) fn managed_database_identity(
    existing: &BTreeMap<String, String>,
) -> Option<(String, String)> {
    let database = managed_value(existing, "BOX_MANAGED_POSTGRES_DATABASE");
    let user = managed_value(existing, "BOX_MANAGED_POSTGRES_USER");
    if let (Some(database), Some(user)) = (database, user) {
        return Some((database, user));
    }
    existing
        .get("BOX_DATABASE_MODE")
        .is_some_and(|mode| mode == "managed")
        .then(|| {
            Some((
                managed_value(existing, "BOX_DATABASE_NAME")?,
                managed_value(existing, "BOX_DATABASE_USER")?,
            ))
        })
        .flatten()
}
pub(crate) fn managed_database_password(existing: &BTreeMap<String, String>) -> Option<String> {
    managed_value(existing, "BOX_MANAGED_POSTGRES_PASSWORD").or_else(|| {
        existing
            .get("BOX_DATABASE_MODE")
            .is_some_and(|mode| mode == "managed")
            .then(|| managed_value(existing, "BOX_DATABASE_PASSWORD"))
            .flatten()
    })
}
pub(crate) fn managed_redis_password(existing: &BTreeMap<String, String>) -> Option<String> {
    managed_value(existing, "BOX_MANAGED_REDIS_PASSWORD").or_else(|| {
        existing
            .get("BOX_REDIS_MODE")
            .is_some_and(|mode| mode == "managed")
            .then(|| managed_value(existing, "REDIS_PASSWORD"))
            .flatten()
    })
}
pub(crate) fn managed_volume_exists(name: &str) -> bool {
    docker(&["volume", "inspect", name]).is_ok()
}
pub(crate) fn guard_managed_storage_credentials(
    content: &str,
    config: &serde_json::Map<String, Value>,
    postgres_volume_exists: bool,
    _redis_volume_exists: bool,
) -> Result<(), String> {
    let existing = parse_env(&migrate_document(content)?);
    if config.get("databaseMode").and_then(Value::as_str) == Some("managed")
        && postgres_volume_exists
        && (managed_database_identity(&existing).is_none()
            || managed_database_password(&existing).is_none())
    {
        return Err("检测到已有内置 PostgreSQL 数据，但缺少其原始连接凭据。为避免生成不匹配的新账号，已停止保存；请恢复此前的 .env 后重试。".into());
    }
    Ok(())
}

/// The Web console no longer runs on the server's own network namespace, so a
/// container-local probe would return the Docker bridge address (for example
/// 172.18.0.2) instead of the address players actually use. Prefer the value
/// install.sh detected on the host and never fall back to a probe inside a
/// container.
pub(crate) fn compose_file_output(app:&App,file:&FsPath,args:&[String]) -> Result<String,String> {
    let env=generate_runtime_environment(app)?;
    let mut command=Command::new("docker");
    command.args(["compose","--project-name","box-local-engine","--project-directory"]).arg(host_project_root(app)?).arg("--env-file").arg(&env).arg("-f").arg(file).args(args).current_dir(&app.root);
    for key in parse_env(&fs::read_to_string(&env).map_err(|error|error.to_string())?).keys() {command.env_remove(key);}
    let output=command.output().map_err(|error|error.to_string())?;
    if output.status.success() {Ok(String::from_utf8_lossy(&output.stdout).into())} else {Err(String::from_utf8_lossy(&output.stderr).into())}
}

pub(crate) fn configured_lan_ip() -> Option<String> {
    let value = env::var("BOX_LAN_IP").ok()?;
    let value = value.trim();
    (!value.is_empty() && validate_host(value, "局域网地址").is_ok()).then(|| value.to_string())
}
pub(crate) fn in_container() -> bool {
    FsPath::new("/.dockerenv").exists() || FsPath::new("/run/.containerenv").exists()
}
/// Ask the OS which outbound interface it would use. No traffic is sent to the
/// documentation-only probe address; this only reveals the LAN address.
pub(crate) fn detect_lan_ip() -> Option<String> {
    if let Some(value) = configured_lan_ip() {
        return Some(value);
    }
    if in_container() {
        return None;
    }
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    (!address.is_loopback() && !address.is_unspecified()).then(|| address.to_string())
}
use shared_config::validate_host;

pub(crate) fn runtime_env_path(app: &App) -> PathBuf {
    app.root.join(".runtime.env")
}

/// Same limits the desktop launcher enforces, so the Web form cannot persist a
/// configuration the launcher would reject.
pub(crate) fn check_remote_endpoint(label: &str, host: &str, port: u16) -> Result<(), String> {
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析{label}地址 {host}:{port}：{error}"))?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "无法连接{label} {host}:{port}：{}。请检查云安全组、防火墙和监听地址。",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "没有可用地址".into())
    ))
}
/// The five business containers plus the Web manager itself. Managed
/// PostgreSQL/Redis only join the profile set when the operator selects them,
/// otherwise `--remove-orphans` would treat their running containers as
/// orphans and delete them on the next start.
/// Docker only ever consumes this derived file. `.env` stays the single source
/// of truth that the operator edits, while hostnames, origins and public URLs
/// are recomputed from the access modes on every compose call so the Web console
/// and the desktop launcher behave identically.
/// Derives the Docker-consumed `.runtime.env` from the owner-editable `.env`.
/// Secrets stay in the owner document; this function only normalizes and
/// resolves the values services need at runtime.
pub(crate) fn generate_runtime_environment(app: &App) -> Result<PathBuf, String> {
    let owner =
        fs::read_to_string(env_path(app)).map_err(|error| format!("无法读取部署配置：{error}"))?;
    let migrated_owner = migrate_document(&owner)?;
    let values = parse_env(&migrated_owner);
    let lan_ip = detect_lan_ip();
    let image_tag = values
        .get("BOX_IMAGE_TAG")
        .cloned()
        .or_else(|| env::var("BOX_IMAGE_TAG").ok())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into());
    let mut derived = shared_config::runtime_environment(
        &values,
        &shared_config::RuntimeInputs {
            lan_ip: lan_ip.as_deref(),
            image_tag: &image_tag,
            platform: if cfg!(target_arch = "aarch64") {
                "linux/arm64"
            } else {
                "linux/amd64"
            },
            database_required: false,
            web_manager: true,
        },
    )?;
    box_manager_core::ssl::apply_runtime_urls(&app.root, &values, &mut derived)?;
    let mut runtime = migrated_owner.clone();
    for (key, value) in derived {
        runtime = set_env(runtime, &key, &value)?;
    }
    let path = runtime_env_path(app);
    private(&path, &runtime)?;
    // Persist migration markers only after all derivation and runtime writing
    // succeed, so a rejected configuration does not silently change the owner.
    if migrated_owner != owner {
        private(&env_path(app), &migrated_owner)?;
    }
    Ok(path)
}
/// Pure form-to-owner transformation, shared by the HTTP save path and fixtures.
pub(crate) fn configuration_document_for_save(
    content: &str,
    config: &serde_json::Map<String, Value>,
) -> Result<String, String> {
    let prepared = box_manager_core::public_access::prepare(config)?;
    let config = &prepared;
    let mut source = migrate_document(content)?;
    clear_overrides_on_configuration_change(&mut source, config)?;
    let existing = parse_env(&source);
    let original_database_mode=existing.get("BOX_DATABASE_MODE").cloned();

    if let Some(value) = config.get("authPortalImage") {
        let image = box_manager_core::auth_portal::normalize_image(
            value.as_str().ok_or("登录页面镜像必须是字符串")?,
            existing.get("BOX_IMAGE_TAG").map(String::as_str).unwrap_or(""),
        )?;
        if image.is_empty() {
            box_manager_core::environment::remove_env(&mut source, "BOX_AUTH_PORTAL_IMAGE");
        } else {
            source = set_env(source, "BOX_AUTH_PORTAL_IMAGE", &image)?;
        }
    }
    let database_mode = config
        .get("databaseMode")
        .and_then(Value::as_str)
        .unwrap_or_else(|| existing.get("BOX_DATABASE_MODE").map(String::as_str).unwrap_or("external"));
    let redis_mode = config
        .get("redisMode")
        .and_then(Value::as_str)
        .unwrap_or_else(|| existing.get("BOX_REDIS_MODE").map(String::as_str).unwrap_or("disabled"));
    if !["managed", "external"].contains(&database_mode) {
        return Err("数据库模式无效".into());
    }
    if !["disabled", "managed", "external"].contains(&redis_mode) {
        return Err("Redis 模式无效".into());
    }
    source = set_env(source, "BOX_DATABASE_MODE", database_mode)?;
    source = set_env(source, "BOX_REDIS_MODE", redis_mode)?;
    for (input, key) in [
        ("playPort", "BOX_PLAY_PORT"),
        ("creatorPort", "BOX_CREATOR_PORT"),
        ("voxaPort", "BOX_VOXA_PORT"),
        ("playerServicePort", "BOX_PLAYER_SERVICE_PORT"),
        ("authPortalPort", "BOX_AUTH_PORTAL_PORT"),
    ] {
        if let Some(value) = config.get(input) {
            source = set_env(source, key, &port(value, input)?)?;
        }
    }
    for (input, key) in [
        ("redisHost", "REDIS_HOST"),
        ("redisPort", "REDIS_PORT"),
        ("redisDb", "REDIS_DB"),
        ("storageCacheRedisDb", "STORAGE_CACHE_REDIS_DB"),
        ("storageCacheRedisTtl", "STORAGE_CACHE_REDIS_TTL"),
        ("databasePoolSize", "BOX_DATABASE_POOL_SIZE"),
        ("publicHost", "BOX_PLAY_PUBLIC_HOST"),
        ("playNetworkMode", "BOX_PLAY_NETWORK_MODE"),
        ("creatorHost", "BOX_CREATOR_HOST"),
        ("creatorNetworkMode", "BOX_CREATOR_NETWORK_MODE"),
        ("creatorEditRuntimes", "BOX_CREATOR_EDIT_MAX_RUNTIMES"),
        ("creatorPlayRuntimes", "BOX_CREATOR_PLAY_MAX_RUNTIMES"),
        (
            "creatorEditPrewarmRuntimes",
            "BOX_CREATOR_EDIT_PREWARM_RUNTIMES",
        ),
        ("playRuntimes", "BOX_PLAY_MAX_RUNTIMES"),
        ("playPrewarmRuntimes", "BOX_PLAY_PREWARM_RUNTIMES"),
        ("playerLimit", "BOX_LOCAL_PLAYER_LIMIT"),
        ("teleportMaxRooms", "BOX_TELEPORT_MAX_ROOMS"),
        ("scriptMemoryMb", "BOX_SCRIPT_MEMORY_MB"),
        (
            "autoBackupIntervalMinutes",
            "BOX_AUTO_BACKUP_INTERVAL_MINUTES",
        ),
        (
            "autoBackupRetentionCount",
            "BOX_AUTO_BACKUP_RETENTION_COUNT",
        ),
        ("autoBackupRetentionDays", "BOX_AUTO_BACKUP_RETENTION_DAYS"),
    ] {
        if let Some(value) = config.get(input) {
            source = set_env(source, key, &json_value(value)?)?;
        }
    }
    for (input, key) in [
        ("runtimeIdleMinutes", "BOX_RUNTIME_IDLE_TIMEOUT_MS"),
        ("runtimeStartTimeoutMinutes", "BOX_RUNTIME_START_TIMEOUT_MS"),
        (
            "teleportRoomIdleMinutes",
            "BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS",
        ),
    ] {
        if let Some(value) = config.get(input) {
            let minutes = json_value(value)?
                .parse::<u64>()
                .map_err(|_| format!("{input} 必须是有效分钟数"))?;
            if minutes == 0 {
                return Err(format!("{input} 必须大于 0"));
            }
            source = set_env(source, key, &minutes.saturating_mul(60_000).to_string())?;
        }
    }
    for (input, key) in [
        ("playerServiceMemoryMb", "BOX_PLAYER_SERVICE_MEMORY_LIMIT"),
        ("authPortalMemoryMb", "BOX_AUTH_PORTAL_MEMORY_LIMIT"),
        ("creatorMemoryMb", "BOX_CREATOR_MEMORY_LIMIT"),
        ("playMemoryMb", "BOX_PLAY_MEMORY_LIMIT"),
    ] {
        if let Some(value) = config.get(input) {
            source = set_env(source, key, &format!("{}m", json_value(value)?))?;
        }
    }
    for (input, key) in [
        ("playerServiceCpuLimit", "BOX_PLAYER_SERVICE_CPU_LIMIT"),
        ("authPortalCpuLimit", "BOX_AUTH_PORTAL_CPU_LIMIT"),
        ("creatorCpuLimit", "BOX_CREATOR_CPU_LIMIT"),
        ("playCpuLimit", "BOX_PLAY_CPU_LIMIT"),
    ] {
        if let Some(value) = config.get(input) {
            source = set_env(source, key, &json_value(value)?)?;
        }
    }
    for (input, key, inverted) in [
        ("databaseSsl", "BOX_DATABASE_SSL", false),
        ("autoBackupEnabled", "BOX_AUTO_BACKUP_ENABLED", false),
        (
            "registrationEnabled",
            "BOX_PLAYER_REGISTRATION_ENABLED",
            false,
        ),
    ] {
        if let Some(value) = config.get(input).and_then(Value::as_bool) {
            source = set_env(source, key, if value ^ inverted { "true" } else { "false" })?;
        }
    }
    box_manager_core::environment::remove_env(&mut source, "BOX_PLAY_LIBRARY_READ_ONLY");
    for (input, key) in [
        ("databasePassword", "BOX_DATABASE_PASSWORD"),
        ("redisPassword", "REDIS_PASSWORD"),
        ("permissionTokenSecret", "PERMISSION_TOKEN_SECRET"),
        ("playerAuthApiKey", "BOX_PLAYER_AUTH_API_KEY"),
        ("playAdminToken", "BOX_PLAY_ADMIN_TOKEN"),
    ] {
        if let Some(value) = config
            .get(input)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            source = set_env(source, key, value)?;
        }
    }
    if database_mode == "managed" {
        let (database, user) = managed_database_identity(&existing).unwrap_or_else(|| {
            (
                format!("box_db_{}", random_hex(8)),
                format!("box_user_{}", random_hex(8)),
            )
        });
        let password = managed_database_password(&existing).unwrap_or_else(|| random_hex(32));
        source = set_env(source, "BOX_DATABASE_HOST", "managed-postgres")?;
        source = set_env(source, "BOX_DATABASE_PORT", "5432")?;
        source = set_env(source, "BOX_DATABASE_NAME", &database)?;
        source = set_env(source, "BOX_DATABASE_USER", &user)?;
        source = set_env(source, "BOX_DATABASE_PASSWORD", &password)?;
        source = set_env(source, "BOX_MANAGED_POSTGRES_DATABASE", &database)?;
        source = set_env(source, "BOX_MANAGED_POSTGRES_USER", &user)?;
        source = set_env(source, "BOX_MANAGED_POSTGRES_PASSWORD", &password)?;
        source = set_env(
            source,
            "BOX_DATABASE_URL",
            &format!(
                "postgres://{}:{}@managed-postgres:5432/{}",
                urlencoding::encode(&user),
                urlencoding::encode(&password),
                urlencoding::encode(&database)
            ),
        )?;
        source = set_env(source, "BOX_DATABASE_SSL", "false")?;
    } else if let Some(host) = config.get("databaseHost") {
        let host = json_value(host)?;
        if host.is_empty() {
            source = set_env(source, "BOX_DATABASE_URL", "")?;
        } else {
            let existing = parse_env(&source);
            let (_, old_port, old_name, old_user, old_password) =
                database_fields(existing.get("BOX_DATABASE_URL"));
            let database_port = config
                .get("databasePort")
                .map(|value| port(value, "数据库端口"))
                .transpose()?
                .unwrap_or(old_port);
            let database_name = config
                .get("databaseName")
                .map(json_value)
                .transpose()?
                .unwrap_or(old_name);
            let database_user = config
                .get("databaseUser")
                .map(json_value)
                .transpose()?
                .unwrap_or(old_user);
            let database_password = config
                .get("databasePassword")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| (original_database_mode.as_deref()!=Some("managed")).then(|| existing.get("BOX_DATABASE_PASSWORD").cloned().unwrap_or(old_password)))
                .unwrap_or_default();
            let authority = if database_user.is_empty() {
                box_manager_core::configuration::origin_host(&host)?
            } else {
                format!(
                    "{}:{}@{}",
                    urlencoding::encode(&database_user),
                    urlencoding::encode(&database_password),
                    box_manager_core::configuration::origin_host(&host)?
                )
            };
            source = set_env(source, "BOX_DATABASE_HOST", &host)?;
            source = set_env(source, "BOX_DATABASE_PORT", &database_port)?;
            source = set_env(source, "BOX_DATABASE_NAME", &database_name)?;
            source = set_env(source, "BOX_DATABASE_USER", &database_user)?;
            source = set_env(source, "BOX_DATABASE_PASSWORD", &database_password)?;
            source = set_env(
                source,
                "BOX_DATABASE_URL",
                &format!(
                    "postgres://{authority}:{database_port}/{}",
                    urlencoding::encode(&database_name)
                ),
            )?;
        }
    }
    if redis_mode == "managed" {
        let password = config.get("redisPassword").and_then(Value::as_str).filter(|password| !password.is_empty()).map(str::to_string).or_else(|| managed_redis_password(&existing)).unwrap_or_else(|| random_hex(32));
        source = set_env(source, "REDIS_HOST", "managed-redis")?;
        source = set_env(source, "REDIS_PORT", "6379")?;
        source = set_env(source, "REDIS_PASSWORD", &password)?;
        source = set_env(source, "BOX_MANAGED_REDIS_PASSWORD", &password)?;
        source = set_env(source, "REDIS_DB", "0")?;
        source = set_env(source, "STORAGE_CACHE_REDIS_DB", "1")?;
        source = set_env(source, "STORAGE_CACHE_REDIS_TTL", "240")?;
    } else if redis_mode == "disabled" {
        source = set_env(source, "REDIS_HOST", "")?;
        source = set_env(source, "REDIS_PASSWORD", "")?;
    }
    if redis_mode=="external" && existing.get("BOX_REDIS_MODE").map(String::as_str)==Some("managed") && config.get("redisPassword").and_then(Value::as_str).is_none_or(|password| password.is_empty()) {
        source = set_env(source,"REDIS_PASSWORD","")?;
    }
    if let Some(host) = config.get("publicHost") {
        let host = json_value(host)?;
        let port = config
            .get("playPort")
            .map(|value| port(value, "Play 端口"))
            .transpose()?
            .unwrap_or_else(|| "3121".into());
        source = set_env(
            source,
            "BOX_PLAY_PUBLIC_URL",
            &format!("http://{host}:{port}"),
        )?;
        let bind = if config.get("playNetworkMode").and_then(Value::as_str) == Some("local") {
            "127.0.0.1"
        } else {
            "0.0.0.0"
        };
        source = set_env(source, "BOX_BIND_IP", bind)?;
    }
    if let Some(host) = config.get("creatorHost") {
        let host = json_value(host)?;
        let port = config
            .get("creatorPort")
            .map(|value| port(value, "Creator 端口"))
            .transpose()?
            .unwrap_or_else(|| "3127".into());
        source = set_env(
            source,
            "BOX_CREATOR_PUBLIC_URL",
            &format!("http://{host}:{port}"),
        )?;
        let bind = if config.get("creatorNetworkMode").and_then(Value::as_str) == Some("local") {
            "127.0.0.1"
        } else {
            "0.0.0.0"
        };
        source = set_env(source, "BOX_CREATOR_BIND_IP", bind)?;
        source = set_env(source, "BOX_VOXA_BIND_IP", bind)?;
    }
    if let Some(value) = config.get("registrationEnabled").and_then(Value::as_bool) {
        source = set_env(
            source,
            "BOX_PLAYER_REGISTRATION_ENABLED",
            if value { "true" } else { "false" },
        )?;
    }
    box_manager_core::environment::remove_env(&mut source, "BOX_PLAY_LIBRARY_READ_ONLY");
    // The desktop launcher keeps the script heap limit in step with
    // the memory limit; the runtime reads BOX_SCRIPT_HEAP_MB.
    if let Some(value) = config.get("scriptMemoryMb") {
        source = set_env(source, "BOX_SCRIPT_HEAP_MB", &json_value(value)?)?;
    }
    if database_mode == "managed" {
        box_manager_core::environment::remove_env(&mut source, "BOX_DATABASE_QUERY");
    }
    // New GUI requests include the public draft separately. Older partial public
    // requests keep their independent host fields for backwards compatibility.
    let mode = config.get("playNetworkMode").and_then(Value::as_str);
    if config.contains_key("publicAddress") || matches!(mode, Some("local" | "lan")) {
        let current = parse_env(&source);
        let address = box_manager_core::configuration::independent_public_base(config)?.or_else(|| config.get("publicAddress").and_then(Value::as_str)
            .map(str::to_string)
        ).unwrap_or_else(|| box_manager_core::access_settings::public_address(&existing));
        let play_mode = current.get("BOX_PLAY_NETWORK_MODE").map(String::as_str).unwrap_or("local");
        let creator_mode = current.get("BOX_CREATOR_NETWORK_MODE").map(String::as_str).unwrap_or(play_mode);
        source = box_manager_core::access_settings::save(&source, &address, play_mode, creator_mode, detect_lan_ip().as_deref())?;
    }
    for (field, prefix) in [
        ("playPublicAddressOverride", "BOX_PLAY"),
        ("creatorPublicAddressOverride", "BOX_CREATOR"),
        ("voxaPublicAddressOverride", "BOX_VOXA"),
        ("playerServicePublicAddressOverride", "BOX_PLAYER_SERVICE"),
        ("authPortalPublicAddressOverride", "BOX_AUTH_PORTAL"),
    ] {
        if let Some(value) = config.get(field) {
            let address = box_manager_core::configuration::validate_public_address_override(value.as_str().ok_or("公网地址必须是字符串")?, field)?;
            box_manager_core::environment::remove_env(&mut source, &format!("{prefix}_PUBLIC_HOST_OVERRIDE"));
            box_manager_core::environment::remove_env(&mut source, &format!("{prefix}_PUBLIC_URL_OVERRIDE"));
            source = set_env(source, &format!("{prefix}_PUBLIC_ADDRESS_OVERRIDE"), &address)?;
        }
    }
    source = box_manager_core::public_access::save_document(&source, config)?;
    if config.get("externalNginxManual").and_then(Value::as_bool)==Some(true) {
        return box_manager_core::access_settings::preserve_network(content,&source);
    }
    Ok(box_manager_core::access_settings::independent_owner(&source))
}

pub(crate) fn managed_image(
    values: &BTreeMap<String, String>,
    service: &str,
) -> Result<String, String> {
    match service {
        "postgresql" => Ok(values
            .get("BOX_POSTGRES_IMAGE")
            .cloned()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "docker.m.daocloud.io/library/postgres:16-alpine".into())),
        "redis" => Ok(values
            .get("BOX_REDIS_IMAGE")
            .cloned()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "docker.m.daocloud.io/library/redis:7-alpine".into())),
        _ => Err("只支持内置 PostgreSQL 或 Redis".into()),
    }
}
pub(crate) fn managed_service_name(service: &str) -> Result<&'static str, String> {
    match service {
        "postgresql" => Ok("managed-postgres"),
        "redis" => Ok("managed-redis"),
        _ => Err("只支持内置 PostgreSQL 或 Redis".into()),
    }
}
pub(crate) fn managed_running(service: &str) -> bool {
    docker(&[
        "ps",
        "--filter",
        "label=com.docker.compose.project=box-local-engine",
        "--filter",
        &format!("label=com.docker.compose.service={service}"),
        "--filter",
        "status=running",
        "--format",
        "{{.ID}}",
    ])
    .is_ok_and(|output| !output.is_empty())
}
pub(crate) fn managed_service_info(app: &App, service: &str) -> Result<Value, String> {
    let values = parse_env(&fs::read_to_string(env_path(app)).unwrap_or_default());
    let image = managed_image(&values, service)?;
    let image_available = docker(&["image", "inspect", &image]).is_ok();
    match service {
        "postgresql" => {
            let database = values
                .get("BOX_MANAGED_POSTGRES_DATABASE")
                .or_else(|| values.get("BOX_DATABASE_NAME"))
                .cloned()
                .unwrap_or_else(|| "box".into());
            let user = values
                .get("BOX_MANAGED_POSTGRES_USER")
                .or_else(|| values.get("BOX_DATABASE_USER"))
                .cloned()
                .unwrap_or_else(|| "box".into());
            let password = values
                .get("BOX_MANAGED_POSTGRES_PASSWORD")
                .or_else(|| values.get("BOX_DATABASE_PASSWORD"))
                .cloned()
                .unwrap_or_default();
            let port = values
                .get("BOX_MANAGED_POSTGRES_HOST_PORT")
                .cloned()
                .unwrap_or_else(|| "5432".into());
            let configured = values
                .get("BOX_DATABASE_MODE")
                .is_some_and(|mode| mode == "managed")
                && !password.is_empty();
            Ok(json!({
                "imageAvailable": image_available,
                "configured": configured,
                "running": managed_running("managed-postgres"),
                "host": "127.0.0.1",
                "port": port,
                "database": database,
                "user": user,
                "password": password,
                "connectionUrl": if configured { format!("postgresql://{}:{}@127.0.0.1:{}/{}", urlencoding::encode(&user), urlencoding::encode(&password), port, urlencoding::encode(&database)) } else { String::new() }
            }))
        }
        "redis" => {
            let password = values
                .get("BOX_MANAGED_REDIS_PASSWORD")
                .or_else(|| values.get("REDIS_PASSWORD"))
                .cloned()
                .unwrap_or_default();
            let port = values
                .get("BOX_MANAGED_REDIS_HOST_PORT")
                .cloned()
                .unwrap_or_else(|| "6379".into());
            let database = values
                .get("REDIS_DB")
                .cloned()
                .unwrap_or_else(|| "0".into());
            let configured = values
                .get("BOX_REDIS_MODE")
                .is_some_and(|mode| mode == "managed")
                && !password.is_empty();
            Ok(json!({
                "imageAvailable": image_available,
                "configured": configured,
                "running": managed_running("managed-redis"),
                "host": "127.0.0.1",
                "port": port,
                "database": database,
                "user": "",
                "password": password,
                "connectionUrl": if configured { format!("redis://:{}@127.0.0.1:{}/{}", urlencoding::encode(&password), port, database) } else { String::new() }
            }))
        }
        _ => unreachable!(),
    }
}
pub(crate) fn prepare_managed_service(app: &App, service: &str) -> Result<(), String> {
    app.progress("managed-check", "正在检查内置服务镜像…", 10);
    let values = parse_env(&fs::read_to_string(env_path(app)).unwrap_or_default());
    let image = managed_image(&values, service)?;
    docker(&["info", "--format", "{{.ServerVersion}}"])?;
    if docker(&["image", "inspect", &image]).is_err() {
        app.progress(
            "dependency-image-download",
            "正在准备下载内置服务镜像，可能需要几分钟，请耐心等待…",
            1,
        );
        let label = if service == "postgresql" { "PostgreSQL" } else { "Redis" };
        pull_image_with_progress(&image, label, &mut |percent, message| {
            app.progress("dependency-image-download", &message, percent)
        })?;
    }
    Ok(())
}
pub(crate) fn start_managed_service(app: &App, service: &str) -> Result<(), String> {
    let values = parse_env(&fs::read_to_string(env_path(app)).unwrap_or_default());
    let compose_service = managed_service_name(service)?;
    let mode_key = if service == "postgresql" {
        "BOX_DATABASE_MODE"
    } else {
        "BOX_REDIS_MODE"
    };
    if !values.get(mode_key).is_some_and(|mode| mode == "managed") {
        return Err("请先保存内置服务配置".into());
    }
    compose(app, &["up", "-d", "--wait", compose_service])?;
    Ok(())
}
pub(crate) fn private(path: &FsPath, value: &str) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("无效路径")?).map_err(|e| e.to_string())?;
    remove_empty_file_placeholder(path)?;
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), random_hex(8)));
    fs::write(&tmp, value).map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(tmp);
        return Err(error.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Docker creates a directory when a configured bind-mounted file does not
/// exist yet. Treat only an empty real directory as that placeholder; links or
/// directories containing data remain hard errors.
pub(crate) fn remove_empty_file_placeholder(path: &FsPath) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_dir() {
        return Ok(());
    }
    let mut entries = fs::read_dir(path).map_err(|error| error.to_string())?;
    if entries.next().is_some() {
        return Err(format!("{} 应为文件，但当前是非空目录", path.display()));
    }
    fs::remove_dir(path).map_err(|error| error.to_string())
}
