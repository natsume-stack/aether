//! Internal regression tests for the server manager.

use super::*;
use crate::http::commands::command;
use crate::runtime::runtime::{
    docker_bytes, runtime_compose_labels, runtime_container_name, runtime_entrypoint_command,
    RuntimeEnsureRequest,
};

#[test]
fn saving_local_access_replaces_public_hosts_but_preserves_the_public_draft() {
    let owner = "BOX_DATABASE_MODE=external\nBOX_PLAY_PUBLIC_HOST=user.box3lab.com\nBOX_CREATOR_HOST=user.box3lab.com\nBOX_PLAY_NETWORK_MODE=public\nBOX_CREATOR_NETWORK_MODE=public\nBOX_AUTH_PORTAL_IMAGE=my-login:1.0\n";
    let form = json!({ "publicAddress":"https://user.box3lab.com", "playNetworkMode":"local", "creatorNetworkMode":"local", "publicHost":"user.box3lab.com", "creatorHost":"user.box3lab.com" });
    let source = configuration_document_for_save(owner, form.as_object().unwrap()).unwrap();
    let values = parse_env(&source);
    assert_eq!(values["BOX_PLAY_PUBLIC_HOST"], "127.0.0.1");
    assert_eq!(values["BOX_CREATOR_HOST"], "127.0.0.1");
    assert_eq!(values["BOX_PUBLIC_ADDRESS"], "https://user.box3lab.com");
    assert_eq!(values["BOX_AUTH_PORTAL_IMAGE"], "my-login:1.0");
}

#[test]
fn login_image_configuration_is_persisted_cleared_and_validated() {
    let owner = "BOX_DATABASE_MODE=external\nBOX_DATABASE_HOST=db\nBOX_DATABASE_PORT=5432\nBOX_DATABASE_NAME=box\nBOX_DATABASE_USER=owner\nBOX_DATABASE_PASSWORD=fixture\n";
    let form = json!({"authPortalImage":"registry.test/login:1.0"});
    let custom = configuration_document_for_save(owner, form.as_object().unwrap()).unwrap();
    assert_eq!(
        parse_env(&custom)["BOX_AUTH_PORTAL_IMAGE"],
        "registry.test/login:1.0"
    );
    let blank = json!({"authPortalImage":""});
    let restored = configuration_document_for_save(&custom, blank.as_object().unwrap()).unwrap();
    assert!(!parse_env(&restored).contains_key("BOX_AUTH_PORTAL_IMAGE"));
    let invalid = json!({"authPortalImage":"https://registry.test/image"});
    assert!(configuration_document_for_save(owner, invalid.as_object().unwrap()).is_err());
    let owner = format!("{owner}BOX_IMAGE_TAG=v2026.1.4-linux-amd64\n");
    let legacy = json!({"authPortalImage":"box-local-engine-player-auth-portal:2026.1.4"});
    let normalized = configuration_document_for_save(&owner, legacy.as_object().unwrap()).unwrap();
    assert!(!parse_env(&normalized).contains_key("BOX_AUTH_PORTAL_IMAGE"));
}

#[test]
fn startup_tokens_require_a_real_secret_and_explain_the_configuration_fix() {
    assert_eq!(
        validate_startup_token("BOX_RUNTIME_MANAGER_TOKEN", Some("a".repeat(32))).unwrap(),
        "a".repeat(32)
    );
    let error = validate_startup_token("BOX_RUNTIME_MANAGER_TOKEN", None).unwrap_err();
    assert!(error.contains("BOX_RUNTIME_MANAGER_TOKEN"));
    assert!(error.contains(".env"));
    assert!(error.contains("至少 32"));
}

#[test]
fn private_runtime_container_name_preserves_the_room_identifier() {
    let request = RuntimeEnsureRequest {
        permanent_map_id: "4dffa49240b57b50ad2c".into(),
        mode: "play".into(),
        project_id: "cloud-38e4bc37eb12c301-imported".into(),
        // base64url room IDs intentionally include uppercase characters.
        room_id: Some("jH7lkcTtX4Dy9UhViJBShztfSFX2O7gQ".into()),
        cpu_milli: Some(500),
        memory_mb: Some(256),
        process_limit: Some(128),
        network_policy: Some("private".into()),
        bandwidth_mbps: Some(20),
        player_limit: 8,
        idle_timeout_ms: 900_000,
        teleport_control_url: "http://play:9966/__local_teleport".into(),
        teleport_internal_token: "test-token-with-at-least-32-characters".into(),
    };

    let name = runtime_container_name(&request).unwrap();
    assert_eq!(
        name,
        "box-runtime-play-4dffa49240b57b50ad2c-jH7lkcTtX4Dy9UhViJBShztfSFX2O7gQ"
    );
}

