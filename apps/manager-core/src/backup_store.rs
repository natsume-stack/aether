//! Shared backup storage; identifiers returned to adapters are opaque filenames.
//! Callers must protect the directory and its ancestors against hostile concurrent
//! mutation. Portable std path checks cannot prevent ancestor-swap TOCTOU attacks.
use crate::backup::{self, Limits};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub type Result<T> = std::result::Result<T, String>;
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: u64,
}

fn unique() -> String {
    format!(
        "{}-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn filename(name: &str) -> Result<()> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
    {
        return Err("备份名称必须是纯文件名，不能包含路径或特殊字符".into());
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    // Legacy desktop imports also used the generic .gz extension.
    if !matches!(
        extension.to_ascii_lowercase().as_str(),
        "zip" | "tar" | "gz"
    ) {
        return Err("备份格式不支持，请使用 zip、tar 或 tar.gz 文件".into());
    }
    Ok(())
}

/// Normalize spelling without following links or accepting parent traversal.
fn absolute_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("无法读取当前目录：{e}"))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        if matches!(part, Component::ParentDir) {
            return Err("备份路径不能包含上级目录跳转".into());
        }
        if !matches!(part, Component::CurDir) {
            normalized.push(part.as_os_str());
        }
    }
    Ok(normalized)
}

/// Host-configured ancestors may be aliases (e.g. macOS /var and /tmp).
/// The directory/file itself must not be a link, including a dangling link.
fn checked_path(path: &Path) -> Result<PathBuf> {
    let absolute = absolute_path(path)?;
    match fs::symlink_metadata(&absolute) {
        Ok(m) if m.file_type().is_symlink() => return Err("备份目录或文件不能是软链接".into()),
        Ok(_) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(format!("无法检查备份路径：{e}")),
    }
    Ok(absolute)
}

fn directory(path: &Path, create: bool) -> Result<PathBuf> {
    let path = checked_path(path)?;
    if create {
        fs::create_dir_all(&path).map_err(|e| format!("无法创建备份目录：{e}"))?;
    }
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("无法读取备份目录：{e}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("备份目录必须是普通目录".into());
    }
    fs::canonicalize(path).map_err(|e| format!("无法解析备份目录：{e}"))
}

pub fn list(path: &Path) -> Result<Vec<BackupInfo>> {
    let checked = checked_path(path)?;
    if !checked
        .try_exists()
        .map_err(|e| format!("无法检查备份目录：{e}"))?
    {
        return Ok(Vec::new());
    }
    let directory = directory(path, false)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory).map_err(|e| format!("无法读取备份列表：{e}"))? {
        let entry = entry.map_err(|e| format!("无法读取备份项：{e}"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if filename(&name).is_err() {
            continue;
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|e| format!("无法读取备份信息：{e}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        entries.push(BackupInfo {
            path: name.clone(),
            name,
            size_bytes: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_secs())
                .unwrap_or_default(),
        });
    }
    entries.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// Accept an opaque filename or a legacy absolute path to a direct directory child.
pub fn resolve(path: &Path, archive_id: &str) -> Result<PathBuf> {
    let configured = absolute_path(path)?;
    let directory = directory(path, false)?;
    let supplied = Path::new(archive_id);
    let candidate = if supplied.is_absolute() {
        let absolute = absolute_path(supplied)?;
        // Only the configured spelling and its canonical spelling are trusted.
        // Never canonicalize an arbitrary archive id: an internal symlink could
        // otherwise redirect a nested path back into the permitted directory.
        let relative = absolute
            .strip_prefix(&configured)
            .or_else(|_| absolute.strip_prefix(&directory))
            .map_err(|_| "备份文件必须位于备份目录内".to_owned())?;
        let name = relative.to_str().ok_or("备份文件名无效")?;
        filename(name)?;
        directory.join(name)
    } else {
        filename(archive_id)?;
        directory.join(archive_id)
    };
    let name = candidate
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("备份文件名无效")?;
    filename(name)?;
    let metadata =
        fs::symlink_metadata(&candidate).map_err(|e| format!("无法读取备份文件：{e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("备份必须是普通文件，不能是软链接".into());
    }
    let canonical = fs::canonicalize(candidate).map_err(|e| format!("无法解析备份文件：{e}"))?;
    if canonical.parent() != Some(directory.as_path()) {
        return Err("备份文件必须位于备份目录内".into());
    }
    Ok(canonical)
}

struct Staging(PathBuf);
impl Staging {
    fn new(directory: &Path) -> Result<Self> {
        for _ in 0..100 {
            let path = directory.join(format!(".box-import-{}", unique()));
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            match builder.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("无法创建备份暂存目录：{e}")),
            }
        }
        Err("无法分配唯一备份暂存目录".into())
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Linking a complete private file publishes atomically without replacing even a
// dangling destination symlink. rename() would silently overwrite history on Unix.
fn publish(staged: &Path, directory: &Path, name: &str) -> Result<String> {
    fs::hard_link(staged, directory.join(name)).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            "同名备份已存在，未覆盖原有备份".into()
        } else {
            format!("无法发布备份文件：{e}")
        }
    })?;
    Ok(name.to_owned())
}

