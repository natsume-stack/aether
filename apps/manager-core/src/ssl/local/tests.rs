use super::*;
fn root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "box-local-nginx-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(path.join("https")).unwrap();
    path
}
#[test]
fn include_preserves_comments_quotes_and_existing_directives_and_is_idempotent() {
    let fragment = Path::new("/tmp/BOX Engine/https/local-nginx.conf");
    let original = "# http { comment }\nevents {}\nhttp {\n server { set $x \"brace } # text\"; }\n include servers/*.conf;\n}\n";
    let result = include(original, fragment).unwrap();
    assert!(result.contains("include servers/*.conf;"));
    assert!(result.contains("set $x \"brace } # text\";"));
    assert_eq!(include(&result, fragment).unwrap(), result);
    assert!(include("events {}", fragment).is_err());
    assert!(include("http {} http {}", fragment).is_err());
    assert!(quote(Path::new("/tmp/$variable")).is_err());
}
#[test]
fn saves_fragment_tests_reloads_and_restores_on_later_failure() {
    let root = root();
    let main = root.join("nginx.conf");
    let original = "events {}\nhttp { include servers/*.conf; }\n";
    fs::write(&main, original).unwrap();
    let mut commands = Vec::new();
    let mut runner = |_: &Path, args: &[String]| {
        commands.push(args.to_vec());
        Ok(String::new())
    };
    let transaction = deploy_with(
        &root,
        "server {}\n",
        "nginx".into(),
        main.clone(),
        &mut runner,
    )
    .unwrap();
    assert!(fs::read_to_string(&main)
        .unwrap()
        .contains("local-nginx.conf"));
    assert_eq!(commands.len(), 3);
    assert!(commands[2].contains(&"reload".into()));
    let mut rollback_commands = Vec::new();
    transaction
        .rollback_with(&mut |_, args| {
            rollback_commands.push(args.to_vec());
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(fs::read_to_string(&main).unwrap(), original);
    assert!(!root.join("https/local-nginx.conf").exists());
    assert_eq!(rollback_commands.len(), 2);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn validation_failure_restores_existing_fragment_without_reloading() {
    let root = root();
    let main = root.join("nginx.conf");
    let fragment = root.join("https/local-nginx.conf");
    let original = "events {}\nhttp {}\n";
    fs::write(&main, original).unwrap();
    fs::write(&fragment, format!("{MARKER}old content")).unwrap();
    let mut count = 0;
    let error = deploy_with(
        &root,
        "bad content",
        "nginx".into(),
        main.clone(),
        &mut |_, args| {
            assert!(!args.contains(&"reload".into()));
            count += 1;
            if count == 2 {
                Err("invalid config".into())
            } else {
                Ok(String::new())
            }
        },
    )
    .err()
    .unwrap();
    assert!(error.contains("原配置已恢复"));
    assert_eq!(fs::read_to_string(&main).unwrap(), original);
    assert_eq!(
        fs::read_to_string(&fragment).unwrap(),
        format!("{MARKER}old content")
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn reload_failure_restores_and_reloads_previous_config() {
    let root = root();
    let main = root.join("nginx.conf");
    fs::write(&main, "events {} http {}").unwrap();
    let mut reloads = 0;
    let error = deploy_with(
        &root,
        "server {}",
        "nginx".into(),
        main.clone(),
        &mut |_, args| {
            if args.contains(&"reload".into()) {
                reloads += 1;
                if reloads == 1 {
                    return Err("reload failed".into());
                }
            }
            Ok(String::new())
        },
    )
    .err()
    .unwrap();
    assert!(error.contains("原配置已恢复"));
    assert_eq!(reloads, 2);
    assert_eq!(fs::read_to_string(&main).unwrap(), "events {} http {}");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn refuses_unowned_fragment_and_invalid_original_configuration() {
    let root = root();
    let main = root.join("nginx.conf");
    fs::write(&main, "events {} http {}").unwrap();
    let fragment = root.join("https/local-nginx.conf");
    fs::write(&fragment, "owned by someone else").unwrap();
    assert!(deploy_with(
        &root,
        "server {}",
        "nginx".into(),
        main.clone(),
        &mut |_, _| panic!("must not call nginx")
    )
    .is_err());
    fs::remove_file(&fragment).unwrap();
    assert!(deploy_with(
        &root,
        "server {}",
        "nginx".into(),
        main.clone(),
        &mut |_, _| Err("original invalid".into())
    )
    .is_err());
    assert_eq!(fs::read_to_string(main).unwrap(), "events {} http {}");
    assert!(!fragment.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires Docker and OpenSSL; uses a dedicated temporary Nginx container"]
fn real_local_nginx_include_reload_and_bad_configuration_rollback() {
    use std::process::Command;
    let root = std::env::temp_dir().join(format!("box-local-nginx-live-{}", std::process::id()));
    fs::create_dir_all(root.join("https")).unwrap();
    let name = format!("box-local-nginx-live-{}", std::process::id());
    struct Cleanup(PathBuf, String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = Command::new("docker").args(["rm", "-f", &self.1]).output();
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone(), name.clone());
    let cert = root.join("cert.pem");
    let key = root.join("key.pem");
    let output = crate::ssl::runtime::openssl_command()
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "2",
            "-subj",
            "/CN=local.example.test",
            "-keyout",
        ])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .output()
        .unwrap();
    assert!(output.status.success());
    let main = root.join("nginx.conf");
    let original = format!("pid {}/nginx.pid;\nerror_log /dev/stderr;\nevents {{}}\nhttp {{ access_log off; server {{ listen 8080; location / {{ return 200 'original'; }} }} }}\n", root.display());
    fs::write(&main, &original).unwrap();
    let mount = format!("{}:{}", root.display(), root.display());
    let output = Command::new("docker")
        .args([
            "run",
            "-d",
            "--name",
            &name,
            "--network",
            "none",
            "-v",
            &mount,
            crate::ssl::IMAGE,
            "nginx",
            "-c",
            main.to_str().unwrap(),
            "-g",
            "daemon off;",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut runner = |_: &Path, args: &[String]| {
        // Docker Desktop propagates host atomic renames asynchronously. Wait for
        // the fixture mount to match the host before asking the guest to validate.
        for path in [&main, &root.join("https/local-nginx.conf")] {
            let expected = fs::read(path).ok();
            let mut synchronized = false;
            for _ in 0..40 {
                let output = Command::new("docker")
                    .args(["exec", &name, "cat", path.to_str().unwrap()])
                    .output()
                    .map_err(|e| e.to_string())?;
                let actual = if output.status.success() {
                    Some(output.stdout)
                } else {
                    None
                };
                if actual == expected {
                    synchronized = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            if !synchronized {
                return Err("测试挂载同步超时".into());
            }
        }
        let output = Command::new("docker")
            .args(["exec", &name, "nginx"])
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).into())
        }
    };
    let fragment = format!("server {{ listen 8443 ssl; server_name local.example.test; ssl_certificate {}; ssl_certificate_key {}; location / {{ return 200 'updated'; }} }}", quote(&cert).unwrap(), quote(&key).unwrap());
    let transaction =
        deploy_with(&root, &fragment, "nginx".into(), main.clone(), &mut runner).unwrap();
    assert!(fs::read_to_string(&main)
        .unwrap()
        .contains("local-nginx.conf"));
    let saved_fragment = fs::read_to_string(root.join("https/local-nginx.conf")).unwrap();
    let saved_main = fs::read_to_string(&main).unwrap();
    deploy_with(&root, &fragment, "nginx".into(), main.clone(), &mut runner).unwrap();
    assert_eq!(fs::read_to_string(&main).unwrap(), saved_main);
    let error = deploy_with(
        &root,
        "invalid_nginx_directive;",
        "nginx".into(),
        main.clone(),
        &mut runner,
    )
    .err()
    .unwrap();
    assert!(error.contains("原配置已恢复"));
    assert_eq!(fs::read_to_string(&main).unwrap(), saved_main);
    assert_eq!(
        fs::read_to_string(root.join("https/local-nginx.conf")).unwrap(),
        saved_fragment
    );
    transaction.rollback_with(&mut runner).unwrap();
    assert_eq!(fs::read_to_string(&main).unwrap(), original);
}

#[test]
fn native_fragment_uses_quoted_local_certificates_and_keeps_websocket_headers() {
    let settings = crate::ssl::Settings {upstream_ports:Default::default(),
        mode: "external".into(),
        https_port: 443,
        routes: vec![crate::ssl::Route {path:String::new(),secure:true,
            service: "play".into(),
            domain: "play.example.test".into(),
            port: Some(8443),
        }],
    };
    let source =
        crate::ssl::configuration_multiple(&settings, "revision", "BOX_PLAY_PORT=4121", true);
    let result = configuration(&source, Path::new("/tmp/BOX Engine"), "fixture").unwrap();
    assert!(result
        .contains("ssl_certificate \"/tmp/BOX Engine/https/revisions/revision/play-cert.pem\";"));
    assert!(result.contains(
        "ssl_certificate_key \"/tmp/BOX Engine/https/revisions/revision/play-key.pem\";"
    ));
    assert!(result.contains("127.0.0.1:4121"));
    assert!(result.contains("listen 8443 ssl;"));
    assert!(result.contains("proxy_set_header Upgrade $http_upgrade;"));
    assert!(result.contains("$box_ssl_connection_fixture"));
    assert!(!result.contains("127.0.0.11"));
    assert!(!result.contains("/etc/box-https/"));
}

#[test]
fn missing_executable_is_deferred_but_execution_errors_are_not_hidden() {
    let root = root();
    assert!(discover_candidates(vec![root.join("not-installed-nginx")])
        .unwrap()
        .is_none());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let binary = root.join("unreadable-nginx");
        fs::write(&binary, "#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(discover_candidates(vec![binary]).is_err());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn installation_reports_version_executable_and_configuration_paths_even_when_config_is_missing() {
    let root = root();
    let binary = root.join("nginx");
    let conf = root.join("nginx.conf");
    fs::write(&binary, "fixture").unwrap();
    let details = format!(
        "nginx version: nginx/1.28.0\nconfigure arguments: --prefix={} --conf-path=nginx.conf\n",
        root.display()
    );
    let missing = installation(&binary, &details).unwrap();
    assert_eq!(missing.version, "1.28.0");
    assert_eq!(missing.executable_path, fs::canonicalize(&binary).unwrap());
    assert_eq!(missing.config_path, conf);
    assert!(!missing.config_error.is_empty());
    fs::write(&conf, "events {} http {}").unwrap();
    let present = installation(&binary, &details).unwrap();
    assert_eq!(present.config_path, fs::canonicalize(conf).unwrap());
    assert!(present.config_error.is_empty());
    assert!(installation(&binary, "other program").is_err());
    fs::remove_dir_all(root).unwrap();
}