#[test]
fn isolated_runtimes_have_a_separate_compose_project_and_service_label() {
    let request = RuntimeEnsureRequest {
        permanent_map_id: "map-a".into(),
        mode: "play".into(),
        project_id: "map-a".into(),
        room_id: Some("room-01".into()),
        cpu_milli: Some(500),
        memory_mb: Some(256),
        process_limit: Some(128),
        network_policy: Some("unrestricted".into()),
        bandwidth_mbps: None,
        player_limit: 8,
        idle_timeout_ms: 900_000,
        teleport_control_url: "http://play:9966/__local_teleport".into(),
        teleport_internal_token: "test-token-with-at-least-32-characters".into(),
    };
    assert_eq!(
        runtime_compose_labels(&request),
        [
            String::from("com.docker.compose.project=box-local-engine-runtime"),
            String::from("com.docker.compose.service=play-map-a-room-01"),
        ]
    );
}

#[test]
fn public_runtime_service_label_uses_public_as_the_room_name() {
    let request = RuntimeEnsureRequest {
        permanent_map_id: "map-a".into(),
        mode: "play".into(),
        project_id: "map-a".into(),
        room_id: None,
        cpu_milli: Some(500),
        memory_mb: Some(256),
        process_limit: Some(128),
        network_policy: Some("unrestricted".into()),
        bandwidth_mbps: None,
        player_limit: 8,
        idle_timeout_ms: 900_000,
        teleport_control_url: "http://play:9966/__local_teleport".into(),
        teleport_internal_token: "test-token-with-at-least-32-characters".into(),
    };
    assert_eq!(
        runtime_compose_labels(&request)[1],
        "com.docker.compose.service=play-map-a-public"
    );
}

#[test]
fn privileged_runtime_setup_drops_to_node_before_starting_the_game() {
    let command = runtime_entrypoint_command(true);
    assert!(command.contains("iptables -P OUTPUT DROP"));
    assert!(command.contains("tc qdisc replace dev eth0 root tbf"));
    assert!(command
        .contains("exec setpriv --reuid=node --regid=node --init-groups --bounding-set=-all node"));
    assert!(!runtime_entrypoint_command(false).contains("setpriv"));
}

