//! Stream Docker CLI pull output and report a monotonic layer download estimate.
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    process::{Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

fn parse_bytes(value: &str) -> Option<u64> {
    let split = value.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let amount = value[..split].parse::<f64>().ok()?;
    let multiplier = match value[split..].trim().to_ascii_lowercase().as_str() {
        "b" => 1.0,
        "kb" | "kib" => 1024.0,
        "mb" | "mib" => 1_048_576.0,
        "gb" | "gib" => 1_073_741_824.0,
        _ => return None,
    };
    Some((amount * multiplier) as u64)
}

#[derive(Default)]
struct PullProgress {
    layers: BTreeMap<String, (u64, u64)>,
    percent: u8,
}

impl PullProgress {
    fn update(&mut self, line: &str, label: &str) -> Option<(u8, String)> {
        let (layer, status) = line.split_once(": ")?;
        if layer.trim().is_empty() {
            return None;
        }
        let entry = self.layers.entry(layer.trim().to_owned()).or_default();
        if status.contains("Pull complete") || status.contains("Already exists") {
            if entry.1 > 0 {
                entry.0 = entry.1;
            }
        } else if !status.contains("Pulling fs layer") {
            let (_, sizes) = status
                .split_once("Downloading ")
                .or_else(|| status.split_once("Extracting "))?;
            let (current, total) = sizes.split_once('/')?;
            let (current, total) = (parse_bytes(current.trim())?, parse_bytes(total.trim())?);
            entry.0 = current.min(total);
            entry.1 = total;
        }
        let (current, total) = self.layers.values().fold((0u64, 0u64), |sum, layer| {
            (sum.0.saturating_add(layer.0), sum.1.saturating_add(layer.1))
        });
        let estimate = if total > 0 {
            (5 + current.saturating_mul(90) / total).min(95) as u8
        } else {
            1
        };
        self.percent = self.percent.max(estimate);
        Some((
            self.percent,
            format!("正在下载 {label} 镜像，可能需要几分钟，请耐心等待…"),
        ))
    }
}

/// Runs a Docker CLI pull while draining both streams and reporting layer progress.
pub fn run(
    mut command: Command,
    label: &str,
    mut report: impl FnMut(u8, String),
) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Docker 镜像下载：{error}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 Docker 下载输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 Docker 下载错误")?;
    let (sender, receiver) = mpsc::channel();
    let out_sender = sender.clone();
    let out_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if out_sender.send((false, line)).is_err() {
                break;
            }
        }
    });
    let err_reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if sender.send((true, line)).is_err() {
                break;
            }
        }
    });
    let mut progress = PullProgress::default();
    let mut output = Vec::new();
    let mut error = Vec::new();
    let mut readers = 2;
    let mut status = None;
    report(
        1,
        format!("正在连接镜像源并下载 {label} 镜像，可能需要几分钟，请耐心等待…"),
    );
    while readers > 0 || status.is_none() {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok((is_error, line)) => {
                let target = if is_error { &mut error } else { &mut output };
                target.extend_from_slice(line.as_bytes());
                target.push(b'\n');
                if let Some((percent, message)) = progress.update(&line, label) {
                    report(percent, message);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => readers = 0,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(found) => status = found,
                Err(problem) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("等待 Docker 镜像下载失败：{problem}"));
                }
            }
        }
    }
    let status = match status {
        Some(status) => status,
        None => child
            .wait()
            .map_err(|problem| format!("等待 Docker 镜像下载失败：{problem}"))?,
    };
    out_reader
        .join()
        .map_err(|_| "读取 Docker 下载输出异常结束")?;
    err_reader
        .join()
        .map_err(|_| "读取 Docker 下载错误异常结束")?;
    let result = Output {
        status,
        stdout: output,
        stderr: error,
    };
    if !result.status.success() {
        let message = if result.stderr.is_empty() {
            &result.stdout
        } else {
            &result.stderr
        };
        return Err(String::from_utf8_lossy(message).trim().to_string());
    }
    report(100, format!("{label} 镜像下载完成"));
    Ok(result)
}
