//! Concurrent real downloads with serialized per-image progress snapshots.
use crate::image_download::{self, ImageRelease};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

pub(crate) type Progress = box_manager_core::services::ImageDownloadProgress;

pub(crate) fn download(
    images: &[&ImageRelease],
    cache: &Path,
    emit: impl Fn(&[Progress]) + Sync,
) -> Result<Vec<PathBuf>, String> {
    download_with(images, cache, emit, |image, cache, progress| {
        image_download::download(image, cache, progress)
    })
}

fn download_with(
    images: &[&ImageRelease],
    cache: &Path,
    emit: impl Fn(&[Progress]) + Sync,
    acquire: impl Fn(&ImageRelease, &Path, &mut dyn FnMut(u64)) -> Result<PathBuf, String> + Sync,
) -> Result<Vec<PathBuf>, String> {
    if images.is_empty() {
        return Ok(Vec::new());
    }
    let progress = Mutex::new(
        images
            .iter()
            .map(|image| Progress {
                image: image.image.clone(),
                bytes: 0,
                total: image.size,
                percent: 0,
            })
            .collect::<Vec<_>>(),
    );
    let results = Mutex::new((0..images.len()).map(|_| None).collect::<Vec<_>>());
    emit(&progress.lock().unwrap());
    std::thread::scope(|scope| {
        let progress = &progress;
        let results = &results;
        let acquire = &acquire;
        let emit = &emit;
        let workers = images
            .iter()
            .enumerate()
            .map(|(index, image)| {
                scope.spawn(move || {
                    let mut update = |bytes: u64| {
                        let mut rows = progress.lock().unwrap();
                        // Downloaded bytes are not complete until SHA-256 verification succeeds.
                        let percent = (bytes.saturating_mul(100) / image.size.max(1)).min(99) as u8;
                        if rows[index].percent != percent {
                            rows[index].bytes = bytes.min(image.size);
                            rows[index].percent = percent;
                            emit(&rows);
                        }
                    };
                    let result = acquire(image, cache, &mut update);
                    if result.is_ok() {
                        let mut rows = progress.lock().unwrap();
                        rows[index].bytes = image.size;
                        rows[index].percent = 100;
                        emit(&rows);
                    }
                    results.lock().unwrap()[index] =
                        Some(result.map_err(|error| format!("{}：{error}", image.image)));
                })
            })
            .collect::<Vec<_>>();
        // All workers must finish before returning, including on failure, so no
        // progress events arrive after the operation has ended. Verified cache
        // entries survive and are reused on retry; failed partials are removed.
        let mut panicked = false;
        for worker in workers {
            panicked |= worker.join().is_err();
        }
        if panicked {
            return Err("镜像下载任务异常结束，请重试".to_string());
        }
        Ok(())
    })?;
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|result| result.ok_or_else(|| "镜像下载任务未完成".to_string())?)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Barrier,
    };

    fn images() -> Vec<ImageRelease> {
        (0..5)
            .map(|index| ImageRelease {
                download_base_url: None,
                format_version: 1,
                image: format!("image-{index}"),
                image_id: String::new(),
                image_ids: vec![],
                archive: format!("{index}.tar.gz"),
                sha256: String::new(),
                image_tag: "test".into(),
                platform: "linux/arm64".into(),
                size: 100,
            })
            .collect()
    }

    #[test]
    fn all_downloads_overlap_preserve_result_order_and_report_verified_completion() {
        let images = images();
        let refs = images.iter().collect::<Vec<_>>();
        let barrier = Barrier::new(images.len());
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let snapshots = Mutex::new(Vec::new());
        let results = download_with(
            &refs,
            Path::new("cache"),
            |rows| {
                snapshots.lock().unwrap().push(rows.to_vec());
            },
            |image, _, progress| {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                barrier.wait();
                progress(50);
                progress(100);
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(PathBuf::from(&image.archive))
            },
        )
        .unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), images.len());
        assert_eq!(
            results,
            images
                .iter()
                .map(|image| PathBuf::from(&image.archive))
                .collect::<Vec<_>>()
        );
        let snapshots = snapshots.into_inner().unwrap();
        assert!(snapshots
            .first()
            .unwrap()
            .iter()
            .all(|row| row.percent == 0));
        assert!(snapshots
            .last()
            .unwrap()
            .iter()
            .all(|row| row.percent == 100 && row.bytes == row.total));
        assert!(snapshots
            .iter()
            .any(|rows| rows.iter().any(|row| row.percent == 99)));
        for pair in snapshots.windows(2) {
            assert!(pair[0]
                .iter()
                .zip(&pair[1])
                .all(|(a, b)| a.percent <= b.percent));
        }
    }

    #[test]
    fn failure_waits_for_other_downloads_and_preserves_their_verified_results() {
        let images = images();
        let refs = images.iter().collect::<Vec<_>>();
        let finished = AtomicUsize::new(0);
        let emitted_after_return = AtomicBool::new(false);
        let result = download_with(
            &refs,
            Path::new("cache"),
            |_| {
                assert!(!emitted_after_return.load(Ordering::SeqCst));
            },
            |image, _, progress| {
                finished.fetch_add(1, Ordering::SeqCst);
                if image.image == "image-0" {
                    return Err("network failure".into());
                }
                progress(100);
                Ok(PathBuf::from(&image.archive))
            },
        );
        emitted_after_return.store(true, Ordering::SeqCst);
        assert!(result.unwrap_err().contains("image-0：network failure"));
        assert_eq!(finished.load(Ordering::SeqCst), 5);
        assert!(download_with(
            &[],
            Path::new("cache"),
            |_| panic!("empty batch emitted"),
            |_, _, _| panic!("empty batch acquired")
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn real_http_requests_overlap_and_verified_cache_needs_no_network_on_retry() {
        use sha2::{Digest, Sha256};
        use std::{
            fs,
            io::{Read, Write},
            net::TcpListener,
            time::{Duration, Instant},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut streams = Vec::new();
            // No response is sent until all five real clients have connected.
            // Serial downloads or a three-worker limit cannot pass this test.
            while streams.len() < 5 && Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => streams.push(stream),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            }
            assert_eq!(streams.len(), 5, "HTTP requests did not overlap");
            for mut stream in streams {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 4096];
                assert!(stream.read(&mut request).unwrap() > 0);
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nimage",
                    )
                    .unwrap();
            }
        });
        let mut images = images();
        for image in &mut images {
            image.size = 5;
            image.sha256 = format!("{:x}", Sha256::digest(b"image"));
        }
        let cache =
            std::env::temp_dir().join(format!("box-batch-http-test-{}", std::process::id()));
        fs::create_dir_all(&cache).unwrap();
        let refs = images.iter().collect::<Vec<_>>();
        let result = download_with(
            &refs,
            &cache,
            |_| {},
            |image, cache, progress| {
                image_download::download_from_url(
                    image,
                    cache,
                    &format!("http://{address}/{}", image.archive),
                    progress,
                )
            },
        );
        server.join().unwrap();
        let paths = result.unwrap();
        assert!(paths.iter().all(|path| fs::read(path).unwrap() == b"image"));
        // The listener is gone. A retry must verify and reuse cached files.
        let retry = download_with(
            &refs,
            &cache,
            |_| {},
            |image, cache, progress| {
                image_download::download_from_url(
                    image,
                    cache,
                    &format!("http://{address}/{}", image.archive),
                    progress,
                )
            },
        )
        .unwrap();
        assert_eq!(retry, paths);
        fs::remove_dir_all(cache).unwrap();
    }
}