#[tokio::test]
async fn http_command_progress_has_the_same_shape_and_requires_authentication() {
    let app = Arc::new(App {
        root: PathBuf::from("/unused-test-root"),
        token: "fixture-token-with-at-least-32-chars".into(),
        runtime_token: "fixture-runtime-token-with-32-chars".into(),
        compose_file: PathBuf::from("/unused-test-root/compose.yml"),
        environment_file: PathBuf::from("/unused-test-root/.env"),
        operations: Arc::new(Operations::default()),
        operation_id: None,
    });
    let id = "fixture-operation-0001";
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {}", app.token).parse().unwrap(),
    );
    headers.insert("x-operation-id", id.parse().unwrap());
    let public_notice = command(
        State(app.clone()),
        Path("get_legal_notices".into()),
        HeaderMap::new(),
        Json(Request {
            body: BTreeMap::new(),
        }),
    )
    .await;
    assert_eq!(public_notice.status(), StatusCode::OK);
    let protected_about = command(
        State(app.clone()),
        Path("get_about_info".into()),
        HeaderMap::new(),
        Json(Request {
            body: BTreeMap::new(),
        }),
    )
    .await;
    assert_eq!(protected_about.status(), StatusCode::UNAUTHORIZED);
    let response = command(
        State(app.clone()),
        Path("get_legal_notices".into()),
        headers.clone(),
        Json(Request {
            body: BTreeMap::new(),
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = operation_progress(State(app.clone()), Path(id.into()), headers).await;
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let progress: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        progress,
        json!({"stage":"complete","message":"操作已完成","percent":100})
    );
    let denied = operation_progress(State(app), Path(id.into()), HeaderMap::new()).await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
}

const MIGRATION_OWNER: &str = "# owner comment\nBOX_PLAY_PUBLIC_URL=https://play.example/worlds\nBOX_CREATOR_PUBLIC_URL=https://create.example/editor\nBOX_AUTH_PORTAL_PUBLIC_URL=https://auth.example/\nBOX_PLAYER_LOGIN_URL=https://login.example/custom\nBOX_DATABASE_URL=postgres://owner:fixture@db/box?sslmode=require\n";

#[test]
fn web_form_preserves_unchanged_migrated_urls_and_external_query() {
    let form = json!({"databaseMode":"external", "publicHost":"play.example", "playNetworkMode":"public",
            "creatorHost":"create.example", "creatorNetworkMode":"public", "playPort":3121,
            "databaseHost":"db", "databasePort":"5432", "databaseName":"box", "databaseUser":"owner", "databasePassword":""});
    let source =
        configuration_document_for_save(MIGRATION_OWNER, form.as_object().unwrap()).unwrap();
    let values = parse_env(&source);
    assert_eq!(
        values["BOX_PLAY_PUBLIC_URL_OVERRIDE"],
        "https://play.example/worlds"
    );
    assert_eq!(
        values["BOX_CREATOR_PUBLIC_URL_OVERRIDE"],
        "https://create.example/editor"
    );
    assert_eq!(values["BOX_DATABASE_QUERY"], "sslmode=require");
    assert_eq!(values["BOX_DATABASE_PASSWORD"], "fixture");
    assert_eq!(
        database_url(&values).unwrap(),
        "postgresql://owner:fixture@db:5432/box?sslmode=require"
    );
    assert!(source.contains("# owner comment"));
}

#[test]
fn web_form_changes_clear_only_affected_overrides_without_recreating_them() {
    for (form, clear_auth) in [
        (
            json!({"publicHost":"new.example", "playNetworkMode":"public", "playPort":4000}),
            true,
        ),
        (json!({"playPort":4000}), false),
    ] {
        let source =
            configuration_document_for_save(MIGRATION_OWNER, form.as_object().unwrap()).unwrap();
        let values = parse_env(&migrate_document(&source).unwrap());
        assert!(!values.contains_key("BOX_PLAY_PUBLIC_URL_OVERRIDE"));
        assert_eq!(
            values.contains_key("BOX_AUTH_PORTAL_PUBLIC_URL_OVERRIDE"),
            !clear_auth
        );
        assert!(values.contains_key("BOX_CREATOR_PUBLIC_URL_OVERRIDE"));
        assert_eq!(
            values["BOX_PLAYER_LOGIN_URL_OVERRIDE"],
            "https://login.example/custom"
        );
    }
}

#[test]
fn web_form_clears_external_query_after_switching_to_managed() {
    let form = json!({"databaseMode":"managed"});
    let source =
        configuration_document_for_save(MIGRATION_OWNER, form.as_object().unwrap()).unwrap();
    let values = parse_env(&source);
    assert_eq!(values["BOX_DATABASE_MODE"], "managed");
    assert!(!values.contains_key("BOX_DATABASE_QUERY"));
    assert!(!database_url(&values).unwrap().contains('?'));
    assert!(!parse_env(&migrate_document(&source).unwrap()).contains_key("BOX_DATABASE_QUERY"));
}

#[test]
fn web_form_preserves_legacy_managed_storage_credentials() {
    let owner = "BOX_DATABASE_MODE=managed\nBOX_DATABASE_NAME=existing_db\nBOX_DATABASE_USER=existing_user\nBOX_DATABASE_PASSWORD=existing_password\nBOX_REDIS_MODE=managed\nREDIS_PASSWORD=existing_redis_password\n";
    let form = json!({"databaseMode":"managed", "redisMode":"managed"});
    let source = configuration_document_for_save(owner, form.as_object().unwrap()).unwrap();
    let values = parse_env(&source);
    assert_eq!(values["BOX_MANAGED_POSTGRES_DATABASE"], "existing_db");
    assert_eq!(values["BOX_MANAGED_POSTGRES_USER"], "existing_user");
    assert_eq!(values["BOX_MANAGED_POSTGRES_PASSWORD"], "existing_password");
    assert_eq!(
        values["BOX_MANAGED_REDIS_PASSWORD"],
        "existing_redis_password"
    );
}

#[test]
fn existing_postgres_volume_rejects_missing_credentials_but_redis_accepts_new_credentials() {
    let postgres = json!({"databaseMode":"managed"});
    let postgres_error = guard_managed_storage_credentials(
        "BOX_DATABASE_MODE=managed\n",
        postgres.as_object().unwrap(),
        true,
        false,
    )
    .unwrap_err();
    assert!(postgres_error.contains("已有内置 PostgreSQL 数据"));

    let redis = json!({"redisMode":"managed"});
    guard_managed_storage_credentials(
        "BOX_REDIS_MODE=managed\n",
        redis.as_object().unwrap(),
        false,
        true,
    )
    .unwrap();
}

struct MigrationFixture(App);
impl MigrationFixture {
    fn new(source: &str) -> Self {
        let root = std::env::temp_dir().join(format!("box-web-migration-{}", random_hex(12)));
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".env"), source).unwrap();
        Self(App {
            environment_file: root.join(".env"),
            compose_file: root.join("compose.yml"),
            root,
            token: "fixture-token-not-used-for-network".into(),
            runtime_token: "fixture-runtime-token-not-used".into(),
            operations: Arc::new(Operations::default()),
            operation_id: None,
        })
    }
}
impl Drop for MigrationFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0.root);
    }
}

