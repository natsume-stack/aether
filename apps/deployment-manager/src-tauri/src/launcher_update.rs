//! Download and stage a launcher before handing replacement to a detached helper.
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

static READY: Mutex<Option<PathBuf>> = Mutex::new(None);

fn checked(command: &mut Command) -> Result<(), String> {
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

fn installation() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    return exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
        .ok_or("请从已安装的启动器中更新".into());
    #[cfg(not(target_os = "macos"))]
    Ok(exe)
}

fn native_target() -> String {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    format!("{os}-{arch}")
}

fn find_payload(root: &Path, name: &std::ffi::OsStr) -> Result<PathBuf, String> {
    // Packages contain either the payload directly or one enclosing release folder.
    let direct = root.join(name);
    if direct.exists() {
        return Ok(direct);
    }
    let mut found = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            let candidate = entry.path().join(name);
            if candidate.exists() {
                found.push(candidate);
            }
        }
    }
    if found.len() == 1 {
        Ok(found.remove(0))
    } else {
        Err("更新包中未找到唯一的启动器".into())
    }
}

#[cfg(not(target_os = "windows"))]
fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn rotate_backups(target: &Path) -> Result<PathBuf, String> {
    let backup = target.with_file_name(".box-launcher-backup");
    let parent = target.parent().ok_or("启动器目录无效")?;
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let legacy = name
            .strip_prefix(".box-launcher-backup-")
            .is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()));
        if name != ".box-launcher-backup" && !legacy {
            continue;
        }
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(backup)
}

fn validate_archive(path: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("更新包损坏：{e}"))?;
    let mut size = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // ZIP writers on Windows may use backslashes for ordinary directory
        // separators. Validate both separator forms before platform extraction.
        let normalized = entry.name().replace('\\', "/");
        if entry.enclosed_name().is_none()
            || normalized.starts_with('/')
            || normalized.contains(':')
            || normalized.split('/').any(|part| {
                part == ".." || (part != "." && part.trim_end_matches([' ', '.']) != part)
            })
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("更新包包含不安全路径".into());
        }
        size = size.checked_add(entry.size()).ok_or("更新包过大")?;
        if size > 1024 * 1024 * 1024 {
            return Err("更新包解压大小超过限制".into());
        }
        // Reading each member verifies CRC before the platform extractor writes anything.
        std::io::copy(&mut entry, &mut std::io::sink())
            .map_err(|e| format!("更新包校验失败：{e}"))?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replacement_script(
    pid: u32,
    target: &Path,
    staged: &Path,
    backup: &Path,
    launch: &str,
) -> String {
    format!("#!/bin/sh\nwhile kill -0 {pid} 2>/dev/null; do sleep 1; done\nmv {} {} || exit 1\nif ! mv {} {}; then mv {} {}; {} ; exit 1; fi\n{}\n", quote(target), quote(backup), quote(staged), quote(target), quote(backup), quote(target), launch, launch)
}

#[cfg(target_os = "windows")]
fn ps_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

#[tauri::command]
pub async fn download_launcher_update(app: AppHandle, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || download(&app, &url))
        .await
        .map_err(|e| e.to_string())?
}

