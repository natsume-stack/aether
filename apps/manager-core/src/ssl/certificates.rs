//! Saved certificate material and removal lifecycle.
use super::runtime::{apply_with_transition, saved, status};
use super::*;
use serde_json::Value;
use std::{fs, path::Path};
type Docker<'a> = dyn FnMut(&[String]) -> Result<String, String> + 'a;

pub(super) fn material(root: &Path, old: &Saved, service: &str) -> Result<Certificate, String> {
    let directory = root.join("https/revisions").join(&old.revision);
    let independent = directory.join(format!("{service}-cert.pem")).exists();
    Ok(Certificate {
        source: old
            .certificate_sources
            .get(service)
            .cloned()
            .unwrap_or_else(|| {
                if independent {
                    "independent".into()
                } else {
                    "shared".into()
                }
            }),
        certificate: fs::read_to_string(directory.join(if independent {
            format!("{service}-cert.pem")
        } else {
            "cert.pem".into()
        }))
        .map_err(|_| format!("{service} 缺少已保存的证书"))?,
        private_key: fs::read_to_string(directory.join(if independent {
            format!("{service}-key.pem")
        } else {
            "key.pem".into()
        }))
        .map_err(|_| format!("{service} 缺少已保存的私钥"))?,
    })
}
pub fn delete_certificate(
    root: &Path,
    host_root: &Path,
    network: &str,
    environment: &str,
    service: &str,
    docker: &mut Docker<'_>,
) -> Result<Value, String> {
    if service != "shared" && !SERVICES.iter().any(|entry| entry.0 == service) {
        return Err("证书服务无效".into());
    }
    let mut config = saved(root)?.ok_or("没有已保存的 SSL 证书")?;
    let metadata: Value = serde_json::from_str(
        &fs::read_to_string(root.join("https/settings.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if metadata.get("externalLocal").is_none() && config.settings.mode == "external" {
        config.external_local = fs::read_to_string(root.join("https/local-nginx.conf"))
            .is_ok_and(|fragment| fragment.starts_with("# BOX3 managed local HTTPS\n"));
    }
    let targets: Vec<String> = if service == "shared" {
        SERVICES
            .iter()
            .filter(|entry| {
                config
                    .certificate_sources
                    .get(entry.0)
                    .is_some_and(|source| source == "shared")
                    || (config.certificate_sources.is_empty()
                        && config
                            .settings
                            .routes
                            .iter()
                            .any(|route| route.service == entry.0 && route.secure))
            })
            .map(|entry| entry.0.to_string())
            .collect()
    } else {
        vec![service.into()]
    };
    if targets.is_empty()
        || !targets.iter().any(|service| {
            config.certificate_sources.contains_key(service)
                || config
                    .settings
                    .routes
                    .iter()
                    .any(|route| route.service == *service && route.secure)
        })
    {
        return Err("没有对应的已保存 SSL 证书".into());
    }
    config
        .settings
        .routes
        .retain(|route| !route.secure || !targets.contains(&route.service));
    let result = apply_with_transition(
        root,
        host_root,
        network,
        environment,
        Import {
            settings: config.settings,
            external_local: config.external_local,
            certificate: String::new(),
            private_key: String::new(),
            certificates: Default::default(),
            certificate_paths: Default::default(),
            delete_services: targets.clone(),
        },
        docker,
        &mut |_| Ok(()),
    )?;
    if result["config"]["settings"]["routes"]
        .as_array()
        .is_some_and(|routes| routes.is_empty())
        && result["config"]["certificateSources"]
            .as_object()
            .is_some_and(|sources| sources.is_empty())
    {
        fs::remove_file(root.join("https/settings.json")).map_err(|error| error.to_string())?;
    }
    let directory = root.join("https/revisions");
    if directory.exists() {
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let mut filenames = vec!["cert.pem".to_string(), "key.pem".to_string()];
            for service in &targets {
                filenames.extend([format!("{service}-cert.pem"), format!("{service}-key.pem")]);
            }
            for filename in filenames {
                let file = entry.path().join(filename);
                if file.exists() {
                    fs::remove_file(file).map_err(|error| {
                        format!("HTTPS 路由已停用，但证书文件清理失败：{error}")
                    })?;
                }
            }
        }
    }
    let backup = root.join("https/settings.previous");
    if backup.exists() {
        fs::remove_file(backup).map_err(|error| error.to_string())?;
    }
    status(root, docker)
}