#[test]
fn web_runtime_persists_migration_after_successful_derivation() {
    let fixture = MigrationFixture::new(MIGRATION_OWNER);
    let path = generate_runtime_environment(&fixture.0).unwrap();
    let owner = fs::read_to_string(env_path(&fixture.0)).unwrap();
    assert_eq!(owner, migrate_document(MIGRATION_OWNER).unwrap());
    let runtime = parse_env(&fs::read_to_string(path).unwrap());
    assert_eq!(
        runtime["BOX_PLAY_PUBLIC_URL"],
        "https://play.example/worlds"
    );
    assert_eq!(runtime["BOX_CREATOR_BIND_IP"], "0.0.0.0");
    assert_eq!(
        runtime["BOX_PLAYER_LOGIN_URL"],
        "https://login.example/custom"
    );
    assert_eq!(
        runtime["BOX_DATABASE_URL"],
        "postgresql://owner:fixture@db:5432/box?sslmode=require"
    );
    generate_runtime_environment(&fixture.0).unwrap();
    assert_eq!(fs::read_to_string(env_path(&fixture.0)).unwrap(), owner);
}

#[test]
fn web_runtime_failure_leaves_unmigrated_owner_untouched() {
    let invalid = format!("{MIGRATION_OWNER}BOX_PLAY_PORT=3123\n");
    let fixture = MigrationFixture::new(&invalid);
    assert!(generate_runtime_environment(&fixture.0).is_err());
    assert_eq!(fs::read_to_string(env_path(&fixture.0)).unwrap(), invalid);
    assert!(!runtime_env_path(&fixture.0).exists());
    let fixture = MigrationFixture::new(MIGRATION_OWNER);
    fs::create_dir(runtime_env_path(&fixture.0)).unwrap();
    fs::write(runtime_env_path(&fixture.0).join("owner-data"), "keep").unwrap();
    assert!(generate_runtime_environment(&fixture.0).is_err());
    assert_eq!(
        fs::read_to_string(env_path(&fixture.0)).unwrap(),
        MIGRATION_OWNER
    );
}

#[test]
fn compose_uses_host_bind_paths_instead_of_container_workspace_paths() {
    let mounts = json!([
        {"Type":"bind","Source":"/opt/box","Destination":"/workspace"},
        {"Type":"bind","Source":"/other","Destination":"/unrelated"}
    ]);
    assert_eq!(
        mapped_host_root(FsPath::new("/workspace"), &mounts).unwrap(),
        PathBuf::from("/opt/box")
    );
    assert_eq!(
        mapped_host_root(FsPath::new("/workspace/sub"), &mounts).unwrap(),
        PathBuf::from("/opt/box/sub")
    );
    assert!(mapped_host_root(FsPath::new("/missing"), &mounts).is_err());
}

