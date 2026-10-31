use super::{docker_output, env_path, runtime_root};
use box_manager_core::ssl;
use serde_json::Value;
use tauri::AppHandle;

fn docker(args: &[String]) -> Result<String, String> {
    docker_output(&args.iter().map(String::as_str).collect::<Vec<_>>())
}
#[tauri::command]
pub async fn delete_ssl_certificate(app: AppHandle, service: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = box_manager_core::operation::mutation_guard()?;
        let root = runtime_root(&app)?;
        let environment = std::fs::read_to_string(env_path(&app)?).map_err(|error| error.to_string())?;
        ssl::delete_certificate(&root, &root, "box-local-engine-desktop_default", &environment, &service, &mut docker)
    }).await.map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn get_ssl_status(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || ssl::status(&runtime_root(&app)?, &mut docker))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn apply_ssl_config(app: AppHandle, config: ssl::Import) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = box_manager_core::operation::mutation_guard()?;
        let root = runtime_root(&app)?;
        let environment = std::fs::read_to_string(env_path(&app)?).map_err(|e| e.to_string())?;
        let runtime=super::generate_runtime_environment(&app)?;
        ssl::validate_path_images(&config.settings,&runtime,&mut docker)?;
        let source=std::fs::read_to_string(super::compose_path(&app)?).map_err(|error|error.to_string())?;
        let mut transition=ssl::UpstreamTransition::new(&root,"box-local-engine-desktop",&config.settings)?;
        ssl::apply_with_transition_progress(&root,&root,"box-local-engine-desktop_default",&environment,config,&mut docker,&mut |image, progress| super::docker::pull_image(image, "Nginx", progress),&mut |percent, message| super::emit_progress(&app, "dependency-image-download", &message, percent),&mut |rollback| {
            if rollback {transition.rollback(&source,&mut |file,args|super::compose_file_output(&app,file,args))}
            else {transition.apply(&mut docker,&mut |args|super::compose_output(&app,&args.iter().map(String::as_str).collect::<Vec<_>>()))}
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn stop_ssl_proxy(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = box_manager_core::operation::mutation_guard()?;
        ssl::stop(&runtime_root(&app)?, &mut docker)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn verify_ssl_endpoint(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssl::verify_endpoint(&runtime_root(&app)?, &mut docker)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_ssl_configuration(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = ssl::status(&runtime_root(&app)?, &mut docker)?;
        let content = value["config"]["externalConfig"]
            .as_str()
            .ok_or("请先导入并校验证书")?;
        let Some(path) = choose_export()? else {
            return Ok(None);
        };
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn choose_export() -> Result<Option<std::path::PathBuf>, String> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("/usr/bin/osascript");
        c.args(["-e", "POSIX path of (choose file name with prompt \"导出 Nginx 配置\" default name \"box-engine-https.conf\")"]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.SaveFileDialog; $d.Filter='Nginx configuration (*.conf)|*.conf'; $d.FileName='box-engine-https.conf'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Output $d.FileName}"]);
        c
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut c = Command::new("zenity");
        c.args([
            "--file-selection",
            "--save",
            "--confirm-overwrite",
            "--filename=box-engine-https.conf",
        ]);
        c
    };
    super::hide_window(&mut command);
    super::dialog_result(command)
}

#[tauri::command]
pub async fn install_nginx_image(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = box_manager_core::operation::mutation_guard()?;
        ssl::install_image_with_progress(
            &mut docker,
            &mut |image, progress| super::docker::pull_image(image, "Nginx", progress),
            &mut |percent, message| super::emit_progress(&app, "dependency-image-download", &message, percent),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn set_nginx_provider(app: AppHandle, mode: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = box_manager_core::operation::mutation_guard()?;
        let root = runtime_root(&app)?;
        if ssl::status(&root, &mut docker)?["running"] == true {
            return Err("请先停止托管 Nginx 入口".into());
        }
        ssl::set_provider(&root, &mode)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reload_ssl_proxy(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = box_manager_core::operation::mutation_guard()?;
        let root = runtime_root(&app)?;
        let environment = std::fs::read_to_string(env_path(&app)?).map_err(|error| error.to_string())?;
        ssl::reload(&root, &root, "box-local-engine-desktop_default", &environment, &mut docker)
    }).await.map_err(|error| error.to_string())?
}