pub fn create(root: &Path, path: &Path) -> Result<String> {
    let root =
        fs::canonicalize(absolute_path(root)?).map_err(|e| format!("无法解析备份源目录：{e}"))?;
    let directory = directory(path, true)?;
    let staging = Staging::new(&directory)?;
    let name = format!("BOX-backup-{}.tar.gz", unique());
    let archive = staging.0.join(&name);
    backup::create_archive(&root, &archive, Limits::default())
        .map_err(|e| format!("创建备份失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // System tar may create mode 0644; restrict it before the public link exists.
        fs::set_permissions(&archive, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("无法设置备份私密权限：{e}"))?;
    }
    publish(&archive, &directory, &name)
}

fn import_reader(path: &Path, name: &str, mut input: impl Read) -> Result<String> {
    filename(name)?;
    let directory = directory(path, true)?;
    let staging = Staging::new(&directory)?;
    let archive = staging.0.join(name);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(&archive)
        .map_err(|e| format!("无法创建备份暂存文件：{e}"))?;
    io::copy(&mut input, &mut output).map_err(|e| format!("无法写入备份暂存文件：{e}"))?;
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|e| format!("无法保存备份暂存文件：{e}"))?;
    drop(output);
    backup::validate_archive(&archive, Limits::default())
        .map_err(|e| format!("备份校验失败：{e}"))?;
    publish(&archive, &directory, name)
}

