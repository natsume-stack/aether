use super::*;

#[test]
fn proxy_trust_follows_each_service_public_route_and_resets_when_disabled() {
    let root = fixture_root();
    std::fs::create_dir_all(root.join("https")).unwrap();
    let mut settings = input().settings;
    let template = settings.routes[0].clone();
    settings.routes = ["play", "creator", "player-service", "player-auth-portal"]
        .into_iter()
        .map(|service| Route { service: service.into(), ..template.clone() })
        .collect();
    std::fs::write(root.join("https/routing.pending.json"), serde_json::to_string(&settings).unwrap()).unwrap();
    let values = [("BOX_PLAY_NETWORK_MODE".into(), "public".into()), ("BOX_CREATOR_NETWORK_MODE".into(), "local".into())].into_iter().collect();
    let mut derived = BTreeMap::new();
    for service in SERVICES {
        derived.insert(format!("{}_PUBLIC_URL", service.3.trim_end_matches("_PORT")), "http://127.0.0.1:3121".into());
    }
    apply_runtime_urls(&root, &values, &mut derived).unwrap();
    for key in ["BOX_PLAY_TRUST_PROXY", "BOX_PLAYER_SERVICE_TRUST_PROXY", "BOX_AUTH_PORTAL_TRUST_PROXY"] {
        assert_eq!(derived.get(key).map(String::as_str), Some("true"), "{key}");
    }
    assert_eq!(derived.get("BOX_CREATOR_TRUST_PROXY").map(String::as_str), Some("false"));
    settings.mode = "external".into();
    set_provider(&root, "external").unwrap();
    std::fs::write(root.join("https/routing.pending.json"), serde_json::to_string(&settings).unwrap()).unwrap();
    apply_runtime_urls(&root, &values, &mut derived).unwrap();
    assert_eq!(derived.get("BOX_PLAY_TRUST_PROXY").map(String::as_str), Some("false"));
    settings.upstream_ports.insert("play".into(), 13121);
    std::fs::write(root.join("https/routing.pending.json"), serde_json::to_string(&settings).unwrap()).unwrap();
    apply_runtime_urls(&root, &values, &mut derived).unwrap();
    assert_eq!(derived.get("BOX_PLAY_TRUST_PROXY").map(String::as_str), Some("true"));
    assert_eq!(derived.get("BOX_AUTH_PORTAL_TRUST_PROXY").map(String::as_str), Some("false"));
    set_provider(&root, "external-manual").unwrap();
    apply_runtime_urls(&root, &values, &mut derived).unwrap();
    for key in ["BOX_PLAY_TRUST_PROXY", "BOX_PLAYER_SERVICE_TRUST_PROXY", "BOX_AUTH_PORTAL_TRUST_PROXY", "BOX_CREATOR_TRUST_PROXY"] {
        assert_eq!(derived.get(key).map(String::as_str), Some("false"), "{key}");
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn nginx_defaults_to_managed_and_preserves_explicit_external_selection() {
    let root = fixture_root();
    let mut docker = |args: &[String]| -> Result<String, String> {
        if args.starts_with(&["image".into(), "inspect".into()]) {
            assert_eq!(args[2], IMAGE);
            return Ok(r#"[{"Config":{"Env":["NGINX_VERSION=1.30.2"]}}]"#.into());
        }
        Ok(String::new())
    };
    let result = status(&root, &mut docker).unwrap();
    assert_eq!(result["provider"], "managed");
    assert_eq!(result["imageVersion"], "1.30.2");
    set_provider(&root, "disabled").unwrap();
    assert_eq!(status(&root, &mut docker).unwrap()["provider"], "managed");
    set_provider(&root, "external").unwrap();
    assert_eq!(status(&root, &mut docker).unwrap()["provider"], "external");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn draft_routing_uses_the_same_provider_default_as_status() {
    let root = fixture_root();
    std::fs::write(root.join(".env"), "BOX_PLAY_NETWORK_MODE=public\nBOX_PLAY_PUBLIC_ADDRESS_OVERRIDE=http://play.example.test:3121\n").unwrap();
    let source = "services:\n  play:\n    ports:\n      - \"3121:3000\"\n    environment:\n      ROLE: play\n";
    for mode in [None, Some("disabled"), Some("external")] {
        if let Some(mode) = mode { set_provider(&root, mode).unwrap(); }
        let mut docker = |_: &[String]| Ok(String::new());
        let selected = status(&root, &mut docker).unwrap();
        let composed = compose_source(&root, source).unwrap();
        if selected["provider"] == "managed" {
            assert!(!composed.contains("ports:"));
        } else {
            assert!(composed.contains("127.0.0.1:13121:3000"));
        }
        assert!(composed.contains("ROLE: play"));
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_nginx_image_downloads_the_same_registry_mirror_as_redis() {
    let calls = std::cell::RefCell::new(Vec::new());
    install_image_with_progress(
        &mut |args: &[String]| {
            calls.borrow_mut().push(args.to_vec());
            if args[0] == "image" { Err("not found".into()) } else { Ok(String::new()) }
        },
        &mut |image, _progress| {
            calls.borrow_mut().push(vec!["pull".into(), image.into()]);
            Ok(())
        },
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(calls.into_inner()[1], vec!["pull", IMAGE]);
}
fn input() -> Import {
    Import {
        certificate_paths: Default::default(), delete_services: Vec::new(),
        external_local: false,
        settings: Settings {upstream_ports:Default::default(),
            mode: "managed".into(),
            https_port: 443,
            routes: vec![Route {path:String::new(),secure:true,
                service: "play".into(),
                domain: "play.example.com".into(),
                port: None,
            }],
        },
        certificate: "-----BEGIN CERTIFICATE-----\nfixture".into(),
        private_key: "-----BEGIN PRIVATE KEY-----\nfixture".into(),
        certificates: Default::default(),
    }
}
#[test]
fn refuses_configuration_injection_and_duplicate_hosts() {
    for host in [
        "x.example.com;return 200",
        "x.example.com\n}",
        "*.example.com",
        "http://x.example.com",
    ] {
        assert!(domain(host).is_err());
    }
    let mut draft = input();
    draft.settings.routes.push(Route {path:String::new(),secure:true,
        service: "creator".into(),
        domain: "play.example.com".into(),
        port: None,
    });
    assert!(validate(&mut draft).is_err());
    assert_eq!(domain("PLAY.Example.com").unwrap(), "play.example.com");
}
#[test]
fn nginx_preserves_websocket_and_original_http_host() {
    let config = configuration(&input().settings, "revision", "");
    for expected in [
        "proxy_http_version 1.1",
        "Upgrade $http_upgrade",
        "Connection $box_ssl_connection",
        "Host $http_host",
        "X-Forwarded-Proto https",
        "http://play:3000",
    ] {
        assert!(config.contains(expected));
    }
    let mut settings = input().settings;
    settings.mode = "external".into();
    settings.https_port = 8443;
    let config = configuration(&settings, "revision", "BOX_PLAY_PORT=4121\n");
    assert!(config.contains("127.0.0.1:4121"));
    assert!(config.contains("listen 8443 ssl"));
}

#[test]
fn path_routes_assign_the_upstream_before_the_break_rewrite() {
    let mut settings = input().settings;
    settings.routes[0].path = "/abc".into();
    let config = configuration(&settings, "revision", "");
    let set = config
        .find("set $box_upstream http://play:3000;")
        .expect("prefixed routes must keep a variable upstream");
    let rewrite = config
        .find("rewrite ^/abc(/.*)$ $1 break;")
        .expect("prefixed routes must strip the public prefix");
    let proxy = config
        .find("proxy_pass $box_upstream;")
        .expect("prefixed routes must proxy through the variable");
    assert!(
        set < rewrite && rewrite < proxy,
        "rewrite ... break ends the rewrite phase, so the upstream variable must be set first"
    );
}

#[test]
fn raw_nginx_save_validates_then_reloads_and_rolls_back_rejections() {
    let root = fixture_root();
    std::fs::create_dir_all(root.join("https")).unwrap();
    std::fs::write(root.join("https/nginx.conf"), "old configuration").unwrap();
    std::fs::write(root.join("https/provider"), "managed").unwrap();
    let owner = runtime::identity(&root);
    // Invalid text never touches the live configuration.
    let mut docker = |args: &[String]| {
        if args.first().map(String::as_str) == Some("run") {
            return Err("nginx: [emerg] invalid directive".into());
        }
        Ok(String::new())
    };
    let error = save_raw_nginx_config(&root, &root, "events {}\nhttp { invalid }", &mut docker)
        .unwrap_err();
    assert!(error.contains("已保留原配置"), "{error}");
    assert_eq!(
        std::fs::read_to_string(root.join("https/nginx.conf")).unwrap(),
        "old configuration"
    );
    // A running entry reloads validated text and leaves no staging file behind.
    let mut reloads = 0;
    let mut docker = |args: &[String]| {
        if args.contains(&"container".into()) && args.contains(&"ls".into()) {
            return Ok("owned".into());
        }
        if args.iter().any(|value| value.contains("box.https.owner")) {
            return Ok(owner.clone());
        }
        if args.iter().any(|value| value.contains("State.Running")) {
            return Ok("true".into());
        }
        if args.contains(&"reload".into()) {
            reloads += 1;
        }
        Ok(String::new())
    };
    assert!(save_raw_nginx_config(&root, &root, "events {}\nhttp {}\n", &mut docker).unwrap());
    assert_eq!(reloads, 1);
    assert_eq!(
        std::fs::read_to_string(root.join("https/nginx.conf")).unwrap(),
        "events {}\nhttp {}\n"
    );
    assert!(!root.join("https/nginx.raw-pending.conf").exists());
    // The running entry rejecting the text restores the previous configuration.
    let mut docker = |args: &[String]| {
        if args.contains(&"container".into()) && args.contains(&"ls".into()) {
            return Ok("owned".into());
        }
        if args.iter().any(|value| value.contains("box.https.owner")) {
            return Ok(owner.clone());
        }
        if args.iter().any(|value| value.contains("State.Running")) {
            return Ok("true".into());
        }
        if args.first().map(String::as_str) == Some("exec") && args.contains(&"-t".into()) {
            return Err("bad configuration".into());
        }
        Ok(String::new())
    };
    let error = save_raw_nginx_config(&root, &root, "events {}\n", &mut docker).unwrap_err();
    assert!(error.contains("已恢复原配置"), "{error}");
    assert_eq!(
        std::fs::read_to_string(root.join("https/nginx.conf")).unwrap(),
        "events {}\nhttp {}\n"
    );
    // A stopped entry stores the text and reports that no reload happened.
    let mut docker = |args: &[String]| {
        if args.contains(&"container".into()) && args.contains(&"ls".into()) {
            return Ok(String::new());
        }
        Ok(String::new())
    };
    assert!(!save_raw_nginx_config(
        &root,
        &root,
        "events {}\nhttp { server { listen 80; } }\n",
        &mut docker
    )
    .unwrap());
    std::fs::remove_dir_all(root).unwrap();
}

fn fixture_root() -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    fixture_root_with_stamp(stamp)
}

fn fixture_root_with_stamp(stamp: u128) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "box-ssl-test-{}-{}-{}",
        std::process::id(),
        stamp,
        NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    root
}

#[test]
fn fixtures_stay_unique_when_system_clock_returns_same_timestamp() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let roots: std::collections::BTreeSet<_> =
        (0..16).map(|_| fixture_root_with_stamp(stamp)).collect();
    for root in &roots {
        std::fs::remove_dir_all(root).unwrap();
    }
    assert_eq!(roots.len(), 16);
}
#[test]
fn mismatched_domain_never_activates_or_persists_the_private_key() {
    let root = fixture_root();
    let mut calls = Vec::new();
    let mut docker = |args: &[String]| {
        calls.push(args.join(" "));
        Ok(if args.contains(&"-checkhost".into()) {
            "Hostname play.example.com does NOT match certificate".into()
        } else {
            String::new()
        })
    };
    assert!(apply(&root, &root, "fixture", "", input(), &mut docker).is_err());
    assert!(!root.join("https/nginx.conf").exists());
    assert!(!root.join("https/settings.json").exists());
    assert!(!calls.iter().any(|s| s.contains(" run -d ")));
    assert_eq!(
        std::fs::read_dir(root.join("https/revisions"))
            .unwrap()
            .count(),
        0
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn failed_reload_restores_previous_config_and_keeps_old_metadata() {
    use sha2::{Digest, Sha256};
    use std::fs;
    let root = fixture_root();
    fs::create_dir(root.join("https")).unwrap();
    fs::write(root.join("https/nginx.conf"), "old configuration").unwrap();
    let saved = Saved {
        settings: input().settings,
        pending_local: false,
        external_local: false,
        expires_at: "2099-01-01T00:00:00Z".into(),
        revision: "old".into(),
        external_config: "old".into(),
        certificate_expiries: Default::default(),
        certificate_sources: Default::default(),
    };
    let metadata = serde_json::to_string(&saved).unwrap();
    fs::write(root.join("https/settings.json"), &metadata).unwrap();
    let owner =
        format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()))[..16].to_string();
    let mut reloads = 0;
    let mut docker = |args: &[String]| {
        if args.contains(&"container".into()) && args.contains(&"ls".into()) {
            return Ok("owned".into());
        }
        if args.iter().any(|s| s.contains("box.https.owner")) {
            return Ok(owner.clone());
        }
        if args.iter().any(|s| s.contains("State.Running")) {
            return Ok("true".into());
        }
        if args.contains(&"-checkhost".into()) {
            return Ok("Hostname play.example.com does match certificate".into());
        }
        if args.contains(&"-startdate".into()) {
            return Ok(
                "notBefore=Oct  1 00:00:00 2020 GMT\nnotAfter=Oct 10 00:00:00 2099 GMT".into(),
            );
        }
        if args.contains(&"reload".into()) {
            reloads += 1;
            if reloads == 1 {
                return Err("reload failed".into());
            }
        }
        Ok(String::new())
    };
    assert!(apply(&root, &root, "fixture", "", input(), &mut docker)
        .unwrap_err()
        .contains("原配置已保留或恢复"));
    assert_eq!(reloads, 2);
    assert_eq!(
        fs::read_to_string(root.join("https/nginx.conf")).unwrap(),
        "old configuration"
    );
    assert_eq!(
        fs::read_to_string(root.join("https/settings.json")).unwrap(),
        metadata
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn per_service_certificates_use_distinct_files_and_support_same_host_on_distinct_ports() {
    let mut input = input();
    input.settings.routes[0].port = Some(8443);
    input.settings.routes.push(Route {path:String::new(),secure:true,
        service: "creator".into(),
        domain: "play.example.com".into(),
        port: Some(9443),
    });
    validate(&mut input).unwrap();
    let config = configuration_multiple(&input.settings, "candidate", "", true);
    assert!(config.contains("play-cert.pem"));
    assert!(config.contains("creator-key.pem"));
    assert!(config.contains("listen 8443 ssl"));
    assert!(config.contains("listen 9443 ssl"));
}

#[test]
fn external_import_uses_openssl_and_preserves_saved_keys_without_nginx_image() {
    use std::fs;
    let root = fixture_root();
    for host in ["play", "creator"] {
        let result = runtime::openssl_command()
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "2",
                "-subj",
                &format!("/CN={host}.example.com"),
                "-addext",
                &format!("subjectAltName=DNS:{host}.example.com"),
                "-keyout",
            ])
            .arg(root.join(format!("{host}.key")))
            .arg("-out")
            .arg(root.join(format!("{host}.pem")))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let mut input = input();
    input.settings.mode = "external".into();
    input.settings.routes.push(Route {path:String::new(),secure:true,
        service: "creator".into(),
        domain: "creator.example.com".into(),
        port: Some(8443),
    });
    input.certificate.clear();
    input.private_key.clear();
    for service in ["play", "creator"] {
        input.certificates.insert(
            service.into(),
            Certificate {
                source: "independent".into(),
                certificate: fs::read_to_string(root.join(format!("{service}.pem"))).unwrap(),
                private_key: fs::read_to_string(root.join(format!("{service}.key"))).unwrap(),
            },
        );
    }
    let mut unavailable = |_: &[String]| Err("Docker unavailable".into());
    let settings = input.settings.clone();
    let value = apply(&root, &root, "unused", "", input, &mut unavailable).unwrap();
    assert!(value["config"]["certificateExpiries"]["creator"].is_string());
    let exported = value["config"]["externalConfig"].as_str().unwrap();
    assert!(exported.contains(root.join("https/revisions").to_str().unwrap()));
    assert!(!exported.contains("/etc/box-https/"));
    assert!(!fs::read_to_string(root.join("https/settings.json"))
        .unwrap()
        .contains("PRIVATE KEY"));
    let deferred = runtime::apply_with_local(
        &root, &root, "unused", "",
        Import {certificate_paths: Default::default(), delete_services:Vec::new(), settings: settings.clone(), external_local: true, certificate: String::new(), private_key: String::new(), certificates: Default::default() },
        &mut unavailable, &mut |_, _| Ok(None),
    ).unwrap();
    assert_eq!(deferred["config"]["pendingLocal"], true);
    assert_eq!(deferred["externalLocalApplied"], false);
    assert!(deferred["sslWarning"].as_str().unwrap().contains("需要安装"));
    let persisted: Saved = serde_json::from_str(&fs::read_to_string(root.join("https/settings.json")).unwrap()).unwrap();
    assert!(persisted.pending_local);
    assert!(root.join("https/revisions").join(&persisted.revision).join("play-key.pem").is_file());
    assert_eq!(status(&root, &mut unavailable).unwrap()["config"]["pendingLocal"], true);
    apply(
        &root,
        &root,
        "unused",
        "",
        Import {
        certificate_paths: Default::default(), delete_services: Vec::new(),
        external_local: false,
            settings,
            certificate: String::new(),
            private_key: String::new(),
            certificates: Default::default(),
        },
        &mut unavailable,
    )
    .unwrap();
    let metadata = fs::read_to_string(root.join("https/settings.json")).unwrap();
    let mut bad = Import {
        certificate_paths: Default::default(), delete_services: Vec::new(),
        external_local: false,
        settings: Settings {upstream_ports:Default::default(),
            mode: "external".into(),
            https_port: 443,
            routes: vec![Route {path:String::new(),secure:true,
                service: "play".into(),
                domain: "play.example.com".into(),
                port: None,
            }],
        },
        certificate: String::new(),
        private_key: String::new(),
        certificates: Default::default(),
    };
    bad.settings.mode = "external".into();
    bad.private_key = fs::read_to_string(root.join("creator.key")).unwrap();
    bad.certificate = fs::read_to_string(root.join("play.pem")).unwrap();
    assert!(apply(&root, &root, "unused", "", bad, &mut unavailable)
        .unwrap_err()
        .contains("不匹配"));
    assert_eq!(fs::read_to_string(root.join("https/settings.json")).unwrap(), metadata);
    let remaining = delete_certificate(&root, &root, "unused", "", "creator", &mut unavailable).unwrap();
    assert_eq!(remaining["config"]["settings"]["routes"].as_array().unwrap().len(), 1);
    assert!(!remaining["config"]["certificateExpiries"].as_object().unwrap().contains_key("creator"));
    for entry in fs::read_dir(root.join("https/revisions")).unwrap() {
        assert!(!entry.unwrap().path().join("creator-key.pem").exists());
    }
    assert!(delete_certificate(&root, &root, "unused", "", "../invalid", &mut unavailable).is_err());
    let empty = delete_certificate(&root, &root, "unused", "", "play", &mut unavailable).unwrap();
    assert!(empty["config"].is_null());
    assert!(!root.join("https/settings.json").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn managed_https_runtime_links_use_listener_ports_without_changing_engine_ports() {
    let root = fixture_root();
    std::fs::create_dir(root.join("https")).unwrap();
    let saved = Saved {settings:Settings {upstream_ports:Default::default(),mode:"managed".into(),https_port:443,routes:vec![Route {path:String::new(),secure:true,service:"play".into(),domain:"play.example.test".into(),port:Some(443)},Route {path:String::new(),secure:true,service:"player-auth-portal".into(),domain:"auth.example.test".into(),port:Some(443)}]},pending_local:false,external_local:false,expires_at:"2099-01-01T00:00:00Z".into(),revision:"fixture".into(),external_config:String::new(),certificate_sources:Default::default(),certificate_expiries:Default::default()};
    std::fs::write(root.join("https/settings.json"), serde_json::to_string(&saved).unwrap()).unwrap();
    let values = [("BOX_PLAY_NETWORK_MODE","public"),("BOX_CREATOR_NETWORK_MODE","local"),("BOX_PLAYER_LOGIN_URL_OVERRIDE","http://172.31.9.78:3125")].into_iter().map(|(key,value)|(key.to_string(),value.to_string())).collect();
    let mut derived: BTreeMap<String,String> = [("BOX_PLAY_PUBLIC_URL","https://play.example.test:3121"),("BOX_CREATOR_PUBLIC_URL","http://127.0.0.1:3127"),("BOX_VOXA_PUBLIC_URL","http://127.0.0.1:3123"),("BOX_PLAYER_SERVICE_PUBLIC_URL","https://shared.example.test:3124"),("BOX_AUTH_PORTAL_PUBLIC_URL","https://auth.example.test:3125"),("BOX_PLAY_PORT","3121")].into_iter().map(|(key,value)|(key.to_string(),value.to_string())).collect();
    apply_runtime_urls(&root, &values, &mut derived).unwrap();
    assert_eq!(derived["BOX_PLAY_PUBLIC_URL"], "https://play.example.test");
    assert_eq!(derived["BOX_PLAYER_LOGIN_URL"], "https://auth.example.test");
    assert_eq!(derived["BOX_PLAY_PORT"], "3121");
    assert!(derived["BOX_PLAYER_AUTH_ALLOWED_ORIGINS"].contains("https://play.example.test"));
    assert_eq!(derived["BOX_CREATOR_PUBLIC_URL"], "http://127.0.0.1:3127");
    std::fs::write(root.join("https/provider"), "external").unwrap();
    let mut original = derived.clone();
    for service in SERVICES {
        original.insert(format!("{}_TRUST_PROXY", service.3.trim_end_matches("_PORT")), "false".into());
    }
    apply_runtime_urls(&root, &values, &mut derived).unwrap();
    assert_eq!(derived, original);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn independent_runtime_addresses_clear_shared_prefixes_for_all_services() {
    use std::fs;
    for mode in ["managed", "external"] {
        let root = fixture_root();
        fs::create_dir(root.join("https")).unwrap();
        let routes: Vec<Route> = SERVICES.iter().filter(|service| service.0 != "server-manager").enumerate().map(|(index, service)| Route {
            service: service.0.into(), domain: format!("{}.example.test", service.0),
            port: Some(18381 + index as u16), secure: index % 2 == 1, path: String::new(),
        }).collect();
        let saved = Saved {
            settings: Settings { mode: mode.into(), https_port: 443, routes: routes.clone(), upstream_ports: Default::default() },
            pending_local: false, external_local: false, expires_at: String::new(), revision: "fixture".into(),
            external_config: String::new(), certificate_sources: Default::default(), certificate_expiries: Default::default(),
        };
        fs::write(root.join("https/settings.json"), serde_json::to_string(&saved).unwrap()).unwrap();
        let values = [("BOX_PLAY_NETWORK_MODE", "public"), ("BOX_CREATOR_NETWORK_MODE", "public")]
            .into_iter().map(|(key, value)| (key.into(), value.into())).collect();
        let mut derived = BTreeMap::new();
        for service in SERVICES {
            let key = service.3.trim_end_matches("_PORT");
            derived.insert(format!("{key}_BASE_PATH"), "/stale-shared-prefix".into());
            derived.insert(format!("{key}_PUBLIC_URL"), "http://old.example.test/stale-shared-prefix".into());
        }
        derived.insert("BOX_PUBLIC_SERVICE_PREFIXES_BY_ORIGIN".into(), r#"{"http://old.example.test":["/stale-shared-prefix"]}"#.into());
        apply_runtime_urls(&root, &values, &mut derived).unwrap();
        for route in &routes {
            let service = SERVICES.iter().find(|service| service.0 == route.service).unwrap();
            let key = service.3.trim_end_matches("_PORT");
            assert_eq!(derived[&format!("{key}_BASE_PATH")], "");
            assert_eq!(derived[&format!("{key}_PUBLIC_URL")], format!("{}://{}:{}", if route.secure { "https" } else { "http" }, route.domain, route.port.unwrap()));
        }
        assert_eq!(derived["BOX_PUBLIC_SERVICE_PREFIXES_BY_ORIGIN"], "{}");
        let config = configuration(&saved.settings, "fixture", "");
        assert_eq!(config.matches("server {").count(), 5);
        assert_eq!(config.matches("location / {").count(), 5);
        assert!(!config.contains("rewrite ^"));
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn failed_route_reload_preserves_the_certificate_being_deleted() {
    let root = fixture_root();
    std::fs::create_dir_all(root.join("https/revisions/old")).unwrap();
    let settings = Settings {upstream_ports:Default::default(),mode:"managed".into(), https_port:443, routes:vec![Route {path:String::new(),secure:true,service:"play".into(),domain:"play.example.test".into(),port:Some(443)},Route {path:String::new(),secure:true,service:"creator".into(),domain:"creator.example.test".into(),port:Some(443)}]};
    let saved = Saved {settings,external_local:false,pending_local:false,expires_at:"2099-01-01T00:00:00Z".into(),revision:"old".into(),external_config:String::new(),certificate_sources:Default::default(),certificate_expiries:Default::default()};
    let metadata = serde_json::to_string(&saved).unwrap();
    std::fs::write(root.join("https/settings.json"), &metadata).unwrap();
    for service in ["play", "creator"] {
        std::fs::write(root.join(format!("https/revisions/old/{service}-cert.pem")), "-----BEGIN CERTIFICATE-----\nfixture").unwrap();
        std::fs::write(root.join(format!("https/revisions/old/{service}-key.pem")), "-----BEGIN PRIVATE KEY-----\nfixture").unwrap();
    }
    let mut docker = |args: &[String]| {
        if args.contains(&"-t".into()) { return Err("fixture reload refused".into()); }
        if args.contains(&"-checkhost".into()) { return Ok("does match certificate".into()); }
        if args.contains(&"-startdate".into()) { return Ok("notBefore=Jan  1 00:00:00 2025 GMT\nnotAfter=Jan  1 00:00:00 2099 GMT".into()); }
        Ok(String::new())
    };
    assert!(delete_certificate(&root, &root, "fixture", "", "creator", &mut docker).is_err());
    assert_eq!(std::fs::read_to_string(root.join("https/settings.json")).unwrap(), metadata);
    assert!(root.join("https/revisions/old/creator-key.pem").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn certificate_removal_is_not_blocked_by_another_expired_certificate() {
    let root = fixture_root();
    std::fs::create_dir_all(root.join("https/revisions/old")).unwrap();
    let saved = Saved {settings:Settings {upstream_ports:Default::default(),mode:"managed".into(),https_port:443,routes:vec![Route {path:String::new(),secure:true,service:"play".into(),domain:"play.example.test".into(),port:Some(443)},Route {path:String::new(),secure:true,service:"creator".into(),domain:"creator.example.test".into(),port:Some(443)}]},external_local:false,pending_local:false,expires_at:"2020-01-01T00:00:00Z".into(),revision:"old".into(),external_config:String::new(),certificate_sources:Default::default(),certificate_expiries:Default::default()};
    std::fs::write(root.join("https/settings.json"), serde_json::to_string(&saved).unwrap()).unwrap();
    for service in ["play", "creator"] {
        std::fs::write(root.join(format!("https/revisions/old/{service}-cert.pem")), "-----BEGIN CERTIFICATE-----\nfixture").unwrap();
        std::fs::write(root.join(format!("https/revisions/old/{service}-key.pem")), "-----BEGIN PRIVATE KEY-----\nfixture").unwrap();
    }
    let result = delete_certificate(&root, &root, "fixture", "", "creator", &mut |args| {
        if args.contains(&"-checkend".into()) { return Err("certificate expired".into()); }
        Ok(String::new())
    }).unwrap();
    assert_eq!(result["config"]["settings"]["routes"].as_array().unwrap().len(), 1);
    assert_eq!(result["config"]["certificateExpiries"]["play"], "2020-01-01T00:00:00Z");
    assert!(!root.join("https/revisions/old/creator-key.pem").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn shared_certificate_deletion_clears_tls_flags_and_keeps_http_and_other_certificates() {
    let root=fixture_root();
    std::fs::create_dir_all(root.join("https/revisions/old")).unwrap();
    let settings=Settings {mode:"managed".into(),https_port:443,upstream_ports:Default::default(),routes:vec![
        Route {service:"play".into(),domain:"play.example.test".into(),port:Some(8080),secure:false,path:String::new()},
        Route {service:"creator".into(),domain:"creator.example.test".into(),port:Some(443),secure:true,path:String::new()},
        Route {service:"voxa".into(),domain:"voxa.example.test".into(),port:Some(443),secure:true,path:String::new()},
    ]};
    let saved=Saved {settings,external_local:false,pending_local:false,expires_at:"2099-01-01T00:00:00Z".into(),revision:"old".into(),external_config:String::new(),certificate_sources:[("play".into(),"shared".into()),("creator".into(),"shared".into()),("voxa".into(),"independent".into())].into_iter().collect(),certificate_expiries:["play","creator","voxa"].into_iter().map(|service|(service.into(),"2099-01-01T00:00:00Z".into())).collect()};
    std::fs::write(root.join("https/settings.json"),serde_json::to_string(&saved).unwrap()).unwrap();
    for service in ["play","creator","voxa"] {
        std::fs::write(root.join(format!("https/revisions/old/{service}-cert.pem")),"-----BEGIN CERTIFICATE-----\nfixture").unwrap();
        std::fs::write(root.join(format!("https/revisions/old/{service}-key.pem")),"-----BEGIN PRIVATE KEY-----\nfixture").unwrap();
    }
    assert!(crate::public_access::certificate_flags(&root)["shared"]);
    let result=delete_certificate(&root,&root,"fixture","","shared",&mut |_|Ok(String::new())).unwrap();
    let routes=result["config"]["settings"]["routes"].as_array().unwrap();
    assert_eq!(routes.len(),2);
    assert!(routes.iter().any(|route|route["service"]=="play" && route["secure"]==false));
    let flags=crate::public_access::certificate_flags(&root);
    assert!(!flags["shared"]);assert!(!flags["play"]);assert!(!flags["creator"]);assert!(flags["voxa"]);
    assert!(!root.join("https/revisions/old/play-key.pem").exists());
    assert!(!root.join("https/revisions/old/creator-key.pem").exists());
    assert!(root.join("https/revisions/old/voxa-key.pem").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn saved_public_routes_do_not_remove_local_http_bindings() {
    let root = fixture_root();
    std::fs::write(root.join(".env"), "BOX_PLAY_NETWORK_MODE=local\nBOX_CREATOR_NETWORK_MODE=local\n").unwrap();
    std::fs::create_dir_all(root.join("https")).unwrap();
    std::fs::write(root.join("https/routing.pending.json"), serde_json::to_string(&input().settings).unwrap()).unwrap();
    let source = "services:\n  play:\n    ports:\n      - \"127.0.0.1:3121:3000\"\n";
    assert_eq!(compose_source(&root, source).unwrap(), source);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn endpoint_verification_distinguishes_ip_domain_and_plain_http() {
    let root = fixture_root();
    std::fs::create_dir_all(root.join("https")).unwrap();
    let mut settings = input().settings;
    settings.routes = vec![
        Route { service:"play".into(),domain:"203.0.113.10".into(),port:Some(443),path:String::new(),secure:true },
        Route { service:"creator".into(),domain:"2001:db8::1".into(),port:Some(8443),path:String::new(),secure:true },
        Route { service:"player-auth-portal".into(),domain:"auth.example.test".into(),port:Some(443),path:String::new(),secure:true },
        Route { service:"voxa".into(),domain:"assets.example.test".into(),port:Some(80),path:String::new(),secure:false },
    ];
    let saved = Saved { settings,external_local:false,pending_local:false,expires_at:String::new(),revision:"test".into(),external_config:String::new(),certificate_sources:Default::default(),certificate_expiries:Default::default() };
    std::fs::write(root.join("https/settings.json"),serde_json::to_string(&saved).unwrap()).unwrap();
    let mut calls = Vec::new();
    let result = verify_endpoint(&root, &mut |args| {calls.push(args.to_vec());Ok(String::new())}).unwrap();
    assert_eq!(result["checks"].as_array().unwrap().len(),3);
    assert!(calls[0].windows(2).any(|pair| pair == ["-verify_ip","203.0.113.10"]));
    assert!(calls[1].windows(2).any(|pair| pair == ["-connect","[2001:db8::1]:8443"]));
    assert!(calls[1].windows(2).any(|pair| pair == ["-verify_ip","2001:db8::1"]));
    assert!(calls[2].windows(2).any(|pair| pair == ["-verify_hostname","auth.example.test"]));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn same_public_port_with_a_changed_internal_listener_recreates_the_proxy() {
    let root = fixture_root();
    std::fs::create_dir_all(root.join("https/revisions/old")).unwrap();
    let mut desired = input();
    desired.settings.https_port = 8443;
    let saved = Saved { settings: desired.settings.clone(),external_local:false,pending_local:false,expires_at:"2099-01-01T00:00:00Z".into(),revision:"old".into(),external_config:String::new(),certificate_sources:Default::default(),certificate_expiries:Default::default() };
    std::fs::write(root.join("https/settings.json"),serde_json::to_string(&saved).unwrap()).unwrap();
    std::fs::write(root.join("https/nginx.conf"),"old configuration").unwrap();
    std::fs::write(root.join("https/revisions/old/cert.pem"), &desired.certificate).unwrap();
    std::fs::write(root.join("https/revisions/old/key.pem"), &desired.private_key).unwrap();
    desired.settings.routes[0].secure = false;
    desired.settings.routes[0].port = Some(8443);
    desired.certificate.clear();
    desired.private_key.clear();
    let owner = runtime::identity(&root);
    let mut calls = Vec::new();
    apply(&root,&root,"fixture","",desired,&mut |args| {
        calls.push(args.to_vec());
        if args.starts_with(&["container".into(),"ls".into()]) { return Ok("owned".into()); }
        if args.iter().any(|arg| arg.contains("box.https.owner")) { return Ok(owner.clone()); }
        if args.iter().any(|arg| arg.contains("State.Running")) { return Ok("true".into()); }
        Ok(String::new())
    }).unwrap();
    assert!(calls.iter().any(|args| args.starts_with(&["rm".into(),"-f".into()])));
    assert!(calls.iter().any(|args| args.starts_with(&["run".into(),"-d".into()]) && args.windows(2).any(|pair| pair == ["-p","8443:8443"])));
    assert!(calls.iter().any(|args| args.iter().any(|arg| arg == "reload")));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_service_images_do_not_block_path_settings() {
    let mut settings = input().settings;
    let template = settings.routes[0].clone();
    settings.routes = ["play", "creator", "voxa", "player-service", "player-auth-portal"]
        .into_iter()
        .map(|service| Route {
            service: service.into(),
            path: format!("/{service}"),
            ..template.clone()
        })
        .collect();
    let environment = [("BOX_IMAGE_TAG".into(), "2026.1.4".into())].into_iter().collect();
    let mut inspected = Vec::new();
    validate_path_images(&settings, &environment, &mut |args| {
        assert_eq!(&args[..2], ["image", "inspect"]);
        inspected.push(args.last().unwrap().clone());
        Err(format!("Error response from daemon: No such image: {}", args.last().unwrap()))
    }).expect("uninstalled components must not prevent saving entry paths");
    assert_eq!(inspected.len(), 5);
    let root = fixture_root();
    let mut desired = input();
    desired.settings = settings.clone();
    for route in &mut desired.settings.routes {
        route.secure = false;
    }
    desired.certificate.clear();
    desired.private_key.clear();
    let mut transition = UpstreamTransition::new(&root, "fixture", &desired.settings).unwrap();
    let mut calls = Vec::new();
    apply_with_transition(&root, &root, "fixture", "", desired, &mut |args| {
        calls.push(args.to_vec());
        Ok(String::new())
    }, &mut |rollback| {
        assert!(!rollback);
        transition.apply(&mut |_| Ok(String::new()), &mut |_| {
            panic!("saving settings must not start uninstalled services")
        })
    }).unwrap();
    let persisted = runtime::saved(&root).unwrap().unwrap();
    assert_eq!(persisted.settings.routes.len(), 5);
    assert!(persisted.settings.routes.iter().all(|route| !route.path.is_empty()));
    assert!(!calls.iter().any(|args| args[0] == "pull"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn path_settings_still_reject_incompatible_images_and_docker_errors() {
    let mut settings = input().settings;
    settings.routes[0].path = "/play".into();
    let environment = [("BOX_IMAGE_TAG".into(), "2026.1.4".into())].into_iter().collect();
    let error = validate_path_images(&settings, &environment, &mut |_| Ok("{}".into())).unwrap_err();
    assert!(error.contains("暂不支持入口路径"));
    let error = validate_path_images(&settings, &environment, &mut |_| Err("Cannot connect to the Docker daemon".into())).unwrap_err();
    assert!(error.contains("Cannot connect to the Docker daemon"));
}

#[test]
fn an_explicit_path_capable_image_does_not_require_a_default_image_tag() {
    let mut settings = input().settings;
    settings.routes[0].service = "player-auth-portal".into();
    settings.routes[0].path = "/sjixs".into();
    let environment = [("BOX_AUTH_PORTAL_IMAGE".into(),"box-local-engine-player-auth-portal:0.3.0".into())].into_iter().collect();
    validate_path_images(&settings,&environment,&mut |args| {
        assert_eq!(args.last().unwrap(),"box-local-engine-player-auth-portal:0.3.0");
        Ok(r#"{"box.routing.base-path":"runtime-v1"}"#.into())
    }).unwrap();
}

#[test]
fn external_manual_preserves_public_urls_and_owner_port_bindings() {
    let root=fixture_root();
    std::fs::create_dir_all(root.join("https")).unwrap();
    set_provider(&root,"external-manual").unwrap();
    let values=[("BOX_BIND_IP","192.168.1.2")].into_iter().map(|(key,value)|(key.into(),value.into())).collect();
    let mut derived=[("BOX_PLAY_PUBLIC_URL","https://example.test/play"),("BOX_AUTH_PORTAL_PUBLIC_URL","https://example.test/accounts")].into_iter().map(|(key,value)|(key.into(),value.into())).collect();
    apply_runtime_urls(&root,&values,&mut derived).unwrap();
    assert_eq!(derived["BOX_PLAY_PUBLIC_URL"],"https://example.test/play");
    assert_eq!(derived["BOX_PLAY_BASE_PATH"],"/play");
    assert_eq!(derived["BOX_AUTH_PORTAL_BASE_PATH"],"/accounts");
    assert_eq!(derived["BOX_BIND_IP"],"192.168.1.2");
    assert_eq!(derived["BOX_CREATOR_BIND_IP"],"127.0.0.1");
    let source="services:\n  play:\n    ports:\n      - '4121:3000'\n";
    assert_eq!(compose_source(&root,source).unwrap(),source);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn certificate_watcher_never_starts_a_stopped_or_external_proxy() {
    let root=fixture_root();
    let mut fixture=input();
    fixture.settings.routes.truncate(1);
    std::fs::create_dir_all(root.join("https/revisions/old")).unwrap();
    let saved=Saved {settings:fixture.settings.clone(),external_local:false,pending_local:false,expires_at:"2099-01-01T00:00:00Z".into(),revision:"old".into(),external_config:String::new(),certificate_sources:Default::default(),certificate_expiries:Default::default()};
    std::fs::write(root.join("https/settings.json"),serde_json::to_string(&saved).unwrap()).unwrap();
    std::fs::write(root.join("https/revisions/old/cert.pem"),&fixture.certificate).unwrap();
    std::fs::write(root.join("https/revisions/old/key.pem"),&fixture.private_key).unwrap();
    std::fs::write(root.join("renew.pem"),"new source").unwrap();
    std::fs::write(root.join("renew.key"),"new key").unwrap();
    super::path_certificates::commit(&root,&[("play".into(),CertificatePath {certificate_path:root.join("renew.pem").to_string_lossy().into(),private_key_path:root.join("renew.key").to_string_lossy().into(),source:"independent".into()})].into_iter().collect()).unwrap();
    let owner=super::runtime::identity(&root);
    let mut calls=Vec::new();
    assert!(!refresh_certificate_paths(&root,&root,"test","",&mut |args| {
        calls.push(args.join(" "));
        if args.starts_with(&["container".into(),"ls".into()]) {return Ok("owned".into());}
        if args.iter().any(|arg|arg.contains("box.https.owner")) {return Ok(owner.clone());}
        Ok("false".into())
    }).unwrap());
    assert!(!calls.iter().any(|line|line.contains("reload") || line.starts_with("run ") || line.starts_with("start ")));
    set_provider(&root,"external-manual").unwrap();
    assert!(!refresh_certificate_paths(&root,&root,"test","",&mut |_|panic!("external Nginx must not be touched")).unwrap());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn upstream_transition_checks_images_before_recreating_any_service() {
    let root = fixture_root();
    let mut transition = UpstreamTransition::new(&root, "fixture", &input().settings).unwrap();
    let calls = std::cell::RefCell::new(Vec::<Vec<String>>::new());
    let error = transition.apply(
        &mut |args| {
            if args.first().map(String::as_str) == Some("container") {
                return Ok("running-play".into());
            }
            if args.first().map(String::as_str) == Some("inspect") {
                return Ok(r#"[{"Image":"sha256:old-image"}]"#.into());
            }
            if args.starts_with(&["image".into(), "inspect".into()]) {
                return Err("No such image: box-local-engine-play:0.3.0".into());
            }
            Ok(String::new())
        },
        &mut |args| {
            calls.borrow_mut().push(args.to_vec());
            if args.first().map(String::as_str) == Some("config") {
                Ok(r#"{"services":{"play":{"image":"box-local-engine-play:0.3.0"}}}"#.into())
            } else { Ok(String::new()) }
        },
    ).unwrap_err();
    assert!(error.contains("box-local-engine-play:0.3.0"));
    assert!(calls.borrow().iter().all(|args| args[0] != "up"));
    let mut restored = false;
    transition.rollback("", &mut |_, _| { restored = true; Ok(String::new()) }).unwrap();
    assert!(!restored, "failed preflight must not recreate containers during rollback");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn upstream_transition_checks_only_running_targets_and_keeps_custom_images() {
    let root = fixture_root();
    let mut transition = UpstreamTransition::new(&root, "fixture", &input().settings).unwrap();
    let inspected = std::cell::RefCell::new(Vec::<String>::new());
    let composed = std::cell::RefCell::new(Vec::<Vec<String>>::new());
    transition.apply(
        &mut |args| {
            if args.first().map(String::as_str) == Some("container") { return Ok("running-play".into()); }
            if args.first().map(String::as_str) == Some("inspect") { return Ok(r#"[{"Image":"sha256:old-image"}]"#.into()); }
            if args.starts_with(&["image".into(), "inspect".into()]) { inspected.borrow_mut().push(args[2].clone()); }
            Ok(String::new())
        },
        &mut |args| {
            composed.borrow_mut().push(args.to_vec());
            if args[0] == "config" {
                Ok(r#"{"services":{"play":{"image":"custom/play:stable"},"redis":{"image":"missing-redis:latest"}}}"#.into())
            } else { Ok(String::new()) }
        },
    ).unwrap();
    assert_eq!(*inspected.borrow(), vec!["custom/play:stable"]);
    assert!(composed.borrow().iter().any(|args| args[0] == "up" && args.last().unwrap() == "play"));
    std::fs::remove_dir_all(root).unwrap();
}