#[test]
fn environment_ignores_comments_and_updates_spaced_keys() {
    let source = "# EXAMPLE=value\nBOX_PLAY_PORT = 3121\n";
    assert!(!parse_env(source).contains_key("# EXAMPLE"));
    let updated = set_env(source.into(), "BOX_PLAY_PORT", "4000").unwrap();
    assert_eq!(updated, "# EXAMPLE=value\nBOX_PLAY_PORT=4000\n");
}

#[test]
fn environment_replacement_is_key_scoped_and_keeps_a_final_newline() {
    let output = set_env(
        "BOX_PLAY_PORT=3121\nOTHER=value\n".into(),
        "BOX_PLAY_PORT",
        "4000",
    )
    .unwrap();
    assert_eq!(output, "BOX_PLAY_PORT=4000\nOTHER=value\n");
    assert_eq!(
        set_env(output, "NEW_VALUE", "yes").unwrap(),
        "BOX_PLAY_PORT=4000\nOTHER=value\nNEW_VALUE=yes\n"
    );
}

#[test]
fn port_validation_rejects_out_of_range_values() {
    assert_eq!(port(&json!(3130), "port").unwrap(), "3130");
    assert!(port(&json!(0), "port").is_err());
    assert!(port(&json!(65536), "port").is_err());
    assert!(port(&json!("10\nEVIL=1"), "port").is_err());
}

#[test]
fn database_url_fields_round_trip_common_postgres_urls() {
    let url =
        "postgres://box%20user:secret%21@db.example:5444/box_data?sslmode=require".to_string();
    assert_eq!(
        database_fields(Some(&url)),
        (
            "db.example".into(),
            "5444".into(),
            "box_data".into(),
            "box user".into(),
            "secret!".into()
        )
    );
    assert_eq!(
        database_fields(None),
        ("".into(), "5432".into(), "box".into(), "".into(), "".into())
    );
}

