//! Release-pinned image downloads. Only verified complete files reach Docker.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageRelease {
    pub format_version: u8,
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub image_id: String,
    #[serde(default)]
    pub image_ids: Vec<String>,
    pub archive: String,
    pub sha256: String,
    pub image_tag: String,
    pub platform: String,
    pub size: u64,
    #[serde(default)]
    pub download_base_url: Option<String>,
}

impl ImageRelease {
    pub fn download_url(&self) -> Result<String, String> {
        let staging = self.image_tag.contains("-staging-linux-");
        if staging != self.download_base_url.as_deref().is_some_and(|base| base.starts_with("https://assets.box3.fun/local-engine-staging/")) {
            return Err("镜像下载渠道与版本不一致".into());
        }
        crate::image_source::download_url(self.download_base_url.as_deref(), &self.archive)
    }
    pub fn accepts(&self, id: &str) -> bool {
        self.image_id == id || self.image_ids.iter().any(|value| value == id)
    }
    pub fn references(&self) -> Vec<&str> {
        std::iter::once(self.image_id.as_str())
            .chain(self.image_ids.iter().map(String::as_str))
            .collect()
    }
    pub fn content_reference(&self) -> String {
        format!("{}:launcher-content-{}", self.image, &self.image_id[7..])
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageCatalog {
    pub format_version: u8,
    pub image_tag: String,
    pub platform: String,
    pub images: Vec<ImageRelease>,
}

impl ImageCatalog {
    pub fn validate(&self, architecture: &str) -> Result<(), String> {
        let names = [
            "creator",
            "voxa",
            "play",
            "player-service",
            "player-auth-portal",
            "server-manager",
        ];
        if self.format_version != 2
            || self.platform != format!("linux/{architecture}")
            || self.images.len() != names.len()
            || self.image_tag.is_empty()
        {
            return Err("镜像更新清单格式或架构无效".into());
        }
        for service in names {
            let matching: Vec<_> = self
                .images
                .iter()
                .filter(|i| i.image == format!("box-local-engine-{service}"))
                .collect();
            if matching.len() != 1 {
                return Err(format!("镜像更新清单缺少或重复服务：{service}"));
            }
            let image = matching[0];
            image.download_url()?;
            let digest = image
                .image_id
                .strip_prefix("sha256:")
                .ok_or("镜像摘要格式无效")?;
            if digest.len() != 64
                || !digest.bytes().all(|b| b.is_ascii_hexdigit())
                || image.archive
                    != format!(
                        "box-local-engine-image-{service}-{architecture}-{}.tar.gz",
                        image.sha256
                    )
                || image.platform != self.platform
                || image.format_version != 1
                || image.image_ids.is_empty()
                || image.image_ids.len() > 2
                || !image.image_ids.contains(&image.image_id)
                || image.image_ids.iter().any(|id| {
                    !id.strip_prefix("sha256:").is_some_and(|digest| {
                        digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                })
                || image.image_tag.is_empty()
                || image.size == 0
                || image.sha256.len() != 64
                || !image.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(format!("镜像更新清单无效：{service}"));
            }
        }
        Ok(())
    }
}

pub(crate) fn embedded_release() -> Result<Option<ImageCatalog>, String> {
    option_env!("BOX_MANAGER_REMOTE_IMAGE")
        .map(|value| {
            serde_json::from_str(value).map_err(|error| format!("镜像下载信息无效：{error}"))
        })
        .transpose()
}

fn verified(path: &Path, release: &ImageRelease) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    if file.metadata().map(|meta| meta.len()).ok() != Some(release.size) {
        return false;
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 128 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => digest.update(&buffer[..length]),
            Err(_) => return false,
        }
    }
    format!("{:x}", digest.finalize()).eq_ignore_ascii_case(&release.sha256)
}

#[cfg(test)]
fn write_download(
    source: impl Read,
    path: &Path,
    release: &ImageRelease,
    progress: impl FnMut(u64),
) -> Result<(), String> {
    write_download_at(source, path, release, 0, progress)
}

fn write_download_at(
    mut source: impl Read,
    path: &Path,
    release: &ImageRelease,
    offset: u64,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let mut digest = Sha256::new();
    let mut buffer = [0; 128 * 1024];
    if offset > 0 {
        let mut prefix = fs::File::open(path).map_err(|e| e.to_string())?;
        std::io::copy(&mut prefix, &mut HashWriter(&mut digest))
            .map_err(|e| format!("无法校验下载断点：{e}"))?;
    }
    let mut file = if offset == 0 {
        fs::File::create(path)
    } else {
        fs::OpenOptions::new().append(true).open(path)
    }
    .map_err(|e| e.to_string())?;
    let mut total = offset;
    progress(total);
    loop {
        let length = source
            .read(&mut buffer)
            .map_err(|e| format!("镜像下载中断，请重试：{e}"))?;
        if length == 0 {
            break;
        }
        total = total.checked_add(length as u64).ok_or("镜像大小无效")?;
        if total > release.size {
            drop(file);
            let _ = fs::remove_file(path);
            return Err("镜像下载大小超过发行清单，请重试".into());
        }
        file.write_all(&buffer[..length])
            .map_err(|e| format!("无法保存镜像：{e}"))?;
        digest.update(&buffer[..length]);
        progress(total);
    }
    if total != release.size {
        return Err("镜像下载中断，已保留下载进度，请重试".into());
    }
    if !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(&release.sha256) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err("镜像完整性校验失败，请重试下载".into());
    }
    file.sync_all().map_err(|e| e.to_string())
}