fn download(app: &AppHandle, url: &str) -> Result<(), String> {
    if !crate::updates::valid_download_url(url)
        || !url.ends_with(&format!("-{}.zip", native_target()))
    {
        return Err("安装包下载地址或平台无效".into());
    }
    let mut ready = READY.try_lock().map_err(|_| "正在处理启动器更新")?;
    if ready.is_some() {
        return Err("更新已下载，请重启并更新".into());
    }
    let target = installation()?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!(
            "launcher-update-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_millis()
        ));
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let result = (|| {
        let archive = cache.join("update.zip");
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(900))
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(url)
            .send()
            .map_err(|e| format!("无法下载更新：{e}"))?
            .error_for_status()
            .map_err(|e| format!("更新下载失败：{e}"))?;
        let total = response.content_length().unwrap_or(0);
        let mut file = fs::File::create(&archive).map_err(|e| e.to_string())?;
        let mut buffer = [0; 128 * 1024];
        let mut bytes = 0u64;
        let mut last = std::time::Instant::now();
        loop {
            let n = response
                .read(&mut buffer)
                .map_err(|e| format!("更新下载中断：{e}"))?;
            if n == 0 {
                break;
            }
            bytes += n as u64;
            if bytes > 512 * 1024 * 1024 {
                return Err("更新包大小超过限制".into());
            }
            file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            if last.elapsed() >= Duration::from_millis(100) {
                let _ = app.emit(
                    "launcher-update-progress",
                    serde_json::json!({ "bytes": bytes, "total": total }),
                );
                last = std::time::Instant::now();
            }
        }
        if bytes == 0 || (total != 0 && bytes != total) {
            return Err("更新包不完整，请重试".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        validate_archive(&archive)?;
        let unpacked = cache.join("unpacked");
        fs::create_dir(&unpacked).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        checked(
            Command::new("/usr/bin/ditto")
                .arg("-xk")
                .arg(&archive)
                .arg(&unpacked),
        )?;
        #[cfg(target_os = "windows")]
        checked(Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!("$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath {} -DestinationPath {}", ps_quote(&archive), ps_quote(&unpacked))))?;
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        checked(
            Command::new("unzip")
                .arg("-q")
                .arg(&archive)
                .arg("-d")
                .arg(&unpacked),
        )?;
        let payload_name = if cfg!(target_os = "macos") {
            "BOX3 Engine Launcher.app"
        } else if cfg!(target_os = "windows") {
            "box-local-engine-manager.exe"
        } else {
            "box-local-engine-manager"
        };
        let payload = find_payload(&unpacked, std::ffi::OsStr::new(payload_name))?;
        #[cfg(target_os = "macos")]
        checked(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&payload),
        )?;
        #[cfg(target_os = "macos")]
        if !payload
            .join("Contents/MacOS/box-local-engine-manager")
            .is_file()
        {
            return Err("更新包缺少启动程序".into());
        }
        #[cfg(not(target_os = "macos"))]
        if !payload.is_file() {
            return Err("更新包中的启动程序无效".into());
        }
        let staged = target.with_file_name(".box-launcher-update");
        if staged.exists() {
            if staged.is_dir() {
                fs::remove_dir_all(&staged).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(&staged).map_err(|e| e.to_string())?;
            }
        }
        #[cfg(target_os = "macos")]
        checked(Command::new("/usr/bin/ditto").arg(&payload).arg(&staged))?;
        #[cfg(not(target_os = "macos"))]
        fs::copy(&payload, &staged)
            .map_err(|e| format!("无法暂存更新，请确认启动器目录可写：{e}"))?;
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        let _ = app.emit(
            "launcher-update-progress",
            serde_json::json!({ "bytes": bytes, "total": bytes }),
        );
        *ready = Some(staged);
        Ok(())
    })();
    let _ = fs::remove_dir_all(cache);
    result
}

#[tauri::command]
pub async fn apply_launcher_update(app: AppHandle, cleanup_old_images: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || apply_update(app, cleanup_old_images))
        .await
        .map_err(|e| e.to_string())?
}