#[test]
fn private_file_replaces_only_empty_docker_directory_placeholders() {
    let root = std::env::temp_dir().join(format!(
        "box-private-placeholder-{}-{}",
        std::process::id(),
        random_hex(6)
    ));
    fs::create_dir_all(&root).unwrap();
    let empty = root.join("config");
    fs::create_dir(&empty).unwrap();
    private(&empty, "config").unwrap();
    assert_eq!(fs::read_to_string(&empty).unwrap(), "config");

    let nonempty = root.join("config.env");
    fs::create_dir(&nonempty).unwrap();
    fs::write(nonempty.join("keep"), "owner data").unwrap();
    assert!(private(&nonempty, "config").is_err());
    assert_eq!(
        fs::read_to_string(nonempty.join("keep")).unwrap(),
        "owner data"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn database_url_prefers_fields_and_falls_back_to_stored_url() {
    let mut managed = BTreeMap::new();
    managed.insert("BOX_DATABASE_MODE".to_string(), "managed".to_string());
    managed.insert("BOX_DATABASE_NAME".to_string(), "box".to_string());
    managed.insert("BOX_DATABASE_USER".to_string(), "box".to_string());
    managed.insert("BOX_DATABASE_PASSWORD".to_string(), "secret".to_string());
    assert_eq!(
        database_url(&managed).unwrap(),
        "postgresql://box:secret@managed-postgres:5432/box"
    );
    let mut external = BTreeMap::new();
    external.insert(
        "BOX_DATABASE_URL".to_string(),
        "postgresql://box:pw@db.example:5432/box".to_string(),
    );
    assert_eq!(
        database_url(&external).unwrap(),
        "postgresql://box:pw@db.example:5432/box"
    );
    assert!(database_url(&BTreeMap::new()).is_err());
}

#[test]
fn runtime_catalog_returns_empty_collections_for_empty_deployment_data() {
    let root = std::env::temp_dir().join(format!("box-runtime-catalog-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let app = App {
        root: root.clone(),
        token: "x".repeat(32),
        runtime_token: "y".repeat(32),
        compose_file: root.join("compose.yml"),
        operations: Arc::new(Operations::default()),
        operation_id: None,
        environment_file: root.join(".env"),
    };
    assert_eq!(runtime_catalog(&app), json!({"creator":[],"play":[]}));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn map_runtime_profiles_match_desktop_storage_semantics() {
    let root = std::env::temp_dir().join(format!(
        "box-map-runtime-profiles-{}-{}",
        std::process::id(),
        random_hex(6)
    ));
    let app = App {
        root: root.clone(),
        token: "x".repeat(32),
        runtime_token: "y".repeat(32),
        compose_file: root.join("compose.yml"),
        environment_file: root.join(".env"),
        operations: Arc::new(Operations::default()),
        operation_id: None,
    };
    let profile = MapRuntimeProfile {
        permanent_map_id: "demo-map-1".into(),
        mode: "play".into(),
        player_limit: 12,
        room_limit: 3,
        idle_timeout_ms: 60_000,
        cpu_milli: Some(750),
        memory_mb: Some(512),
    };

    save_map_runtime_profile(&app, profile).unwrap();
    assert_eq!(
        list_map_runtime_profiles(&app).unwrap(),
        json!([{
            "permanentMapId": "demo-map-1",
            "mode": "play",
            "playerLimit": 12,
            "roomLimit": 3,
            "idleTimeoutMs": 60_000,
            "cpuMilli": 750,
            "memoryMb": 512
        }])
    );
    assert_eq!(
        serde_json::from_str::<Value>(
            &fs::read_to_string(map_runtime_profiles_path(&app)).unwrap()
        )
        .unwrap()["version"],
        1
    );
    delete_map_runtime_profile(&app, "demo-map-1", "play").unwrap();
    assert_eq!(list_map_runtime_profiles(&app).unwrap(), json!([]));
    assert!(delete_map_runtime_profile(&app, "bad_map", "play").is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn runtime_status_does_not_wait_for_a_keep_alive_socket_to_close() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 17\r\nConnection: keep-alive\r\n\r\n{\"phase\":\"ready\"}",
                )
                .unwrap();
        std::thread::sleep(Duration::from_millis(1500));
    });
    let status = runtime_status("127.0.0.1", port, "project-id", "");
    assert_eq!(status["phase"], "ready");
    server.join().unwrap();
}

#[test]
fn chunked_runtime_status_body_decodes_before_json_parsing() {
    assert_eq!(
        decode_chunked_body(b"11\r\n{\"phase\":\"ready\"}\r\n0\r\n\r\n"),
        Some(b"{\"phase\":\"ready\"}".to_vec())
    );
}

#[test]
fn docker_bytes_decodes_docker_stats_units() {
    assert_eq!(docker_bytes("243.8MiB"), Some(255_642_829));
    assert_eq!(docker_bytes("256MiB"), Some(268_435_456));
    assert_eq!(docker_bytes("1.5GB"), Some(1_500_000_000));
    assert_eq!(docker_bytes("not-a-size"), None);
}

#[test]
fn independent_service_addresses_preserve_empty_entries_in_saved_owner_document() {
    let saved = configuration_document_for_save("BOX_DATABASE_MODE=managed\nBOX_REDIS_MODE=disabled\n", json!({"databaseMode":"managed","redisMode":"disabled","playNetworkMode":"public","creatorNetworkMode":"public","publicAddress":"https://play.example.test","playPublicAddressOverride":"https://play.example.test","creatorPublicAddressOverride":"https://arena.example.test","voxaPublicAddressOverride":"","playerServicePublicAddressOverride":"","authPortalPublicAddressOverride":""}).as_object().unwrap()).unwrap();
    let values = parse_env(&saved);
    assert_eq!(values["BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE"], "https://play.example.test");
    assert_eq!(values["BOX_CREATOR_PUBLIC_ADDRESS_OVERRIDE"], "https://arena.example.test");
    assert_eq!(values["BOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE"], "");
}

#[test]
fn managed_redis_missing_credentials_uses_new_password_without_shared_owner_hosts() {
    let config = json!({"databaseMode":"external","redisMode":"managed","redisPassword":"new-test-password","playNetworkMode":"public","creatorNetworkMode":"public","publicAddress":"https://old.example.test","playPublicAddressOverride":"https://play.example.test","creatorPublicAddressOverride":"https://arena.example.test","voxaPublicAddressOverride":"","playerServicePublicAddressOverride":"","authPortalPublicAddressOverride":""});
    let owner = "BOX_REDIS_MODE=managed\nBOX_PLAY_PUBLIC_HOST=old.example.test\nBOX_CREATOR_HOST=old.example.test\n";
    guard_managed_storage_credentials(owner, config.as_object().unwrap(), false, true).unwrap();
    let saved = configuration_document_for_save(owner, config.as_object().unwrap()).unwrap();
    let values = parse_env(&saved);
    assert_eq!(values["REDIS_PASSWORD"], "new-test-password");
    assert_eq!(values["BOX_MANAGED_REDIS_PASSWORD"], "new-test-password");
    assert!(!values.contains_key("BOX_PLAY_PUBLIC_HOST"));
    assert!(!values.contains_key("BOX_CREATOR_HOST"));
}

#[test]
fn partial_form_does_not_switch_existing_managed_dependencies() {
    let owner="BOX_DATABASE_MODE=managed\nBOX_DATABASE_HOST=managed-postgres\nBOX_MANAGED_POSTGRES_DATABASE=box\nBOX_MANAGED_POSTGRES_USER=owner\nBOX_MANAGED_POSTGRES_PASSWORD=fixture\nBOX_REDIS_MODE=managed\nBOX_MANAGED_REDIS_PASSWORD=cache-fixture\n";
    let form=json!({"registrationEnabled":false});
    let result=configuration_document_for_save(owner,form.as_object().unwrap()).unwrap();
    let values=parse_env(&result);
    assert_eq!(values["BOX_DATABASE_MODE"],"managed");
    assert_eq!(values["BOX_REDIS_MODE"],"managed");
    assert_eq!(values["BOX_MANAGED_POSTGRES_PASSWORD"],"fixture");
}

#[test]
fn external_database_ipv6_form_produces_a_valid_encoded_url() {
    let form=json!({"databaseMode":"external","databaseHost":"2001:db8::7","databasePort":"5444","databaseName":"box name","databaseUser":"owner@example","databasePassword":"p@ss:+"});
    let result=configuration_document_for_save("",form.as_object().unwrap()).unwrap();
    let values=parse_env(&result);
    let url=box_manager_core::configuration::parse_database_url(&values["BOX_DATABASE_URL"]).unwrap();
    assert_eq!(url.host,"2001:db8::7");
    assert_eq!(url.port,5444);
    assert_eq!(url.password,"p@ss:+");
}

#[test]
fn switching_to_passwordless_external_services_does_not_reuse_managed_secrets() {
    let owner="BOX_DATABASE_MODE=managed\nBOX_DATABASE_HOST=managed-postgres\nBOX_DATABASE_PASSWORD=managed-secret\nBOX_DATABASE_NAME=box\nBOX_DATABASE_USER=owner\nBOX_REDIS_MODE=managed\nREDIS_HOST=managed-redis\nREDIS_PASSWORD=managed-cache-secret\n";
    let form=json!({"databaseMode":"external","databaseHost":"db.example.test","databasePort":"5432","databaseName":"box","databaseUser":"owner","databasePassword":"","redisMode":"external","redisHost":"redis.example.test","redisPort":"6379","redisPassword":""});
    let values=parse_env(&configuration_document_for_save(owner,form.as_object().unwrap()).unwrap());
    assert_eq!(values["BOX_DATABASE_PASSWORD"],"");
    assert_eq!(values["REDIS_PASSWORD"],"");
    let form=json!({"databaseMode":"external","databaseHost":"db.example.test","redisMode":"external","redisHost":"redis.example.test"});
    let owner="BOX_DATABASE_MODE=external\nBOX_DATABASE_PASSWORD=existing-secret\nBOX_DATABASE_NAME=box\nBOX_DATABASE_USER=owner\nBOX_DATABASE_PORT=5432\nBOX_REDIS_MODE=external\nREDIS_PASSWORD=existing-cache-secret\n";
    let values=parse_env(&configuration_document_for_save(owner,form.as_object().unwrap()).unwrap());
    assert_eq!(values["BOX_DATABASE_PASSWORD"],"existing-secret");
    assert_eq!(values["REDIS_PASSWORD"],"existing-cache-secret");
}
