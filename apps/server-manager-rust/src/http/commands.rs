//! Authenticated management command dispatch.

use crate::*;

/// Executes the fixed allow-list of management commands.
///
/// Keep command names mapped here instead of executing client-provided shell
/// input. Mutating commands additionally share the process-wide mutation
/// guard, so a backup, restore or service operation cannot race another one.
pub(crate) async fn command(
    State(app): State<Arc<App>>,
    Path(name): Path<String>,
    headers: HeaderMap,
    Json(req): Json<Request>,
) -> Response {
    if name != "get_legal_notices" {
        if let Err(r) = auth(&headers, &app) {
            return r;
        }
    }
    let operation_id = headers
        .get("x-operation-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if let Some(id) = &operation_id {
        if let Err(error) = app.operations.begin(id) {
            return fail(error);
        }
    }
    let operations = app.operations.clone();
    let mut request_app = (*app).clone();
    request_app.operation_id = operation_id.clone();
    let app = request_app;
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let _operation = if box_manager_core::operation::mutates_runtime(&name) {
            Some(box_manager_core::operation::mutation_guard()?)
        } else { None };
        match name.as_str() {
            "install_nginx_image" => {
                box_manager_core::ssl::install_image_with_progress(
                    &mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>()),
                    &mut |image, progress| {
                        pull_image_with_progress(image, "Nginx", progress)
                    },
                    &mut |percent, message| {
                        app.progress("dependency-image-download", &message, percent)
                    },
                )?;
                Ok(json!(true))
            }
            "set_nginx_provider" => {
                let mode = req.body.get("mode").and_then(Value::as_str).ok_or("Nginx 来源无效")?;
                let status = box_manager_core::ssl::status(&app.root, &mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>()))?;
                if status["running"] == true { return Err("请先停止托管 Nginx 入口".into()); }
                box_manager_core::ssl::set_provider(&app.root, mode)?;
                Ok(json!(true))
            }
            "get_ssl_status" => box_manager_core::ssl::status(&app.root, &mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>())),
            "apply_ssl_config" => {
                let config:box_manager_core::ssl::Import=serde_json::from_value(req.body.get("config").cloned().ok_or("公网配置缺失")?).map_err(|_|"公网配置格式无效")?;
                let runtime=generate_runtime_environment(&app)?;
                box_manager_core::ssl::validate_path_images(&config.settings,&parse_env(&fs::read_to_string(runtime).map_err(|error|error.to_string())?),&mut |args|docker(&args.iter().map(String::as_str).collect::<Vec<_>>()))?;
                let environment=fs::read_to_string(env_path(&app)).map_err(|error|error.to_string())?;
                let source=fs::read_to_string(&app.compose_file).map_err(|error|error.to_string())?;
                let mut transition=box_manager_core::ssl::UpstreamTransition::new(&app.root,"box-local-engine",&config.settings)?;
                box_manager_core::ssl::apply_with_transition_progress(&app.root,&host_project_root(&app)?,"box-local-engine_default",&environment,config,&mut |args|docker(&args.iter().map(String::as_str).collect::<Vec<_>>()),&mut |image, progress| pull_image_with_progress(image, "Nginx", progress),&mut |percent, message| app.progress("dependency-image-download", &message, percent),&mut |rollback| {
                    if rollback {transition.rollback(&source,&mut |file,args|compose_file_output(&app,file,args))}
                    else {transition.apply(&mut |args|docker(&args.iter().map(String::as_str).collect::<Vec<_>>()),&mut |args|compose(&app,&args.iter().map(String::as_str).collect::<Vec<_>>()))}
                })
            }
            "reload_ssl_proxy" => box_manager_core::ssl::reload(&app.root, &host_project_root(&app)?, "box-local-engine_default", &fs::read_to_string(env_path(&app)).map_err(|error|error.to_string())?, &mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>())),
            "stop_ssl_proxy" => box_manager_core::ssl::stop(&app.root, &mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>())),
            "delete_ssl_certificate" => box_manager_core::ssl::delete_certificate(&app.root, &host_project_root(&app)?, "box-local-engine_default", &fs::read_to_string(env_path(&app)).map_err(|error|error.to_string())?, req.body.get("service").and_then(Value::as_str).ok_or("证书服务缺失")?, &mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>())),
            "verify_ssl_endpoint" => box_manager_core::ssl::verify_endpoint(&app.root, &mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>())),
            "get_raw_environment" => Ok(json!(
                fs::read_to_string(env_path(&app)).map_err(|e| e.to_string())?
            )),
            "save_raw_environment" => {
                let s = req
                    .body
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or("配置内容无效")?;
                validate_raw_environment(s)?;
                private(&env_path(&app), s)?;
                generate_runtime_environment(&app)?;
                Ok(json!(false))
            }
            "get_raw_nginx_config" => Ok(json!(box_manager_core::ssl::read_raw_nginx_config(&app.root)?)),
            "save_raw_nginx_config" => {
                let content = req
                    .body
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or("配置内容无效")?;
                Ok(json!(box_manager_core::ssl::save_raw_nginx_config(
                    &app.root,
                    &host_project_root(&app)?,
                    content,
                    &mut |args| docker(&args.iter().map(String::as_str).collect::<Vec<_>>()),
                )?))
            }
            "get_install_config" => {
                let values = parse_env(
                    &fs::read_to_string(env_path(&app)).map_err(|error| error.to_string())?,
                );
                let number = |key: &str, fallback: u64| {
                    values
                        .get(key)
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(fallback)
                };
                let decimal = |key: &str, fallback: f64| {
                    values
                        .get(key)
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(fallback)
                };
                let enabled = |key: &str, fallback: bool| {
                    values
                        .get(key)
                        .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
                        .unwrap_or(fallback)
                };
                let memory = |key: &str, fallback: u64| {
                    values
                        .get(key)
                        .and_then(|value| value.trim_end_matches(['m', 'M']).parse().ok())
                        .unwrap_or(fallback)
                };
                let (
                    url_database_host,
                    url_database_port,
                    url_database_name,
                    url_database_user,
                    url_database_password,
                ) = database_fields(values.get("BOX_DATABASE_URL"));
                let database_mode = values.get("BOX_DATABASE_MODE").cloned().unwrap_or_else(|| {
                    if url_database_host.is_empty() {
                        "managed".into()
                    } else {
                        "external".into()
                    }
                });
                let redis_mode = values.get("BOX_REDIS_MODE").cloned().unwrap_or_else(|| {
                    if values
                        .get("REDIS_HOST")
                        .is_some_and(|value| !value.is_empty())
                    {
                        "external".into()
                    } else {
                        "disabled".into()
                    }
                });
                let mut configuration = json!({
                    "databaseMode": database_mode,
                    "databaseHost": values.get("BOX_DATABASE_HOST").cloned().unwrap_or(url_database_host),
                    "databasePort": values.get("BOX_DATABASE_PORT").cloned().unwrap_or(url_database_port),
                    "databaseName": values.get("BOX_DATABASE_NAME").cloned().unwrap_or(url_database_name),
                    "databaseUser": values.get("BOX_DATABASE_USER").cloned().unwrap_or(url_database_user),
                    "databaseSsl": enabled("BOX_DATABASE_SSL", false),
                    "hasDatabasePassword": values.get("BOX_DATABASE_PASSWORD").is_some_and(|value| !value.is_empty()) || !url_database_password.is_empty(),
                    "hasPermissionTokenSecret": values.get("PERMISSION_TOKEN_SECRET").is_some_and(|value| value.len() >= 16),
                    "hasPlayerAuthApiKey": values.get("BOX_PLAYER_AUTH_API_KEY").is_some_and(|value| value.len() >= 16),
                    "hasPlayAdminToken": values.get("BOX_PLAY_ADMIN_TOKEN").is_some_and(|value| value.len() >= 16),
                    "redisMode": redis_mode,
                    "redisHost": values.get("REDIS_HOST").cloned().unwrap_or_default(),
                    "redisPort": values.get("REDIS_PORT").cloned().unwrap_or_else(|| "6379".into()),
                    "hasRedisPassword": values.get("REDIS_PASSWORD").is_some_and(|value| !value.is_empty()),
                    "redisDb": number("REDIS_DB", 0),
                    "storageCacheRedisDb": number("STORAGE_CACHE_REDIS_DB", 1),
                    "databasePoolSize": number("BOX_DATABASE_POOL_SIZE", 4),
                    "storageCacheRedisTtl": number("STORAGE_CACHE_REDIS_TTL", 240),
                    "autoBackupEnabled": enabled("BOX_AUTO_BACKUP_ENABLED", false),
                    "autoBackupIntervalMinutes": number("BOX_AUTO_BACKUP_INTERVAL_MINUTES", 60),
                    "autoBackupRetentionCount": number("BOX_AUTO_BACKUP_RETENTION_COUNT", 24),
                    "autoBackupRetentionDays": number("BOX_AUTO_BACKUP_RETENTION_DAYS", 30),
                    "publicHost": values.get("BOX_PLAY_PUBLIC_HOST").cloned().unwrap_or_else(|| url_host(values.get("BOX_PLAY_PUBLIC_URL"), "127.0.0.1")),
                    "publicAddress": box_manager_core::access_settings::public_address(&values),
                    "playPublicAddressOverride": values.get("BOX_PLAY_PUBLIC_ADDRESS_OVERRIDE").cloned().unwrap_or_default(),
                    "creatorPublicAddressOverride": values.get("BOX_CREATOR_PUBLIC_ADDRESS_OVERRIDE").cloned().unwrap_or_default(),
                    "voxaPublicAddressOverride": values.get("BOX_VOXA_PUBLIC_ADDRESS_OVERRIDE").cloned().unwrap_or_default(),
                    "playerServicePublicAddressOverride": values.get("BOX_PLAYER_SERVICE_PUBLIC_ADDRESS_OVERRIDE").cloned().unwrap_or_default(),
                    "authPortalPublicAddressOverride": values.get("BOX_AUTH_PORTAL_PUBLIC_ADDRESS_OVERRIDE").cloned().unwrap_or_default(),
                    "playNetworkMode": values.get("BOX_PLAY_NETWORK_MODE").cloned().unwrap_or_else(|| "local".into()),
                    "creatorNetworkMode": values.get("BOX_CREATOR_NETWORK_MODE").cloned().unwrap_or_else(|| "local".into()),
                    "creatorHost": values.get("BOX_CREATOR_HOST").cloned().unwrap_or_else(|| url_host(values.get("BOX_CREATOR_PUBLIC_URL"), "127.0.0.1")),
                    "lanIp": detect_lan_ip().unwrap_or_default(),
                    "playPort": number("BOX_PLAY_PORT", 3121),
                    "voxaPort": number("BOX_VOXA_PORT", 3123),
                    "creatorPort": number("BOX_CREATOR_PORT", 3127),
                    "playerServicePort": number("BOX_PLAYER_SERVICE_PORT", 3124),
                    "authPortalPort": number("BOX_AUTH_PORTAL_PORT", 3125),
                    "authPortalImage": values.get("BOX_AUTH_PORTAL_IMAGE").cloned().unwrap_or_default(),
                    "playRuntimes": number("BOX_PLAY_MAX_RUNTIMES", 8),
                    "creatorEditRuntimes": number("BOX_CREATOR_EDIT_MAX_RUNTIMES", 6),
                    "creatorPlayRuntimes": number("BOX_CREATOR_PLAY_MAX_RUNTIMES", 4),
                    "creatorEditPrewarmRuntimes": number("BOX_CREATOR_EDIT_PREWARM_RUNTIMES", 0),
                    "playPrewarmRuntimes": number("BOX_PLAY_PREWARM_RUNTIMES", 0),
                    "playerLimit": number("BOX_LOCAL_PLAYER_LIMIT", 70),
                    "scriptMemoryMb": number("BOX_SCRIPT_MEMORY_MB", 512),
                    "runtimeIdleMinutes": number("BOX_RUNTIME_IDLE_TIMEOUT_MS", 900000) / 60000,
                    "runtimeStartTimeoutMinutes": number("BOX_RUNTIME_START_TIMEOUT_MS", 1800000) / 60000,
                    "teleportMaxRooms": number("BOX_TELEPORT_MAX_ROOMS", 64),
                    "teleportRoomIdleMinutes": number("BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS", 900000) / 60000,
                    "registrationEnabled": enabled("BOX_PLAYER_REGISTRATION_ENABLED", true),
                    "playerServiceMemoryMb": memory("BOX_PLAYER_SERVICE_MEMORY_LIMIT", 1024),
                    "playerServiceCpuLimit": decimal("BOX_PLAYER_SERVICE_CPU_LIMIT", 1.0),
                    "authPortalMemoryMb": memory("BOX_AUTH_PORTAL_MEMORY_LIMIT", 128),
                    "authPortalCpuLimit": decimal("BOX_AUTH_PORTAL_CPU_LIMIT", 0.5),
                    "creatorMemoryMb": memory("BOX_CREATOR_MEMORY_LIMIT", 6144),
                    "creatorCpuLimit": decimal("BOX_CREATOR_CPU_LIMIT", 2.0),
                    "playMemoryMb": memory("BOX_PLAY_MEMORY_LIMIT", 4096),
                    "playCpuLimit": decimal("BOX_PLAY_CPU_LIMIT", 2.0)
                });
                if let Some(view) = box_manager_core::public_access::view(&values).as_object() {
                    for (key,value) in view { configuration[key] = value.clone(); }
                }
                configuration["publicSslConfigured"] = serde_json::to_value(box_manager_core::public_access::certificate_flags(&app.root)).map_err(|error|error.to_string())?;
                Ok(configuration)
            }
            "get_managed_service_info" => managed_service_info(
                &app,
                req.body
                    .get("service")
                    .and_then(Value::as_str)
                    .ok_or("内置服务名称无效")?,
            ),
            "has_managed_database_image" => {
                let values = parse_env(&fs::read_to_string(env_path(&app)).unwrap_or_default());
                Ok(json!(docker(&[
                    "image",
                    "inspect",
                    &managed_image(&values, "postgresql")?
                ])
                .is_ok()))
            }
            "prepare_managed_database" => {
                prepare_managed_service(&app, "postgresql")?;
                Ok(Value::Null)
            }
            "has_managed_redis_image" => {
                let values = parse_env(&fs::read_to_string(env_path(&app)).unwrap_or_default());
                Ok(json!(docker(&[
                    "image",
                    "inspect",
                    &managed_image(&values, "redis")?
                ])
                .is_ok()))
            }
            "prepare_managed_redis" => {
                prepare_managed_service(&app, "redis")?;
                Ok(Value::Null)
            }
            "start_managed_service" => {
                start_managed_service(
                    &app,
                    req.body
                        .get("service")
                        .and_then(Value::as_str)
                        .ok_or("内置服务名称无效")?,
                )?;
                Ok(Value::Null)
            }
            "get_legal_notices" => Ok(json!({
                "licenseName": "MIT License",
                "licenseText": LEGAL_NOTICE
            })),
            "get_docker_check" => Ok({
                let (ready, version, message) = docker_check();
                json!({"cliAvailable":ready || !message.contains("无法运行 Docker"),"cliVersion":version,"engineReady":ready,"message":if ready{"Docker 已连接"}else{&message}})
            }),
            "get_owner_secrets" => {
                let values = parse_env(
                    &fs::read_to_string(env_path(&app)).map_err(|error| error.to_string())?,
                );
                let secret = |key: &str| {
                    values
                        .get(key)
                        .filter(|value| value.len() >= 16)
                        .cloned()
                        .ok_or("服主密钥尚未生成，请先保存一次配置")
                };
                Ok(json!({
                    "permissionTokenSecret": secret("PERMISSION_TOKEN_SECRET")?,
                    "playerAuthApiKey": secret("BOX_PLAYER_AUTH_API_KEY")?,
                    "playAdminToken": secret("BOX_PLAY_ADMIN_TOKEN")?
                }))
            }
            "get_data_storage_info" => {
                let values = parse_env(&fs::read_to_string(env_path(&app)).unwrap_or_default());
                let using_default = values
                    .get("BOX_DATA_DIRECTORY")
                    .is_none_or(|value| value.trim().is_empty());
                Ok(json!({
                    "path": configured_data_directory(&app)?,
                    "usingDefault": using_default
                }))
            }
            "relocate_data_storage" => {
                let directory = req
                    .body
                    .get("directory")
                    .and_then(Value::as_str)
                    .ok_or("数据目录无效")?;
                migrate_data_directory(&app, directory)
            }
            "get_project_runtime_status" => Ok(runtime_catalog(&app)),
            "list_map_runtime_profiles" => list_map_runtime_profiles(&app),
            "save_map_runtime_profile" => {
                let profile: MapRuntimeProfile = serde_json::from_value(
                    req.body
                        .get("profile")
                        .cloned()
                        .ok_or("地图容器配置无效")?,
                )
                .map_err(|error| format!("地图容器配置无效：{error}"))?;
                save_map_runtime_profile(&app, profile)?;
                Ok(Value::Null)
            }
            "delete_map_runtime_profile" => {
                let permanent_map_id = req
                    .body
                    .get("permanentMapId")
                    .and_then(Value::as_str)
                    .ok_or("地图永久 ID 无效")?;
                let mode = req
                    .body
                    .get("mode")
                    .and_then(Value::as_str)
                    .ok_or("运行端类型无效")?;
                delete_map_runtime_profile(&app, permanent_map_id, mode)?;
                Ok(Value::Null)
            }
            "destroy_project_runtime" => {
                let project = req
                    .body
                    .get("projectId")
                    .and_then(Value::as_str)
                    .ok_or("作品 ID 无效")?;
                let mode = req
                    .body
                    .get("mode")
                    .and_then(Value::as_str)
                    .ok_or("运行端类型无效")?;
                let room = req.body.get("roomId").and_then(Value::as_str);
                destroy_runtime(project, mode, room)?;
                Ok(Value::Null)
            }
            "get_performance_status" => performance(&app),
            "export_diagnostics" => Ok(json!(export_diagnostics(&app)?)),
            "test_remote_connection" => test_connection(&app, &req.body),
            "list_backups" => list_backups(&app),
            "create_backup" => Ok(json!(create_backup(&app)?)),
            "delete_backup" => {
                let archive = req
                    .body
                    .get("archive")
                    .and_then(Value::as_str)
                    .ok_or("备份文件名无效")?;
                let path = backup_file(&app, archive)?;
                if !path.is_file() {
                    return Err("备份不存在".into());
                };
                fs::remove_file(path).map_err(|error| error.to_string())?;
                Ok(Value::Null)
            }
            "inspect_backup" => {
                let archive = req.body.get("archive").and_then(Value::as_str).ok_or("备份名称无效")?;
                inspect_backup(&app, archive)
            }
            "restore_backup" => {
                let archive = req.body.get("archive").and_then(Value::as_str).ok_or("备份名称无效")?;
                let include_env = req.body.get("includeEnv").and_then(Value::as_bool).unwrap_or(false);
                Ok(json!(restore_backup(&app, archive, include_env)?))
            }
            "save_configuration_command" => {
                let mut input = req
                    .body
                    .get("config")
                    .and_then(Value::as_object)
                    .ok_or("配置格式无效")?.clone();
                input.entry("publicSslConfigured").or_insert(serde_json::to_value(box_manager_core::public_access::certificate_flags(&app.root)).map_err(|error|error.to_string())?);
                let prepared = box_manager_core::public_access::prepare(&input)?;
                let config = &prepared;
                validate_configuration(config)?;
                if config.get("databaseMode").and_then(Value::as_str) == Some("external") {
                    let host = config
                        .get("databaseHost")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or_default();
                    if !host.is_empty() {
                        let host = validate_host(host, "数据库地址")?;
                        let database_port = config
                            .get("databasePort")
                            .map(|value| port(value, "数据库端口"))
                            .transpose()?
                            .map(|value| value.parse::<u16>().unwrap_or(5432))
                            .unwrap_or(5432);
                        check_remote_endpoint(" PostgreSQL", &host, database_port)?;
                    }
                }
                if config.get("redisMode").and_then(Value::as_str) == Some("external") {
                    let host = config
                        .get("redisHost")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or_default();
                    if !host.is_empty() {
                        let host = validate_host(host, "Redis 地址")?;
                        let redis_port = config
                            .get("redisPort")
                            .map(|value| port(value, "Redis 端口"))
                            .transpose()?
                            .map(|value| value.parse::<u16>().unwrap_or(6379))
                            .unwrap_or(6379);
                        check_remote_endpoint(" Redis", &host, redis_port)?;
                    }
                }
                let content = fs::read_to_string(env_path(&app)).map_err(|error| error.to_string())?;
                guard_managed_storage_credentials(
                    &content,
                    config,
                    managed_volume_exists("box-local-engine_box-managed-postgres-data"),
                    false,
                )?;
                let source = configuration_document_for_save(&content, config)?;
                private(&env_path(&app), &source)?;
                generate_runtime_environment(&app)?;
                Ok(Value::Null)
            }
            "start_services" => {
                let scope = req.body.get("scope").and_then(Value::as_str).ok_or("启动范围无效")?;
                services::start(&WebRuntime(&app), scope)?;
                Ok(Value::Null)
            }
            "get_system_status" => {
                system_status(&app)
            }
            "start_server_update" => {
                let version = req.body.get("version").and_then(Value::as_str).ok_or("更新版本无效")?;
                let updater = start_server_update(&app, version)?;
                Ok(json!({"updater": updater}))
            }
            "control_service" => {
                let action = req.body.get("action").and_then(Value::as_str).ok_or("操作名称无效")?;
                let service = req.body.get("service").and_then(Value::as_str).ok_or("服务名称无效")?;
                services::control(&WebRuntime(&app), service, action)?;
                Ok(Value::Null)
            }
            "stop_services" => { services::stop(&WebRuntime(&app))?; Ok(Value::Null) }
            "get_about_info" => Ok(json!({
                "applicationVersion": option_env!("BOX_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
                "imageTag": env::var("BOX_IMAGE_TAG").unwrap_or_default(),
                "sourceRevision": option_env!("BOX_BUILD_COMMIT").unwrap_or("unknown"),
                "buildCreatedAt": option_env!("BOX_BUILD_DATE").unwrap_or("unknown"),
                "buildSource": option_env!("BOX_BUILD_SOURCE").unwrap_or("local"),
                "platform": "linux",
                "architecture": env::consts::ARCH,
                "license": "MIT License",
                "serviceImages": service_images()
            })),
            "get_latest_release" => {
                if box_manager_core::release_channel::is_dev(option_env!("BOX_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))) {
                    return Err("开发版本不检查线上更新，请重新打包".into());
                }
                let client = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(10))
                    .build()
                    .map_err(|error| error.to_string())?;
                let mut response = client
                    .get(format!("{}/latest-server.json", box_manager_core::release_channel::release_base(option_env!("BOX_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")))))
                    .header(reqwest::header::CACHE_CONTROL, "no-cache")
                    .send()
                    .map_err(|error| format!("无法读取更新清单：{error}"))?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    response = client.get(format!("{}/latest.json", box_manager_core::release_channel::release_base(option_env!("BOX_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")))))
                        .header(reqwest::header::CACHE_CONTROL, "no-cache").send()
                        .map_err(|error| format!("无法读取更新清单：{error}"))?;
                }
                if !response.status().is_success() {
                    return Err(format!("更新服务返回 HTTP {}", response.status()));
                }
                let bytes = response.bytes().map_err(|error| error.to_string())?;
                if bytes.len() > 128_000 {
                    return Err("更新清单过大".into());
                }
                serde_json::from_slice(&bytes).map_err(|error| format!("更新清单无效：{error}"))
            }
            _ => Err(format!("暂不支持命令 {name}")),
        }
    })
    .await
    .unwrap_or_else(|error| Err(format!("管理命令异常结束：{error}")));
    if let Some(id) = operation_id {
        match &answer {
            Ok(_) => operations.update(&id, "complete", "操作已完成", 100, true),
            Err(error) => operations.update(&id, "error", error, 100, true),
        }
    }
    match answer {
        Ok(result) => Json(json!({"result":result})).into_response(),
        Err(e) => fail(e),
    }
}
