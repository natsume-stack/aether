use super::*;
use std::net::TcpListener;

#[test]
#[ignore = "requires a disposable BOX_WEB_TEST_IMAGE in the local Docker daemon"]
fn actual_docker_preparation_reuses_verified_content_and_repairs_a_stale_version_tag() {
    let seed = std::env::var("BOX_WEB_TEST_IMAGE").expect("BOX_WEB_TEST_IMAGE required");
    let expected = docker(&["image", "inspect", "--format", "{{.Id}}", &seed]).unwrap();
    let architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    let nonce = random_hex(8);
    let tag = format!("fixture-{nonce}");
    let target = format!("box-local-engine-play:{tag}");
    let content = format!(
        "box-local-engine-play:launcher-content-{}",
        expected.trim().strip_prefix("sha256:").unwrap()
    );
    let wrong = format!("box3-web-image-fixture:{nonce}");
    let root = std::env::temp_dir().join(format!("box-web-docker-{nonce}"));
    fs::create_dir_all(&root).unwrap();
    struct Cleanup(PathBuf, Vec<String>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for image in &self.1 {
                let _ = docker(&["image", "rm", image]);
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(
        root.clone(),
        vec![target.clone(), content.clone(), wrong.clone()],
    );
    fs::write(root.join(".env"), format!("BOX_IMAGE_TAG={tag}\nBOX_DATABASE_MODE=external\nBOX_DATABASE_URL=postgres://fixture:fixture@127.0.0.1/fixture\nBOX_REDIS_MODE=disabled\n")).unwrap();
    let sha = "b".repeat(64);
    fs::write(root.join("BOX3-IMAGE-CATALOG.json"), json!({"formatVersion":2,"imageTag":tag,"platform":format!("linux/{architecture}"),"images":[{"image":"box-local-engine-play","imageTag":tag,"platform":format!("linux/{architecture}"),"imageId":expected.trim(),"imageIds":[expected.trim()],"sha256":sha,"size":1,"archive":format!("box-local-engine-image-play-{architecture}-{sha}.tar.gz")}]}).to_string()).unwrap();
    let app = App {
        root: root.clone(),
        token: String::new(),
        runtime_token: String::new(),
        compose_file: root.join("compose.yml"),
        environment_file: root.join(".env"),
        operations: Arc::new(Operations::default()),
        operation_id: None,
    };
    docker(&["tag", &seed, &target]).unwrap();
    docker(&["tag", &seed, &content]).unwrap();
    WebRuntime(&app).prepare_images(&["play"]).unwrap();
    assert!(docker(&["image", "inspect", &content]).is_err());
    fs::write(
        root.join("Dockerfile"),
        "FROM scratch\nLABEL box.fixture=wrong-version-content\n",
    )
    .unwrap();
    docker(&["build", "--tag", &wrong, root.to_str().unwrap()]).unwrap();
    docker(&["tag", &wrong, &target]).unwrap();
    assert_ne!(
        docker(&["image", "inspect", "--format", "{{.Id}}", &target]).unwrap(),
        expected
    );
    WebRuntime(&app).prepare_images(&["play"]).unwrap();
    assert_eq!(
        docker(&["image", "inspect", "--format", "{{.Id}}", &target]).unwrap(),
        expected
    );
    assert!(docker(&["image", "inspect", &content]).is_err());
    WebRuntime(&app).prepare_images(&["play"]).unwrap();
}

#[test]
fn real_http_download_streams_progress_resumes_and_reuses_verified_cache() {
    let root = std::env::temp_dir().join(format!(
        "box-web-download-{}-{}",
        std::process::id(),
        random_hex(8)
    ));
    fs::create_dir_all(&root).unwrap();
    let app = App {
        root: root.clone(),
        token: String::new(),
        runtime_token: String::new(),
        compose_file: root.join("compose.yml"),
        environment_file: root.join(".env"),
        operations: Arc::new(Operations::default()),
        operation_id: Some("download-http-fixture".into()),
    };
    app.operations
        .begin(app.operation_id.as_deref().unwrap())
        .unwrap();
    let bytes = vec![42u8; 256 * 1024];
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let image = RemoteImage {
        image: "box-local-engine-play".into(),
        image_id: format!("sha256:{digest}"),
        image_ids: vec![format!("sha256:{digest}")],
        archive: format!("image-{digest}.tar.gz"),
        sha256: digest,
        image_tag: "fixture".into(),
        platform: "linux/arm64".into(),
        size: bytes.len() as u64,
        download_base_url: None,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/image", listener.local_addr().unwrap());
    let source = bytes.clone();
    let server = std::thread::spawn(move || {
        for resume in [false, true] {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                connection.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            if resume {
                assert!(String::from_utf8_lossy(&request)
                    .to_lowercase()
                    .contains("range: bytes=131072-"));
                write!(connection, "HTTP/1.1 206 Partial Content\r\nContent-Length: 131072\r\nContent-Range: bytes 131072-262143/262144\r\nConnection: close\r\n\r\n").unwrap();
            } else {
                write!(
                    connection,
                    "HTTP/1.1 200 OK\r\nContent-Length: 262144\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            }
            let section = if resume {
                &source[131072..]
            } else {
                &source[..131072]
            };
            for chunk in section.chunks(32768) {
                connection.write_all(chunk).unwrap();
                connection.flush().unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
            // First response deliberately disconnects halfway through.
        }
    });
    let mut ticks = Vec::new();
    let mut progress = |downloaded, total| {
        ticks.push((downloaded, total));
        app.image_progress("play", downloaded, total);
    };
    assert!(download_image_archive_from(&app, &image, "play", &mut progress, &url).is_err());
    let result = download_image_archive_from(&app, &image, "play", &mut progress, &url).unwrap();
    server.join().unwrap();
    assert_eq!(fs::read(&result).unwrap(), bytes);
    assert!(ticks
        .iter()
        .any(|(downloaded, _)| *downloaded > 0 && *downloaded < image.size));
    let state = app
        .operations
        .get(app.operation_id.as_deref().unwrap())
        .unwrap();
    assert_eq!(state.stage, "image-download");
    assert_eq!(state.downloads.unwrap()[0].percent, 100);
    // No server remains: only a validated local cache can make this succeed.
    assert_eq!(
        download_image_archive_from(&app, &image, "play", &mut |_, _| {}, &url).unwrap(),
        result
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_test_package_reuses_verified_archive_and_never_falls_back_to_network() {
    let root = std::env::temp_dir().join(format!("box-local-image-{}",random_hex(8)));
    fs::create_dir_all(root.join("cache/engine-images")).unwrap();
    let app = App { root:root.clone(),token:String::new(),runtime_token:String::new(),compose_file:root.join("compose.yml"),environment_file:root.join(".env"),operations:Arc::new(Operations::default()),operation_id:None };
    fs::write(root.join("BOX3-PACKAGE-MODE.json"),r#"{"mode":"local"}"#).unwrap();
    let bytes=b"local snapshot";
    let digest=format!("{:x}",Sha256::digest(bytes));
    let image=RemoteImage {image:"box-local-engine-play".into(),image_id:format!("sha256:{digest}"),image_ids:vec![format!("sha256:{digest}")],archive:"fixture.tar.gz".into(),sha256:digest,image_tag:"fixture".into(),platform:"linux/arm64".into(),size:bytes.len() as u64,download_base_url:None};
    let file=root.join("cache/engine-images/fixture.tar.gz");
    fs::write(&file,bytes).unwrap();
    let unavailable="http://127.0.0.1:1/should-never-be-contacted";
    assert_eq!(download_image_archive_from(&app,&image,"play",&mut |_,_|{},unavailable).unwrap(),file);
    fs::write(&file,b"corrupted").unwrap();
    let error=download_image_archive_from(&app,&image,"play",&mut |_,_|{},unavailable).unwrap_err();
    assert!(error.contains("本地镜像归档缺失或损坏"),"{error}");
    for mode in ["invalid JSON", r#"{"mode":"unknown"}"#] {
        fs::write(root.join("BOX3-PACKAGE-MODE.json"),mode).unwrap();
        let error=download_image_archive_from(&app,&image,"play",&mut |_,_|{},unavailable).unwrap_err();
        assert!(error.contains("打包模式清单无效"),"{error}");
    }
    fs::remove_dir_all(root).unwrap();
}
