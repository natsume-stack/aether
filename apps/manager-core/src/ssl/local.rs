//! Local system Nginx integration. Only an include and this instance's fragment are managed.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
const MARKER: &str = "# BOX3 managed local HTTPS\n";
type Runner<'a> = dyn FnMut(&Path, &[String]) -> Result<String, String> + 'a;

fn run(binary: &Path, args: &[String]) -> Result<String, String> {
    let output = Command::new(binary)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Installation {
    executable_path: PathBuf,
    version: String,
    config_path: PathBuf,
    config_error: String,
}

fn candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(value) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&value) {
            paths.push(directory.join(if cfg!(windows) { "nginx.exe" } else { "nginx" }));
        }
    }
    paths.extend(
        [
            "/opt/homebrew/bin/nginx",
            "/opt/homebrew/sbin/nginx",
            "/usr/local/bin/nginx",
            "/usr/local/sbin/nginx",
            "/usr/sbin/nginx",
        ]
        .map(PathBuf::from),
    );
    paths
}

fn discover() -> Result<Option<(PathBuf, PathBuf)>, String> {
    discover_candidates(candidates())
}

fn discover_candidates(candidates: Vec<PathBuf>) -> Result<Option<(PathBuf, PathBuf)>, String> {
    inspect_candidates(candidates)?
        .map(|info| {
            if !info.config_error.is_empty() {
                return Err(info.config_error);
            }
            Ok((info.executable_path, info.config_path))
        })
        .transpose()
}

fn inspect_candidates(candidates: Vec<PathBuf>) -> Result<Option<Installation>, String> {
    for binary in candidates {
        let output = match Command::new(&binary).arg("-V").output() {
            Ok(output) => output,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !binary.exists() => {
                continue
            }
            Err(error) => return Err(format!("无法运行本机 Nginx {}：{error}", binary.display())),
        };
        if !output.status.success() {
            return Err(format!(
                "无法读取本机 Nginx 版本：{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let details = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return installation(&binary, &details).map(Some);
    }
    Ok(None)
}

fn installation(binary: &Path, details: &str) -> Result<Installation, String> {
    let version = details
        .split_whitespace()
        .find_map(|part| part.strip_prefix("nginx/"))
        .ok_or("无法识别本机 Nginx 版本号")?
        .to_owned();
    let value = |key: &str| {
        details
            .split_whitespace()
            .find_map(|part| part.strip_prefix(key))
    };
    let path = PathBuf::from(value("--conf-path=").unwrap_or("conf/nginx.conf"));
    let path = if path.is_absolute() {
        path
    } else {
        Path::new(value("--prefix=").unwrap_or("/usr/local/nginx")).join(path)
    };
    let (config_path, config_error) = match fs::canonicalize(&path) {
        Ok(path) => (path, String::new()),
        Err(error) => (path, format!("无法读取本机 Nginx 主配置：{error}")),
    };
    Ok(Installation {
        executable_path: fs::canonicalize(binary)
            .map_err(|error| format!("无法读取 Nginx 可执行文件路径：{error}"))?,
        version,
        config_path,
        config_error,
    })
}

pub(super) fn status() -> serde_json::Value {
    match inspect_candidates(candidates()) {
        Ok(Some(info)) => {
            serde_json::json!({"installed":true,"version":info.version,"executablePath":info.executable_path,"configPath":info.config_path,"error":info.config_error})
        }
        Ok(None) => serde_json::json!({"installed":false,"error":""}),
        Err(error) => serde_json::json!({"installed":null,"error":error}),
    }
}

pub(super) fn available() -> Result<bool,String> { discover().map(|value|value.is_some()) }

pub(super) fn quote(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("Nginx 路径不是有效 UTF-8")?;
    if value.contains(['\n', '\r', '\0', '$']) {
        return Err("Nginx 配置路径包含不支持的字符".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "/").replace('"', "\\\"")
    ))
}

pub(super) fn configuration(
    fragment: &str,
    host_root: &Path,
    owner: &str,
) -> Result<String, String> {
    let mut local = String::new();
    for line in fragment.lines() {
        if line.trim_start().starts_with("resolver ") {
            continue;
        }
        if let Some((directive, path)) = line.trim().split_once(' ') {
            if matches!(directive, "ssl_certificate" | "ssl_certificate_key") {
                let relative = path
                    .trim_end_matches(';')
                    .strip_prefix("/etc/box-https/")
                    .ok_or("证书路径无效")?;
                local.push_str(&format!(
                    " {directive} {};\n",
                    quote(&host_root.join("https").join(relative))?
                ));
                continue;
            }
        }
        local.push_str(line);
        local.push('\n');
    }
    Ok(local.replace(
        "$box_ssl_connection",
        &format!("$box_ssl_connection_{owner}"),
    ))
}

// Preserve comments and quoted braces; locate only the main top-level http block.
fn include(source: &str, fragment: &Path) -> Result<String, String> {
    let directive = format!("include {};", quote(fragment)?);
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if bytes[i] == b'#' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        let start = i;
        if matches!(bytes[i], b'\'' | b'"') {
            let delimiter = bytes[i];
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if bytes[i] == delimiter {
                    i += 1;
                    break;
                }
                i += 1;
            }
        } else if matches!(bytes[i], b'{' | b'}' | b';') {
            i += 1;
        } else {
            while i < bytes.len()
                && !bytes[i].is_ascii_whitespace()
                && !matches!(bytes[i], b'{' | b'}' | b';' | b'#')
            {
                i += 1;
            }
        }
        if i > bytes.len() {
            return Err("Nginx 主配置引号无效".into());
        }
        tokens.push((&source[start..i], start));
    }
    let mut depth = 0usize;
    let mut http = None;
    for (index, &(token, offset)) in tokens.iter().enumerate() {
        if token == "{" {
            if depth == 0 && index > 0 && tokens[index - 1].0 == "http" {
                if http.is_some() {
                    return Err("Nginx 主配置包含多个 http 块".into());
                }
                http = Some((offset + 1, index));
            }
            depth += 1;
        } else if token == "}" {
            depth = depth.checked_sub(1).ok_or("Nginx 主配置括号无效")?;
        }
    }
    if depth != 0 {
        return Err("Nginx 主配置括号无效".into());
    }
    let (offset, start) = http.ok_or("未找到主配置的 http 块，无法自动接入本机 Nginx")?;
    let expected = quote(fragment)?;
    let mut nesting = 1;
    for window in tokens[start + 1..].windows(3) {
        match window[0].0 {
            "{" => nesting += 1,
            "}" => nesting -= 1,
            _ => {}
        }
        if nesting == 0 {
            break;
        }
        if nesting == 1 && window[0].0 == "include" && window[1].0 == expected && window[2].0 == ";"
        {
            return Ok(source.into());
        }
    }
    Ok(format!(
        "{}\n    {directive}\n{}",
        &source[..offset],
        &source[offset..]
    ))
}

