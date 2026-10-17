use super::docker::hide_window;
use std::process::Command;

/// Open the project's fixed public repository in the system browser.
#[tauri::command]
pub fn open_project_repository() -> Result<(), String> {
    let url = "https://github.com/box3lab/box3-local-engine";
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    hide_window(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开项目仓库：{error}"))
}
