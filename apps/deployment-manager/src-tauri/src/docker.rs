//! Docker command adapter used by the deployment manager.
//!
//! Commands elsewhere never need to know executable discovery rules, Windows
//! process flags, or how command failures are rendered.

use std::{
    io::Read,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

// Read-only probes must finish even when Docker Desktop is unresponsive.
pub(crate) fn run_probe(mut command: Command, timeout: Duration) -> Result<Output, String> {
    hide_window(&mut command);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let mut stdout = child.stdout.take().ok_or("无法读取命令输出")?;
    let mut stderr = child.stderr.take().ok_or("无法读取命令错误")?;
    let out = std::thread::spawn(move || { let mut bytes = Vec::new(); stdout.read_to_end(&mut bytes).map(|_| bytes) });
    let err = std::thread::spawn(move || { let mut bytes = Vec::new(); stderr.read_to_end(&mut bytes).map(|_| bytes) });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => error.to_string(),
                    _ => "Docker 状态查询超时，请检查 Docker Desktop 后重新检测。".into(),
                });
            }
        }
    };
    let stdout = out.join().map_err(|_| "读取命令输出失败")?.map_err(|error| error.to_string())?;
    let stderr = err.join().map_err(|_| "读取命令错误失败")?.map_err(|error| error.to_string())?;
    if !status.success() {
        let message = if stderr.is_empty() { &stdout } else { &stderr };
        return Err(String::from_utf8_lossy(message).trim().to_string());
    }
    Ok(Output { status, stdout, stderr })
}

#[cfg(target_os = "windows")]
pub(crate) fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn hide_window(_command: &mut Command) {}

pub(crate) fn run_command(mut command: Command) -> Result<Output, String> {
    hide_window(&mut command);
    let rendered = format!("{command:?}");
    let output = command
        .output()
        .map_err(|error| format!("无法执行 {rendered}：{error}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn command_with_tool_path(executable: impl AsRef<OsStr>) -> Command {
    let executable = executable.as_ref();
    let mut command = Command::new(executable);
    let mut paths = Vec::<PathBuf>::new();
    if let Some(parent) = Path::new(executable)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        paths.push(parent.to_path_buf());
    }
    #[cfg(target_os = "macos")]
    paths.extend([
        PathBuf::from("/Applications/Docker.app/Contents/Resources/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    paths.dedup();
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
    command
}

pub(crate) fn command() -> Command {
    if let Some(configured) = std::env::var_os("BOX_DOCKER_CLI") {
        if !configured.is_empty() {
            return command_with_tool_path(configured);
        }
    }
    #[cfg(target_os = "macos")]
    let candidates = [
        "/Applications/Docker.app/Contents/Resources/bin/docker",
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
    ];
    #[cfg(target_os = "windows")]
    let candidates = [
        r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        r"C:\Program Files\Docker\Docker\resources\docker.exe",
    ];
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let candidates = [
        "/usr/bin/docker",
        "/usr/local/bin/docker",
        "/snap/bin/docker",
    ];
    if let Some(path) = candidates.iter().find(|path| Path::new(path).is_file()) {
        return command_with_tool_path(path);
    }
    command_with_tool_path("docker")
}

pub(crate) fn output(args: &[&str]) -> Result<String, String> {
    let mut command = command();
    command.args(args);
    let read_only = matches!(args.first(), Some(&"--version" | &"info" | &"ps" | &"inspect" | &"stats"))
        || matches!(args, ["image", "inspect", ..] | ["desktop", "version", ..]);
    let output = if read_only {
        run_probe(command, Duration::from_secs(15))?
    } else {
        run_command(command)?
    };
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn pull_image(
    image: &str,
    label: &str,
    progress: impl FnMut(u8, String),
) -> Result<(), String> {
    let mut command = command();
    command.args(["pull", image]);
    hide_window(&mut command);
    box_manager_core::docker_pull::run(command, label, progress).map(|_| ())
}

pub(crate) fn unavailable_message(error: String) -> String {
    let normalized = error.to_lowercase();
    if normalized.contains("cannot connect")
        || normalized.contains("docker daemon")
        || normalized.contains("dockerdesktoplinuxengine")
        || normalized.contains("_ping")
        || normalized.contains("is the docker daemon running")
    {
        "Docker CLI 已安装，但 Docker Desktop 尚未启动或仍在初始化。请启动 Docker Desktop，等待状态变为 Running 后重新检测。".into()
    } else if normalized.contains("no such file")
        || normalized.contains("not found")
        || normalized.contains("找不到")
    {
        "未找到 Docker CLI。请安装 Docker Desktop 后重新检测。".into()
    } else {
        format!("Docker 不可用：{error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn stalled_probe_times_out() {
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 5"]);
        let started = Instant::now();
        assert!(run_probe(command, Duration::from_millis(100)).unwrap_err().contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn probe_drains_output_and_reports_errors() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf ready"]);
        assert_eq!(run_probe(command, Duration::from_secs(2)).unwrap().stdout, b"ready");
        let mut command = Command::new("sh");
        command.args(["-c", "printf failure >&2; exit 1"]);
        assert_eq!(run_probe(command, Duration::from_secs(2)).unwrap_err(), "failure");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn docker_desktop_command_can_resolve_its_credential_helper() {
        let command = command();
        let path = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .expect("Docker command must set an explicit PATH inside the desktop app");
        assert!(path
            .to_string_lossy()
            .split(':')
            .any(|entry| entry == "/Applications/Docker.app/Contents/Resources/bin"));
    }
}