struct HashWriter<'a>(&'a mut Sha256);
impl Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn valid_content_range(response: &reqwest::blocking::Response, offset: u64, size: u64) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == format!("bytes {offset}-{}/{size}", size.saturating_sub(1)))
}

pub(crate) fn download(
    release: &ImageRelease,
    cache: &Path,
    progress: impl FnMut(u64),
) -> Result<PathBuf, String> {
    download_from_url(release, cache, &release.download_url()?, progress)
}

pub(super) fn download_from_url(
    release: &ImageRelease,
    cache: &Path,
    url: &str,
    mut progress: impl FnMut(u64),
) -> Result<PathBuf, String> {
    fs::create_dir_all(cache).map_err(|e| format!("无法创建镜像下载目录：{e}"))?;
    let destination = cache.join(&release.archive);
    if verified(&destination, release) {
        return Ok(destination);
    }
    let partial = destination.with_extension("part");
    let mut offset = fs::metadata(&partial).map(|meta| meta.len()).unwrap_or(0);
    if offset >= release.size {
        if verified(&partial, release) {
            if destination.exists() {
                fs::remove_file(&destination).map_err(|e| e.to_string())?;
            }
            fs::rename(&partial, &destination).map_err(|e| e.to_string())?;
            progress(release.size);
            return Ok(destination);
        }
        fs::remove_file(&partial).map_err(|e| e.to_string())?;
        offset = 0;
    }
    progress(offset);
    (|| {
        let client = reqwest::blocking::Client::builder();
        // Unit fixtures use loopback HTTP and must not inherit host-wide proxies.
        #[cfg(test)]
        let client = client.no_proxy();
        let client = client
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(3600))
            .build()
            .map_err(|e| e.to_string())?;
        let request = |offset: u64| {
            let mut request = client
                .get(url)
                .header(reqwest::header::ACCEPT_ENCODING, "identity");
            if offset > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            }
            request
                .send()
                .map_err(|e| format!("无法下载镜像，已保留下载进度：{e}"))
        };
        let mut response = request(offset)?;
        if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
            // An origin that cannot serve this range must be retried as a full
            // download. Never append an HTTP error body to the partial file.
            offset = 0;
            response = request(0)?;
        }
        if !matches!(
            response.status(),
            reqwest::StatusCode::OK | reqwest::StatusCode::PARTIAL_CONTENT
        ) {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(format!("镜像下载失败（HTTP {status}）：{}", body.trim()));
        }
        if response.status() == reqwest::StatusCode::OK {
            // Servers may ignore Range. Replace the prefix rather than append.
            offset = 0;
        } else if !valid_content_range(&response, offset, release.size) {
            return Err("镜像续传响应范围无效，已保留下载进度，请重试".into());
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|value| value != "identity")
        {
            return Err("镜像下载响应编码无效，请重试".into());
        }
        write_download_at(response, &partial, release, offset, &mut progress)?;
        if destination.exists() {
            fs::remove_file(&destination).map_err(|e| e.to_string())?;
        }
        fs::rename(&partial, &destination).map_err(|e| e.to_string())?;
        Ok(destination)
    })()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn testing_download_source_survives_installer_json_deserialization() {
        let source = "https://assets.box3.fun/local-engine-staging/v0.3.0-staging/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let image: ImageRelease = serde_json::from_value(serde_json::json!({
            "formatVersion": 1,
            "image": "box-local-engine-play",
            "imageId": format!("sha256:{}", "a".repeat(64)),
            "imageIds": [format!("sha256:{}", "a".repeat(64))],
            "archive": "test-image.tar.gz",
            "sha256": "b".repeat(64),
            "imageTag": "v0.3.0-staging-linux-arm64",
            "platform": "linux/arm64",
            "size": 5,
            "downloadBaseUrl": source
        }))
        .unwrap();
        assert_eq!(
            image.download_url().unwrap(),
            format!("{source}/test-image.tar.gz")
        );
    }
    fn release() -> ImageRelease {
        ImageRelease {
            format_version: 1,
            image: "box-local-engine-play".into(),
            image_id: format!("sha256:{}", "a".repeat(64)),
            image_ids: vec![format!("sha256:{}", "a".repeat(64))],
            archive: "box-local-engine-images-v0.3.0-linux-arm64.tar.gz".into(),
            sha256: format!("{:x}", Sha256::digest(b"image")),
            image_tag: "v0.3.0-linux-arm64".into(),
            platform: "linux/arm64".into(),
            size: 5,
            download_base_url: None,
        }
    }
    #[test]
    fn catalog_rejects_duplicate_missing_images_wrong_architecture_and_archive_paths() {
        let names = [
            "creator",
            "voxa",
            "play",
            "player-service",
            "player-auth-portal",
            "server-manager",
        ];
        let mut catalog = ImageCatalog {
            format_version: 2,
            image_tag: "release".into(),
            platform: "linux/arm64".into(),
            images: names
                .iter()
                .map(|name| ImageRelease {
                    image: format!("box-local-engine-{name}"),
                    archive: format!(
                        "box-local-engine-image-{name}-arm64-{}.tar.gz",
                        release().sha256
                    ),
                    ..release()
                })
                .collect(),
        };
        assert!(catalog.validate("arm64").is_ok());
        assert!(catalog.validate("amd64").is_err());
        catalog.images[0].archive = "../outside.tar.gz".into();
        assert!(catalog.validate("arm64").is_err());
        catalog.images[0] = ImageRelease {
            image: "box-local-engine-play".into(),
            ..release()
        };
        assert!(catalog.validate("arm64").is_err());
        catalog.images.pop();
        assert!(catalog.validate("arm64").is_err());
    }
    #[test]
    fn verifies_stream_and_rejects_truncation_corruption_and_oversize() {
        let dir = std::env::temp_dir().join(format!("box-image-download-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.part");
        let r = release();
        for data in [b"imag".as_slice(), b"wrong", b"images"] {
            assert!(write_download(data, &path, &r, |_| {}).is_err());
            assert!(!verified(&path, &r));
        }
        write_download(b"image".as_slice(), &path, &r, |_| {}).unwrap();
        assert!(verified(&path, &r));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn http_download_preserves_interrupted_progress_and_reuses_verified_cache() {
        use std::net::TcpListener;
        let dir = std::env::temp_dir().join(format!("box-image-http-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let r = release();
        let destination = dir.join(&r.archive);
        let partial = destination.with_extension("part");
        fs::write(&destination, b"old").unwrap();
        for (status, body, expected_ok) in [
            ("200 OK", "wrong", false),
            ("200 OK", "imag", false),
            ("503 Unavailable", "error", false),
            ("302 Found", "image", false),
            ("200 OK", "image", true),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                socket.read(&mut request).unwrap();
                write!(
                    socket,
                    "HTTP/1.1 {status}\r\nContent-Length: 5\r\nConnection: close\r\n\r\n{body}"
                )
                .unwrap();
            });
            let result = download_from_url(&r, &dir, &url, |_| {});
            server.join().unwrap();
            assert_eq!(result.is_ok(), expected_ok);
            if body == "imag" || status.starts_with("503") || status.starts_with("302") {
                assert_eq!(fs::read(&partial).unwrap(), b"imag");
            } else {
                assert!(!partial.exists());
            }
            if !expected_ok {
                assert_eq!(fs::read(&destination).unwrap(), b"old");
            }
        }
        // A dead endpoint proves that retrying Docker import reuses verified bytes.
        assert!(download_from_url(&r, &dir, "http://127.0.0.1:1", |_| {}).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    fn response_once(
        status: &'static str,
        headers: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            write!(
                socket,
                "HTTP/1.1 {status}\r\n{headers}\r\nConnection: close\r\n\r\n{body}"
            )
            .unwrap();
            String::from_utf8(request).unwrap().to_lowercase()
        });
        (url, server)
    }

    #[test]
    fn interrupted_http_download_resumes_with_range_and_hashes_the_whole_file() {
        let dir = std::env::temp_dir().join(format!("box-image-resume-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let r = release();
        let destination = dir.join(&r.archive);
        let partial = destination.with_extension("part");
        let (url, server) = response_once("200 OK", "Content-Length: 5", "im");
        assert!(download_from_url(&r, &dir, &url, |_| {}).is_err());
        assert!(!server.join().unwrap().contains("range:"));
        assert_eq!(fs::read(&partial).unwrap(), b"im");
        let (url, server) = response_once(
            "206 Partial Content",
            "Content-Length: 3\r\nContent-Range: bytes 2-4/5",
            "age",
        );
        let mut ticks = Vec::new();
        download_from_url(&r, &dir, &url, |bytes| ticks.push(bytes)).unwrap();
        assert!(server.join().unwrap().contains("range: bytes=2-\r\n"));
        assert_eq!(ticks.first(), Some(&2));
        assert_eq!(ticks.last(), Some(&5));
        assert_eq!(fs::read(&destination).unwrap(), b"image");
        assert!(!partial.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn range_ignored_restarts_while_invalid_range_keeps_the_prefix_and_corruption_discards_it() {
        let dir =
            std::env::temp_dir().join(format!("box-image-range-fallback-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let r = release();
        let destination = dir.join(&r.archive);
        let partial = destination.with_extension("part");
        for (status, headers, body, ok, preserved) in [
            (
                "206 Partial Content",
                "Content-Length: 3\r\nContent-Range: bytes 1-3/5",
                "age",
                false,
                true,
            ),
            (
                "206 Partial Content",
                "Content-Length: 3\r\nContent-Range: bytes 2-4/5",
                "bad",
                false,
                false,
            ),
            ("200 OK", "Content-Length: 5", "image", true, false),
        ] {
            fs::write(&partial, b"im").unwrap();
            let (url, server) = response_once(status, headers, body);
            assert_eq!(download_from_url(&r, &dir, &url, |_| {}).is_ok(), ok);
            assert!(server.join().unwrap().contains("range: bytes=2-\r\n"));
            assert_eq!(partial.exists(), preserved);
            if preserved {
                assert_eq!(fs::read(&partial).unwrap(), b"im");
            }
        }
        assert_eq!(fs::read(&destination).unwrap(), b"image");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn complete_partial_is_verified_and_promoted_without_a_network_request() {
        let dir =
            std::env::temp_dir().join(format!("box-image-complete-partial-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let r = release();
        let destination = dir.join(&r.archive);
        let partial = destination.with_extension("part");
        fs::write(&partial, b"image").unwrap();
        download_from_url(&r, &dir, "http://127.0.0.1:1", |_| {}).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"image");
        assert!(!partial.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejected_range_falls_back_to_a_fresh_request_without_appending_error_bytes() {
        use std::net::TcpListener;
        let dir =
            std::env::temp_dir().join(format!("box-image-range-rejected-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let r = release();
        let destination = dir.join(&r.archive);
        fs::write(destination.with_extension("part"), b"im").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in [
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nimage",
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                requests.push(String::from_utf8(request).unwrap().to_lowercase());
                socket.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        download_from_url(&r, &dir, &url, |_| {}).unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].contains("range: bytes=2-\r\n"));
        assert!(!requests[1].contains("range:"));
        assert_eq!(fs::read(&destination).unwrap(), b"image");
        assert!(!destination.with_extension("part").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
