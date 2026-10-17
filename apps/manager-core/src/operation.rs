//! Both command adapters serialize runtime mutations. Read-only status and HTTP
//! progress remain available while a backup or Docker command is in progress.
use std::sync::{Mutex, MutexGuard};
static MUTATION: Mutex<()> = Mutex::new(());
pub fn mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    MUTATION
        .lock()
        .map_err(|_| "部署操作锁不可用，请重启管理器".into())
}
pub fn mutates_runtime(command: &str) -> bool {
    matches!(
        command,
        "save_raw_environment"
            | "save_raw_nginx_config"
            | "apply_ssl_config"
            | "reload_ssl_proxy"
            | "delete_ssl_certificate"
            | "install_nginx_image"
            | "set_nginx_provider"
            | "stop_ssl_proxy"
            | "save_configuration_command"
            | "start_services"
            | "stop_services"
            | "control_service"
            | "prepare_managed_database"
            | "prepare_managed_redis"
            | "start_managed_service"
            | "start_server_update"
            | "create_backup"
            | "restore_backup"
            | "delete_backup"
            | "import_backup"
            | "save_map_runtime_profile"
            | "delete_map_runtime_profile"
            | "destroy_project_runtime"
    )
}