pub fn import_file(directory: &Path, source: &Path) -> Result<String> {
    let source = checked_path(source)?;
    let metadata = fs::symlink_metadata(&source).map_err(|e| format!("无法读取导入文件：{e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("导入备份必须是普通文件，不能是软链接".into());
    }
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("导入文件名无效")?;
    filename(name)?;
    let input = File::open(&source).map_err(|e| format!("无法打开导入文件：{e}"))?;
    import_reader(directory, name, input)
}

pub fn import_bytes(directory: &Path, name: &str, bytes: &[u8]) -> Result<String> {
    import_reader(directory, name, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> Staging {
        Staging::new(&fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
    }

    #[test]
    fn resolves_only_direct_files_and_keeps_identifiers_stable() {
        let temp = temp();
        let file = temp.0.join("旧备份.zip");
        fs::write(&file, b"legacy").unwrap();
        assert_eq!(resolve(&temp.0, "旧备份.zip").unwrap(), file);
        assert_eq!(resolve(&temp.0, file.to_str().unwrap()).unwrap(), file);
        for name in ["../old.zip", "sub/old.zip", "sub\\old.zip", "./旧备份.zip"] {
            assert!(resolve(&temp.0, name).is_err());
        }
        let outside = Staging::new(&fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        fs::write(outside.0.join("outside.zip"), b"x").unwrap();
        assert!(resolve(&temp.0, outside.0.join("outside.zip").to_str().unwrap()).is_err());
        let items = list(&temp.0).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "旧备份.zip");
        assert_eq!(items[0].path, "旧备份.zip");
        assert_eq!(items[0].size_bytes, 6);
        assert_eq!(items, list(&temp.0).unwrap());
        let json = serde_json::to_value(&items[0]).unwrap();
        assert!(json.get("modifiedAt").is_some());
        assert!(json.get("sizeBytes").is_some());
    }

    #[test]
    fn publication_never_overwrites_and_failure_cleans_staging() {
        let temp = temp();
        let staged = temp.0.join("source");
        fs::write(&staged, b"new").unwrap();
        let original = temp.0.join("history.tar.gz");
        fs::write(&original, b"history").unwrap();
        assert!(publish(&staged, &temp.0, "history.tar.gz").is_err());
        assert_eq!(fs::read(original).unwrap(), b"history");
        let count = fs::read_dir(&temp.0).unwrap().count();
        assert!(import_bytes(&temp.0, "invalid.zip", b"invalid archive").is_err());
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), count);
        for name in ["../escape.zip", "a/b.tar", "a\\b.zip", "/tmp/a.zip"] {
            assert!(import_bytes(&temp.0, name, b"x").is_err());
        }
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), count);
    }

    #[test]
    fn imports_legacy_zip_without_renaming_or_overwriting() {
        let temp = temp();
        let mut zip = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        zip.start_file(
            "BACKUP-README.txt",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"legacy backup").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let name = "BOX-backup-legacy.zip";
        assert_eq!(import_bytes(&temp.0, name, &bytes).unwrap(), name);
        assert!(import_bytes(&temp.0, name, &bytes).is_err());
        assert_eq!(fs::read(temp.0.join(name)).unwrap(), bytes);
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
        let imported = temp.0.join("imported");
        assert_eq!(import_file(&imported, &temp.0.join(name)).unwrap(), name);
        assert_eq!(fs::read(imported.join(name)).unwrap(), bytes);
    }

    #[test]
    fn creates_unique_archives_and_cleans_failed_creation() {
        let temp = temp();
        let root = temp.0.join("root");
        let store = temp.0.join("backups");
        fs::create_dir(&root).unwrap();
        let first = create(&root, &store).unwrap();
        let second = create(&root, &store).unwrap();
        assert_ne!(first, second);
        for name in [&first, &second] {
            assert!(name.starts_with("BOX-backup-") && name.ends_with(".tar.gz"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(store.join(name)).unwrap().permissions().mode() & 0o7777,
                    0o600
                );
            }
        }
        assert_eq!(list(&store).unwrap().len(), 2);
        assert!(create(&temp.0.join("missing-root"), &store).is_err());
        assert_eq!(fs::read_dir(&store).unwrap().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn accepts_configured_ancestor_alias_but_rejects_archive_and_internal_links() {
        use std::os::unix::fs::symlink;
        let temp = temp();
        let host = temp.0.join("host");
        let alias = temp.0.join("host-alias");
        fs::create_dir(&host).unwrap();
        symlink(&host, &alias).unwrap();
        let configured = alias.join("backups");
        let canonical = host.join("backups");
        assert!(list(&configured).unwrap().is_empty());
        // Creation through an ancestor alias also covers a not-yet-existing store.
        let root = host.join("root");
        fs::create_dir(&root).unwrap();
        let name = create(&alias.join("root"), &configured).unwrap();
        assert_eq!(resolve(&configured, &name).unwrap(), canonical.join(&name));
        for spelling in [&configured, &canonical] {
            let id = spelling.join(&name);
            assert_eq!(
                resolve(&configured, id.to_str().unwrap()).unwrap(),
                canonical.join(&name)
            );
        }
        assert_eq!(list(&configured).unwrap(), list(&canonical).unwrap());
        let imported = alias.join("imported");
        assert_eq!(
            import_file(&imported, &configured.join(&name)).unwrap(),
            name
        );
        symlink(&name, canonical.join("link.tar.gz")).unwrap();
        symlink("missing", canonical.join("dangling.tar.gz")).unwrap();
        // An internal alias back to the store must not make nested ids legal.
        symlink(&canonical, canonical.join("nested")).unwrap();
        for id in [
            "link.tar.gz".to_owned(),
            "dangling.tar.gz".to_owned(),
            format!("nested/{name}"),
            format!("../backups/{name}"),
        ] {
            assert!(resolve(&configured, &id).is_err());
            assert!(resolve(&configured, configured.join(&id).to_str().unwrap()).is_err());
        }
        assert!(import_file(&imported, &configured.join("link.tar.gz")).is_err());
        assert_eq!(list(&configured).unwrap().len(), 1);
        let store_alias = alias.join("store-alias");
        symlink(&canonical, &store_alias).unwrap();
        assert!(list(&store_alias).is_err());
        assert!(list(&store_alias.join(".")).is_err());
        assert!(import_bytes(&store_alias, "bad.zip", b"bad").is_err());
        assert!(resolve(&store_alias, &name).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_including_dangling_and_directory_links() {
        use std::os::unix::fs::symlink;
        let temp = temp();
        fs::write(temp.0.join("real.zip"), b"x").unwrap();
        symlink("real.zip", temp.0.join("link.zip")).unwrap();
        symlink("missing", temp.0.join("dangling.zip")).unwrap();
        symlink(&temp.0, temp.0.join("alias")).unwrap();
        for name in ["link.zip", "dangling.zip"] {
            assert!(resolve(&temp.0, name).is_err());
            assert!(import_file(&temp.0, &temp.0.join(name)).is_err());
        }
        assert!(list(&temp.0.join("alias")).is_err());
        assert_eq!(list(&temp.0).unwrap().len(), 1);
        assert!(publish(&temp.0.join("real.zip"), &temp.0, "dangling.zip").is_err());
    }
}
