//! Preserve upstream service snapshots and restore them after failed routing changes.
use super::{plan::routing_settings, Settings};
use std::{collections::BTreeMap, fs, path::Path};

pub struct UpstreamTransition {
    root: std::path::PathBuf,
    project: String,
    targets: std::collections::BTreeSet<String>,
    snapshots: Option<BTreeMap<String, serde_json::Value>>,
}
impl UpstreamTransition {
    pub fn new(root: &Path, project: &str, desired: &Settings) -> Result<Self, String> {
        let mut targets: std::collections::BTreeSet<String> =
            desired.routes.iter().map(|r| r.service.clone()).collect();
        if let Some(previous) = routing_settings(root)? {
            targets.extend(previous.routes.into_iter().map(|r| r.service));
        }
        Ok(Self {
            root: root.into(),
            project: project.into(),
            targets,
            snapshots: None,
        })
    }
    pub fn apply(
        &mut self,
        docker: &mut dyn FnMut(&[String]) -> Result<String, String>,
        compose: &mut dyn FnMut(&[String]) -> Result<String, String>,
    ) -> Result<(), String> {
        let mut snapshots = BTreeMap::new();
        for service in &self.targets {
            let args = vec![
                "container".into(),
                "ls".into(),
                "--filter".into(),
                format!("label=com.docker.compose.project={}", self.project),
                "--filter".into(),
                format!("label=com.docker.compose.service={service}"),
                "--format".into(),
                "{{.ID}}".into(),
            ];
            let ids = docker(&args)?;
            if let Some(id) = ids.lines().next().filter(|value| !value.is_empty()) {
                let data: serde_json::Value =
                    serde_json::from_str(&docker(&["inspect".into(), id.into()])?)
                        .map_err(|_| "无法读取旧服务状态")?;
                snapshots.insert(service.clone(), data[0].clone());
            }
        }
        if snapshots.is_empty() {
            return Ok(());
        }
        // Resolve the same Compose configuration that will recreate these
        // containers. Check every image before Compose can stop any service.
        let configuration = compose(&["config".into(), "--format".into(), "json".into()])?;
        let configuration: serde_json::Value =
            serde_json::from_str(&configuration).map_err(|_| "无法读取服务镜像配置，未重建服务")?;
        for service in snapshots.keys() {
            let image = configuration["services"][service]["image"]
                .as_str()
                .filter(|image| !image.is_empty())
                .ok_or_else(|| format!("{service} 缺少镜像配置，未重建服务"))?;
            docker(&["image".into(), "inspect".into(), image.into()])
                .map_err(|error| format!(
                    "无法使用 {service} 的镜像 {image}：{error}。未重建服务，请先导入或下载匹配版本的镜像。"
                ))?;
        }
        let mut args = vec![
            "up".into(),
            "-d".into(),
            "--no-deps".into(),
            "--no-build".into(),
            "--pull".into(),
            "never".into(),
            "--force-recreate".into(),
        ];
        args.extend(snapshots.keys().cloned());
        self.snapshots = Some(snapshots);
        compose(&args).map(|_| ())
    }
    pub fn rollback(
        &mut self,
        source: &str,
        compose_file: &mut dyn FnMut(&Path, &[String]) -> Result<String, String>,
    ) -> Result<(), String> {
        let Some(snapshots) = &self.snapshots else {
            return Ok(());
        };
        if snapshots.is_empty() {
            return Ok(());
        }
        let mut result = String::new();
        let mut service = "";
        let mut skipping = false;
        let quote = |value: &str| serde_json::to_string(&value.replace('$', "$$")).unwrap();
        for line in source.lines() {
            let indent = line.bytes().take_while(|byte| *byte == b' ').count();
            if indent == 2 && line.trim_end().ends_with(':') {
                service = line.trim().trim_end_matches(':');
            }
            if skipping {
                if indent > 4 || line.trim().is_empty() {
                    continue;
                }
                skipping = false;
            }
            if let Some(snapshot) = snapshots.get(service) {
                if indent == 4 && line.trim().starts_with("image:") {
                    result.push_str(&format!(
                        "    image: {}\n",
                        quote(snapshot["Image"].as_str().ok_or("旧镜像标识缺失")?)
                    ));
                    continue;
                }
                if indent == 4 && line.trim() == "environment:" {
                    result.push_str("    environment:\n");
                    if let Some(values) = snapshot["Config"]["Env"].as_array() {
                        for value in values {
                            if let Some((key, value)) =
                                value.as_str().and_then(|value| value.split_once('='))
                            {
                                result.push_str(&format!("      {key}: {}\n", quote(value)));
                            }
                        }
                    }
                    skipping = true;
                    continue;
                }
                if indent == 4 && line.trim() == "ports:" {
                    if let Some(ports) = snapshot["HostConfig"]["PortBindings"]
                        .as_object()
                        .filter(|map| !map.is_empty())
                    {
                        result.push_str("    ports:\n");
                        for (container, bindings) in ports {
                            if let Some(bindings) = bindings.as_array() {
                                for binding in bindings {
                                    let address = binding["HostIp"].as_str().unwrap_or("127.0.0.1");
                                    let address = if address.contains(':') {
                                        format!("[{address}]")
                                    } else {
                                        address.into()
                                    };
                                    let port =
                                        binding["HostPort"].as_str().ok_or("旧端口标识缺失")?;
                                    result.push_str(&format!(
                                        "      - {}\n",
                                        quote(&format!("{address}:{port}:{container}"))
                                    ));
                                }
                            }
                        }
                    }
                    skipping = true;
                    continue;
                }
            }
            result.push_str(line);
            result.push('\n');
        }
        let file = self
            .root
            .join("https")
            .join(format!("routing.restore-{}.yml", std::process::id()));
        if file.exists() {
            fs::remove_file(&file).map_err(|error| error.to_string())?;
        }
        super::runtime::private(&file, &result)?;
        let mut args = vec![
            "up".into(),
            "-d".into(),
            "--no-deps".into(),
            "--no-build".into(),
            "--pull".into(),
            "never".into(),
            "--force-recreate".into(),
        ];
        args.extend(snapshots.keys().cloned());
        let restored = compose_file(&file, &args).map(|_| ());
        let _ = fs::remove_file(file);
        restored
    }
}
