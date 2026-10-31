use std::process::Command;

pub(crate) fn valid_download_url(url: &str) -> bool {
    box_manager_core::release_channel::valid_installer_url(
        url,
        option_env!("BOX_ROOT_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
    )
}

#[tauri::command]
pub fn open_release_download(url: String) -> Result<(), String> {
    if !valid_download_url(&url) {
        return Err("安装包下载地址无效".into());
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", &url]);
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开安装包下载地址：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_urls_are_limited_to_the_compiled_channel() {
        let current = option_env!("BOX_ROOT_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
        let suffix = if box_manager_core::release_channel::is_staging(current) { "-staging" } else { "" };
        assert_eq!(valid_download_url(&format!("{}/BOX-Local-Engine-0.4.0{suffix}-macos-arm64.zip", box_manager_core::release_channel::release_base(current))), !box_manager_core::release_channel::is_dev(current));
        for url in [
            "https://evil.test/BOX-Local-Engine-0.4.0-macos-arm64.zip",
            "https://assets.box3.fun/local-engine/BOX-Local-Engine-0.4.0-macos-arm64.zip?next=evil",
            "https://assets.box3.fun/local-engine/BOX-Local-Engine-../0.4.0-macos-arm64.zip",
            "https://assets.box3.fun/local-engine/BOX-Local-Engine-0.4.0-beta-macos-arm64.zip",
        ] {
            assert!(!valid_download_url(url));
        }
    }
}