fn apply_update(app: AppHandle, cleanup_old_images: bool) -> Result<(), String> {
    let mut ready = READY.try_lock().map_err(|_| "正在处理启动器更新")?;
    let staged = ready.as_ref().ok_or("请先下载更新")?;
    let target = installation()?;
    if !staged.exists() {
        return Err("更新暂存状态无效，请重启后重试".into());
    }
    if cleanup_old_images {
        crate::commands::cleanup_images_before_launcher_restart(&app)
            .map_err(|e| format!("旧镜像清理失败，未重启启动器：{e}"))?;
    }
    // This choice is executed now, not deferred to the next launch.
    crate::commands::set_image_cleanup_choice(&app, false)?;
    // Rotate only launcher-owned backup names after a verified update is staged.
    let backup = rotate_backups(&target)?;
    let script_root = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "windows"))]
    {
        let script = script_root.join("apply-launcher-update.sh");
        let launch = if cfg!(target_os = "macos") {
            format!("/usr/bin/open {}", quote(&target))
        } else {
            format!("{} >/dev/null 2>&1 &", quote(&target))
        };
        let body = replacement_script(std::process::id(), &target, staged, &backup, &launch);
        fs::write(&script, body).map_err(|e| e.to_string())?;
        Command::new("/bin/sh")
            .arg(&script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let script = script_root.join("apply-launcher-update.ps1");
        let body = format!("$ErrorActionPreference='Stop'\nWait-Process -Id {} -ErrorAction SilentlyContinue\nMove-Item -LiteralPath {} -Destination {}\ntry {{ Move-Item -LiteralPath {} -Destination {} }} catch {{ Move-Item -LiteralPath {} -Destination {}; Start-Process -FilePath {}; exit 1 }}\nStart-Process -FilePath {}\n", std::process::id(), ps_quote(&target), ps_quote(&backup), ps_quote(staged), ps_quote(&target), ps_quote(&backup), ps_quote(&target), ps_quote(&target), ps_quote(&target));
        fs::write(&script, body).map_err(|e| e.to_string())?;
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .creation_flags(0x08000008)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    *ready = None;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_rotation_removes_only_owned_backups() {
        let root =
            std::env::temp_dir().join(format!("launcher-backup-test-{}", std::process::id()));
        fs::create_dir_all(root.join(".box-launcher-backup-123")).unwrap();
        fs::write(root.join(".box-launcher-backup"), b"old").unwrap();
        fs::write(root.join(".box-launcher-backup-not-ours"), b"keep").unwrap();
        fs::write(root.join("launcher"), b"current").unwrap();
        let backup = rotate_backups(&root.join("launcher")).unwrap();
        assert_eq!(backup, root.join(".box-launcher-backup"));
        assert!(!backup.exists());
        assert!(!root.join(".box-launcher-backup-123").exists());
        assert_eq!(fs::read(root.join("launcher")).unwrap(), b"current");
        assert!(root.join(".box-launcher-backup-not-ours").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn shell_paths_are_literal() {
        assert_eq!(
            quote(Path::new("/tmp/a'b $(touch bad)")),
            "'/tmp/a'\\''b $(touch bad)'"
        );
    }
    #[test]
    fn payload_requires_one_matching_launcher() {
        let root =
            std::env::temp_dir().join(format!("launcher-payload-test-{}", std::process::id()));
        fs::create_dir_all(root.join("release")).unwrap();
        fs::write(root.join("release/launcher"), b"test").unwrap();
        assert!(find_payload(&root, std::ffi::OsStr::new("launcher")).is_ok());
        fs::create_dir(root.join("other")).unwrap();
        fs::write(root.join("other/launcher"), b"test").unwrap();
        assert!(find_payload(&root, std::ffi::OsStr::new("launcher")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_rejects_traversal_and_broken_crc() {
        use zip::write::SimpleFileOptions;
        let root =
            std::env::temp_dir().join(format!("launcher-archive-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let archive = root.join("update.zip");
        for (name, accepted) in [
            ("release/launcher", true),
            ("release\\launcher.exe", true),
            ("release\\assets/config.json", true),
            ("release\\..\\launcher.exe", false),
            ("release/..\\launcher.exe", false),
            ("release\\.. \\launcher.exe", false),
            ("\\\\server\\share\\launcher.exe", false),
            ("\\launcher.exe", false),
            ("release/file:stream", false),
            ("../launcher", false),
            ("/tmp/launcher", false),
            ("C:\\launcher", false),
        ] {
            let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            writer
                .start_file(
                    name,
                    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(b"launcher-test-bytes").unwrap();
            writer.finish().unwrap();
            assert_eq!(validate_archive(&archive).is_ok(), accepted);
        }
        fs::write(&archive, b"not a zip").unwrap();
        assert!(validate_archive(&archive).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn helper_replaces_launcher_and_rolls_back_when_staged_file_disappears() {
        let root =
            std::env::temp_dir().join(format!("launcher-swap-test-{} ' space", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("launcher");
        let staged = root.join("new");
        let backup = root.join("backup");
        let marker = root.join("restarted");
        let launch = format!("touch {}", quote(&marker));
        let script = replacement_script(2_000_000_000, &target, &staged, &backup, &launch);
        fs::write(&target, b"old").unwrap();
        fs::write(&staged, b"new").unwrap();
        assert!(Command::new("/bin/sh")
            .args(["-c", &script])
            .status()
            .unwrap()
            .success());
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(&backup).unwrap(), b"old");
        assert!(marker.exists());
        fs::remove_file(&backup).unwrap();
        fs::remove_file(&marker).unwrap();
        assert!(!Command::new("/bin/sh")
            .args(["-c", &script])
            .status()
            .unwrap()
            .success());
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(marker.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