fn write(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let temporary = path.with_extension(format!("box-pending-{}", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|e| format!("无法写入本机 Nginx 配置 {}：{e}", path.display()))?;
    let result = (|| {
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        if let Ok(metadata) = fs::metadata(path) {
            fs::set_permissions(&temporary, metadata.permissions()).map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        #[cfg(windows)]
        if path.exists() {
            let backup = path.with_extension(format!("box-previous-{}", std::process::id()));
            if backup.exists() {
                return Err("发现上次 Nginx 写入备份，请先检查配置文件".into());
            }
            fs::rename(path, &backup).map_err(|e| e.to_string())?;
            if let Err(error) = fs::rename(&temporary, path) {
                fs::rename(&backup, path)
                    .map_err(|restore| format!("{error}；恢复配置失败：{restore}"))?;
                return Err(error.to_string());
            }
            let _ = fs::remove_file(backup);
            return Ok(());
        }
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) struct Transaction {
    binary: PathBuf,
    main: PathBuf,
    fragment: PathBuf,
    old_main: String,
    old_fragment: Option<String>,
    main_changed: bool,
    fragment_changed: bool,
    reloaded: bool,
}
impl Transaction {
    fn command(&self, runner: &mut Runner<'_>, reload: bool) -> Result<(), String> {
        let mut args = vec!["-c".into(), self.main.to_string_lossy().into_owned()];
        if reload {
            args.extend(["-s".into(), "reload".into()]);
        } else {
            args.push("-t".into());
        }
        runner(&self.binary, &args).map(|_| ())
    }
    fn rollback_with(&self, runner: &mut Runner<'_>) -> Result<(), String> {
        if self.fragment_changed {
            if let Some(old) = &self.old_fragment {
                write(&self.fragment, old)?;
            } else {
                fs::remove_file(&self.fragment).map_err(|e| e.to_string())?;
            }
        }
        if self.main_changed {
            write(&self.main, &self.old_main)?;
        }
        self.command(runner, false)?;
        if self.reloaded {
            self.command(runner, true)?;
        }
        Ok(())
    }
    pub(super) fn rollback(&self) -> Result<(), String> {
        self.rollback_with(&mut run)
    }
}

pub(super) fn deploy(root: &Path, fragment: &str) -> Result<Option<Transaction>, String> {
    let Some((binary, main)) = discover()? else {
        return Ok(None);
    };
    deploy_with(root, fragment, binary, main, &mut run).map(Some)
}
fn deploy_with(
    root: &Path,
    fragment: &str,
    binary: PathBuf,
    main: PathBuf,
    runner: &mut Runner<'_>,
) -> Result<Transaction, String> {
    let path = root.join("https/local-nginx.conf");
    let old_fragment = if path.exists() {
        Some(fs::read_to_string(&path).map_err(|e| e.to_string())?)
    } else {
        None
    };
    if old_fragment
        .as_ref()
        .is_some_and(|text| !text.starts_with(MARKER))
    {
        return Err("本机 Nginx 接入文件已被其他程序使用，未覆盖".into());
    }
    let old_main = fs::read_to_string(&main).map_err(|e| e.to_string())?;
    let updated = include(&old_main, &path)?;
    let mut transaction = Transaction {
        binary,
        main,
        fragment: path,
        old_main,
        old_fragment,
        main_changed: false,
        fragment_changed: false,
        reloaded: false,
    };
    // Validate the existing installation before touching either file.
    transaction
        .command(runner, false)
        .map_err(|e| format!("本机 Nginx 原配置校验失败：{e}"))?;
    let result = (|| {
        write(&transaction.fragment, &format!("{MARKER}{fragment}"))?;
        transaction.fragment_changed = true;
        if updated != transaction.old_main {
            write(&transaction.main, &updated)?;
            transaction.main_changed = true;
        }
        transaction.command(runner, false)?;
        // A reload can be delivered even when the command reports an error.
        transaction.reloaded = true;
        transaction.command(runner, true)
    })();
    if let Err(error) = result {
        let rollback = transaction.rollback_with(runner);
        return Err(format!(
            "本机 Nginx 更新失败：{error}；{}",
            if rollback.is_ok() {
                "原配置已恢复".into()
            } else {
                format!("回退失败，请检查本机 Nginx：{}", rollback.unwrap_err())
            }
        ));
    }
    Ok(transaction)
}

#[cfg(test)]
mod tests;
