//! Shared, synchronous backup rules. Integration dependencies: `flate2 = "1.1.9"`,
//! `tar = "0.4"` (tested 0.4.46), and `zip = { version = "2",
//! default-features = false, features = ["deflate"] }` (tested 2.4.2).
//! Export with `pub mod backup;` and call from each frontend's blocking worker.
//! Creation writes portable tar.gz with controlled PAX path records.
//!
//! Readers accept raw/gzip TAR (USTAR, GNU/PAX ordinary long names) and legacy ZIP
//! (stored/deflated), detected by content, with optional `./` path prefixes.
//! Paths are repository-relative: BACKUP-README.txt, the root `.env` and
//! DATA_DIRECTORIES only.
//! Links, special/sparse files, encryption and path-changing global PAX records
//! are rejected. Metadata is never applied. Only safe AppleDouble sidecars under
//! __MACOSX for whitelisted paths are ignored, after path/type checks and CRC
//! verification; __MACOSX is not a blanket whitelist exception.
//! Missing data directories are preserved on restore; an explicitly archived
//! empty directory clears that directory. README-only backups restore as no-op.
//!
//! Restore validates and stages the entire archive before `before_replace`.
//! That callback must stop ALL writers and return an error if stopping fails.
//! Keep writers stopped until this function returns (also on errors). Directory
//! inodes of existing data roots are preserved: children are moved, not the
//! bind-mounted root itself. Nested bind mounts / different filesystems may
//! reject rename; this triggers rollback. File-level bind mounts need recreation.
//! Callers must serialize other operations on these trees and protect them from
//! hostile concurrent filesystem mutation; std path APIs cannot prevent TOCTOU.
//! A root-local lock serializes cooperating restores, not external writers.
//! This is best-effort rollback, not crash/power-loss atomicity. A crash can leave
//! a lock and private recovery directory requiring manual recovery. Do not blindly
//! remove these. Failed rollback retains recovery data and reports its path.
//! Ownership/ACL/xattrs are not restored; new files use the caller's ownership.
//! On Unix, unreadable owner-owned source files temporarily receive owner-read
//! permission to open a handle; permissions are restored before copying bytes.
//! Live creation is not a consistent DB
//! snapshot: callers should quiesce writers if consistency is required.

use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const DATA_DIRECTORIES: [&str; 4] = [
    "apps/local-engine/projects",
    "apps/local-engine/dist",
    "apps/local-engine/play-worlds",
    "apps/voxa/data",
];
const README: &str = "BACKUP-README.txt";
const README_TEXT: &str =
    "BOX3 Engine 数据备份。包含地图数据；如包含根目录 .env，则其中含有密码、密钥和访问配置，请妥善保管。\n";
pub const ENV_FILE: &str = ".env";
static NEXT: AtomicU64 = AtomicU64::new(0);
pub type Result<T> = std::result::Result<T, String>;

/// Limits apply to all decompressed tar bytes (including padding), or the sum
/// of uncompressed ZIP payloads (including ignored metadata), and logical entries.
/// TAR extension processing also has a fixed 1 MiB budget per logical entry.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_bytes: u64,
    pub max_entries: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_bytes: 100 * 1024 * 1024 * 1024,
            max_entries: 1_000_000,
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub directories: Vec<String>,
    pub files: usize,
    pub data_bytes: u64,
    pub has_env: bool,
}
#[derive(Debug)]
pub struct RestoreReport {
    pub archive: ArchiveInfo,
    /// Replacement succeeded, but obsolete data could not be cleaned up.
    pub cleanup_warning: Option<String>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn invalid(message: &str) -> String {
    format!("Invalid backup: {message}")
}

struct Scratch {
    path: PathBuf,
    keep: bool,
}
impl Scratch {
    fn new(parent: &Path) -> Result<Self> {
        for _ in 0..100 {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(err)?
                .as_nanos();
            let path = parent.join(format!(
                ".box-backup-{}-{stamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            match builder.create(&path) {
                Ok(()) => return Ok(Self { path, keep: false }),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(err(e)),
            }
        }
        Err("Cannot allocate a unique backup directory".into())
    }
    fn cleanup(&mut self) -> Result<()> {
        fs::remove_dir_all(&self.path).map_err(err)?;
        self.keep = true;
        Ok(())
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
struct RestoreLock(PathBuf);
impl RestoreLock {
    fn new(root: &Path) -> Result<Self> {
        let path = root.join(".box-backup-restore.lock");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Cannot acquire restore lock {}: {e}", path.display()))?;
        Ok(Self(path))
    }
}
impl Drop for RestoreLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Reject links at every existing component below a trusted, canonical root.
fn check_directory(root: &Path, relative: &str) -> Result<bool> {
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => (),
            Ok(_) => return Err(format!("Not a plain directory: {}", path.display())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(err(e)),
        }
    }
    Ok(true)
}
fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir(destination).map_err(err)?;
    for item in fs::read_dir(source).map_err(err)? {
        let item = item.map_err(err)?;
        let from = item.path();
        let to = destination.join(item.file_name());
        let m = fs::symlink_metadata(&from).map_err(err)?;
        if m.file_type().is_symlink() {
            return Err(invalid("source contains a symbolic link"));
        }
        if m.is_dir() {
            copy_tree(&from, &to)?;
        } else if m.is_file() {
            copy_plain_file(&from, &to)?;
        } else {
            return Err(invalid("source contains a special file"));
        }
    }
    Ok(())
}

/// Copy one ordinary, single-link file; never follow or preserve links.
fn copy_plain_file(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source).map_err(err)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid("source contains a special file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(invalid("source contains a hard link"));
        }
    }
    let mut input = open_backup_file(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(err)?;
    io::copy(&mut input, &mut output).map_err(err)?;
    Ok(())
}

/// Distinguish a missing optional file from a link or special file.
fn plain_file_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(format!("Not a plain file: {}", path.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(err(e)),
    }
}

// Keep compatibility with files written by containers with mode 0200. Restore
// permissions immediately after open, including when the second open fails.
fn open_backup_file(source: &Path) -> Result<File> {
    match File::open(source) {
        Ok(file) => Ok(file),
        #[cfg(unix)]
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            use std::os::unix::fs::PermissionsExt;
            let original = fs::symlink_metadata(source).map_err(err)?.permissions();
            let mut readable = original.clone();
            readable.set_mode(readable.mode() | 0o400);
            fs::set_permissions(source, readable).map_err(err)?;
            let opened = File::open(source);
            fs::set_permissions(source, original).map_err(|e| {
                format!(
                    "Cannot restore original permissions on {}: {e}",
                    source.display()
                )
            })?;
            opened.map_err(err)
        }
        Err(e) => Err(format!("Cannot read {}: {e}", source.display())),
    }
}

/// Write only ordinary entries and explicit long-path metadata. System tar can
/// add platform-specific PAX fields which our strict import validator rejects.
fn append_backup_entry(
    builder: &mut tar::Builder<GzEncoder<File>>,
    source: &Path,
    name: &Path,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source).map_err(err)?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(invalid("links and special files are forbidden"));
    }
    let mut header = tar::Header::new_ustar();
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_mode(if metadata.is_dir() { 0o755 } else { 0o600 });
    header.set_entry_type(if metadata.is_dir() {
        tar::EntryType::Directory
    } else {
        tar::EntryType::Regular
    });
    header.set_size(if metadata.is_dir() { 0 } else { metadata.len() });
    if header.set_path(name).is_err() {
        let name = name
            .to_str()
            .ok_or("Backup path is not valid UTF-8")?
            .replace('\\', "/");
        builder
            .append_pax_extensions([("path", name.as_bytes())])
            .map_err(err)?;
        header.set_path("PaxEntry").map_err(err)?;
    }
    header.set_cksum();
    if metadata.is_dir() {
        builder.append(&header, io::empty()).map_err(err)?;
        let mut entries = fs::read_dir(source)
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            append_backup_entry(builder, &entry.path(), &name.join(entry.file_name()))?;
        }
    } else {
        builder
            .append(&header, File::open(source).map_err(err)?)
            .map_err(err)?;
    }
    Ok(())
}

/// Creates a new `.tar.gz`; never overwrites an existing destination. Its parent
/// must already exist and must be outside the four data trees. Returns metadata
/// only after validating the actual resulting gzip/PAX stream.
pub fn create_archive(root: &Path, destination: &Path, limits: Limits) -> Result<ArchiveInfo> {
    let root = fs::canonicalize(root).map_err(err)?;
    let parent = fs::canonicalize(
        destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )
    .map_err(err)?;
    let name = destination.file_name().ok_or("Missing archive filename")?;
    if !name.to_string_lossy().ends_with(".tar.gz") {
        return Err("Backup filename must end with .tar.gz".into());
    }
    for relative in DATA_DIRECTORIES {
        if parent.starts_with(root.join(relative)) {
            return Err("Archive must be outside the data directories".into());
        }
    }
    let destination = parent.join(name);
    let scratch = Scratch::new(&parent)?;
    let tree = scratch.path.join("tree");
    fs::create_dir(&tree).map_err(err)?;
    fs::write(tree.join(README), README_TEXT).map_err(err)?;
    let mut paths = vec![README];
    if plain_file_exists(&root.join(ENV_FILE))? {
        copy_plain_file(&root.join(ENV_FILE), &tree.join(ENV_FILE))?;
        paths.push(ENV_FILE);
    }
    for relative in DATA_DIRECTORIES {
        if check_directory(&root, relative)? {
            let target = tree.join(relative);
            fs::create_dir_all(target.parent().unwrap()).map_err(err)?;
            copy_tree(&root.join(relative), &target)?;
            paths.push(relative);
        }
    }
    let archive = scratch.path.join("archive.tar.gz");
    let gzip = GzEncoder::new(File::create(&archive).map_err(err)?, Compression::default());
    let mut builder = tar::Builder::new(gzip);
    for relative in paths {
        append_backup_entry(&mut builder, &tree.join(relative), Path::new(relative))?;
    }
    builder.into_inner().map_err(err)?.finish().map_err(err)?;
    let info = validate_archive(&archive, limits)?;
    // Atomic no-clobber publication on the same filesystem, with no partial
    // archive visible to callers if creation/validation fails.
    fs::hard_link(&archive, &destination).map_err(err)?;
    Ok(info)
}

/// Fully checks archive headers, gzip/ZIP checksums, whitelist and payload
/// without writing extracted files. Restore always validates again in its own staging
/// pass, so callers cannot accidentally restore an archive changed after check.
pub fn validate_archive(archive: &Path, limits: Limits) -> Result<ArchiveInfo> {
    read_archive(archive, None, limits)
}

fn safe_name(name: &str, directory: bool) -> Result<String> {
    if name.starts_with('/') || name.is_empty() {
        return Err(invalid("absolute or empty path"));
    }
    let name = name.strip_prefix("./").unwrap_or(name);
    let name = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    if directory && (name.is_empty() || name == ".") {
        return Ok(String::new());
    }
    for part in name.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
        {
            return Err(invalid("unsafe path"));
        }
        let base = part.split('.').next().unwrap().to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str())
            || ((base.starts_with("COM") || base.starts_with("LPT"))
                && base.len() == 4
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(invalid("reserved filename"));
        }
    }
    Ok(name.to_owned())
}
// The mature readers resolve archive headers and extensions. This shared state
// validates their effective names/types, and writes only ordinary file bytes.
#[derive(Default)]
struct Contents {
    info: ArchiveInfo,
    names: HashSet<String>,
    spellings: HashMap<String, String>,
    files: HashSet<String>,
    directories: HashSet<String>,
    present: [bool; 4],
    readme: bool,
    env: bool,
    count: usize,
    bytes: u64,
}
fn permitted(name: &str, directory: bool) -> bool {
    (directory && ["", "apps", "apps/local-engine", "apps/voxa"].contains(&name))
        || (!directory && (name == README || name == ENV_FILE))
        || DATA_DIRECTORIES
            .iter()
            .any(|root| (directory && name == *root) || name.starts_with(&format!("{root}/")))
}
// AppleDouble metadata may mirror ONLY a whitelisted path; even metadata must
// have a safe name and an ordinary file/directory type. Never restore these bytes.
fn apple_metadata(name: &str, directory: bool) -> Result<bool> {
    if name == "__MACOSX" && directory {
        return Ok(true);
    }
    let Some(relative) = name.strip_prefix("__MACOSX/") else {
        return Ok(false);
    };
    let logical = if directory {
        relative.to_owned()
    } else {
        let (parent, leaf) = relative.rsplit_once('/').unwrap_or(("", relative));
        let leaf = leaf
            .strip_prefix("._")
            .ok_or_else(|| invalid("unexpected __MACOSX file"))?;
        if leaf.is_empty() {
            return Err(invalid("empty AppleDouble name"));
        }
        if parent.is_empty() {
            leaf.to_owned()
        } else {
            format!("{parent}/{leaf}")
        }
    };
    let logical = safe_name(&logical, directory)?;
    // Sidecars can describe a directory as well as a file.
    if !permitted(&logical, directory) && (directory || !permitted(&logical, true)) {
        return Err(invalid("AppleDouble metadata outside the whitelist"));
    }
    Ok(true)
}
impl Contents {
    fn count(&mut self, limits: Limits) -> Result<()> {
        self.count += 1;
        if self.count > limits.max_entries {
            return Err(invalid("entry limit exceeded"));
        }
        Ok(())
    }
    fn entry(
        &mut self,
        name: &str,
        directory: bool,
        size: u64,
        reader: &mut impl Read,
        staging: Option<&Path>,
        limits: Limits,
    ) -> Result<()> {
        self.count(limits)?;
        if directory && size != 0 {
            return Err(invalid("directory has payload"));
        }
        self.bytes = self
            .bytes
            .checked_add(size)
            .ok_or_else(|| invalid("payload size overflow"))?;
        if self.bytes > limits.max_bytes {
            return Err(invalid("decompressed byte limit exceeded"));
        }
        let name = safe_name(name, directory)?;
        let ignored = apple_metadata(&name, directory)?;
        if !ignored && !permitted(&name, directory) {
            return Err(invalid("entry outside the four data directories"));
        }
        if !ignored && !directory && name == ENV_FILE {
            self.env = true;
        }
        let mut spelling = name.as_str();
        loop {
            if let Some(previous) = self
                .spellings
                .insert(spelling.to_lowercase(), spelling.to_owned())
            {
                if previous != spelling {
                    return Err(invalid("case-alias path component"));
                }
            }
            match spelling.rsplit_once('/') {
                Some((parent, _)) => spelling = parent,
                None => break,
            }
        }
        let key = name.to_lowercase();
        if !self.names.insert(key.clone()) {
            return Err(invalid("duplicate or case-alias entry"));
        }
        let mut parent = key.as_str();
        while let Some((p, _)) = parent.rsplit_once('/') {
            if self.files.contains(p) {
                return Err(invalid("file used as directory"));
            }
            self.directories.insert(p.to_owned());
            parent = p;
        }
        if directory {
            if self.files.contains(&key) {
                return Err(invalid("file/directory conflict"));
            }
            self.directories.insert(key);
        } else {
            if self.directories.contains(&key) {
                return Err(invalid("file/directory conflict"));
            }
            self.files.insert(key);
        }
        let mut output = if let Some(base) = staging.filter(|_| !ignored && !name.is_empty()) {
            let target = base.join(&name);
            if directory {
                fs::create_dir_all(target).map_err(err)?;
                None
            } else {
                fs::create_dir_all(target.parent().unwrap()).map_err(err)?;
                Some(
                    OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(target)
                        .map_err(err)?,
                )
            }
        } else {
            None
        };
        // One byte beyond the advertised size detects overlong ZIP streams; read
        // through EOF so zip's CRC checker runs even on empty/ignored members.
        let mut bounded = reader.take(
            size.checked_add(1)
                .ok_or_else(|| invalid("entry size overflow"))?,
        );
        let copied = match output.as_mut() {
            Some(file) => io::copy(&mut bounded, file),
            None => io::copy(&mut bounded, &mut io::sink()),
        }
        .map_err(err)?;
        if copied != size {
            return Err(invalid("entry payload length mismatch"));
        }
        if !ignored {
            if name == README && !directory {
                self.readme = true;
            }
            for (i, relative) in DATA_DIRECTORIES.iter().enumerate() {
                if name == *relative || name.starts_with(&format!("{relative}/")) {
                    self.present[i] = true;
                }
            }
            if !directory && name != README {
                self.info.files += 1;
                self.info.data_bytes += size;
            }
        }
        Ok(())
    }
    fn finish(mut self) -> Result<ArchiveInfo> {
        if !self.readme {
            return Err(invalid("missing BACKUP-README.txt"));
        }
        self.info.has_env = self.env;
        self.info.directories = DATA_DIRECTORIES
            .iter()
            .zip(self.present)
            .filter(|(_, yes)| *yes)
            .map(|(p, _)| (*p).into())
            .collect();
        Ok(self.info)
    }
}

// tar resolves extension records internally in Iterator::next(). Bound that
// phase separately so a giant GNU longname/PAX record cannot allocate gigabytes.
const MAX_TAR_METADATA: u64 = 1024 * 1024;
struct MetadataBudget<'a, R> {
    inner: R,
    remaining: &'a Cell<u64>,
}
impl<R: Read> Read for MetadataBudget<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let remaining = self.remaining.get();
        if remaining == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "tar extension metadata limit exceeded",
            ));
        }
        let length = bytes.len().min(remaining.try_into().unwrap_or(usize::MAX));
        let n = self.inner.read(&mut bytes[..length])?;
        self.remaining.set(remaining - n as u64);
        Ok(n)
    }
}
fn check_pax(entry: &mut tar::Entry<'_, impl Read>, global: bool) -> Result<()> {
    let effective_path = entry.path_bytes().into_owned();
    let effective_size = entry.size();
    let directory = entry.header().entry_type().is_dir();
    let Some(extensions) = entry.pax_extensions().map_err(err)? else {
        return Ok(());
    };
    let mut seen = HashSet::new();
    for extension in extensions {
        let extension = extension.map_err(err)?;
        let key = extension.key().map_err(err)?;
        if !seen.insert(key.to_owned()) {
            return Err(invalid("duplicate PAX key"));
        }
        match key {
            "path" if !global => {
                let declared = safe_name(extension.value().map_err(err)?, directory)?;
                let effective = safe_name(
                    std::str::from_utf8(&effective_path).map_err(err)?,
                    directory,
                )?;
                if declared != effective {
                    return Err(invalid("conflicting GNU/PAX paths"));
                }
            }
            "size" if !global => {
                if extension
                    .value()
                    .map_err(err)?
                    .parse::<u64>()
                    .map_err(err)?
                    != effective_size
                {
                    return Err(invalid("conflicting PAX size"));
                }
            }
            "mtime" | "atime" | "ctime" | "uid" | "gid" | "uname" | "gname" | "charset"
            | "hdrcharset" | "comment" | "SCHILY.fflags" => (),
            key if key.starts_with("SCHILY.xattr.")
                || key.starts_with("LIBARCHIVE.xattr.")
                || key.starts_with("SCHILY.acl.") => {}
            // Includes linkpath, GNU.sparse.*, SCHILY.filetype and global path
            // or size overrides, none of which we silently reinterpret.
            _ => return Err(invalid("unsupported or unsafe PAX key")),
        }
    }
    Ok(())
}
fn read_tar(input: impl Read, staging: Option<&Path>, limits: Limits) -> Result<ArchiveInfo> {
    let metadata_remaining = Cell::new(MAX_TAR_METADATA);
    let reader = MetadataBudget {
        inner: input.take(
            limits
                .max_bytes
                .checked_add(1)
                .ok_or("Invalid byte limit")?,
        ),
        remaining: &metadata_remaining,
    };
    let mut archive = tar::Archive::new(reader);
    let mut contents = Contents::default();
    let mut entries = archive.entries().map_err(err)?;
    loop {
        metadata_remaining.set(MAX_TAR_METADATA);
        let Some(entry) = entries.next() else {
            break;
        };
        let mut entry = entry.map_err(err)?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() {
            contents.count(limits)?;
            if entry.size() > MAX_TAR_METADATA {
                return Err(invalid("global PAX metadata limit exceeded"));
            }
            // tar doesn't apply global records; allow only harmless attributes.
            check_pax(&mut entry, true)?;
            continue;
        }
        if !kind.is_file() && !kind.is_dir() {
            return Err(invalid("links and special/sparse files are forbidden"));
        }
        if entry.link_name_bytes().is_some() {
            return Err(invalid("link target present"));
        }
        check_pax(&mut entry, false)?;
        let name = String::from_utf8(entry.path_bytes().into_owned()).map_err(err)?;
        let size = entry.size();
        metadata_remaining.set(u64::MAX);
        contents.entry(&name, kind.is_dir(), size, &mut entry, staging, limits)?;
    }
    metadata_remaining.set(u64::MAX);
    let mut reader = archive.into_inner();
    // Drain the decoder after tar EOF: verify gzip CRC/trailer and reject a
    // second hidden archive or garbage following the first tar end block.
    let mut tail = [0u8; 8192];
    let mut padding = 0u64;
    loop {
        let n = reader.read(&mut tail).map_err(err)?;
        if n == 0 {
            break;
        }
        padding += n as u64;
        if tail[..n].iter().any(|b| *b != 0) {
            return Err(invalid("trailing archive data"));
        }
    }
    if reader.inner.limit() == 0 {
        return Err(invalid("decompressed byte limit exceeded"));
    }
    if padding < 512 || !padding.is_multiple_of(512) {
        return Err(invalid("missing tar end marker"));
    }
    contents.finish()
}

// ZIP does not have a native hard-link entry type. Reject Unix extra fields
// carrying link targets as well as non-file Unix modes. Never apply extra data.
fn check_zip_extra(mut bytes: &[u8]) -> Result<()> {
    while !bytes.is_empty() {
        if bytes.len() < 4 {
            return Err(invalid("truncated ZIP extra field"));
        }
        let tag = u16::from_le_bytes([bytes[0], bytes[1]]);
        let len = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
        let data = bytes
            .get(4..4 + len)
            .ok_or_else(|| invalid("truncated ZIP extra field"))?;
        if tag == 0x000d && len > 12 {
            return Err(invalid("ZIP Unix link extra field"));
        }
        if tag == 0x756e {
            if len != 14 {
                return Err(invalid("ZIP ASi link or malformed extra field"));
            }
            let kind = u16::from_le_bytes([data[4], data[5]]) & 0o170000;
            if kind != 0o100000 && kind != 0o040000 {
                return Err(invalid("ZIP ASi special file"));
            }
        }
        bytes = &bytes[4 + len..];
    }
    Ok(())
}
// zip 2 keeps only the last central-directory entry for a duplicate filename.
// Check record coverage so an earlier hidden symlink/special member cannot
// disappear from validation. Only framing is checked here; zip remains the
// parser for names, methods, attributes, sizes, ZIP64 fields and payloads.
fn check_zip_inventory(archive: &mut zip::ZipArchive<File>, file: &mut File) -> Result<()> {
    let mut offsets = HashSet::new();
    for index in 0..archive.len() {
        offsets.insert(
            archive
                .by_index_raw(index)
                .map_err(err)?
                .central_header_start(),
        );
    }
    let mut offset = archive.central_directory_start();
    while !offsets.is_empty() {
        if !offsets.remove(&offset) {
            return Err(invalid("duplicate or hidden ZIP member"));
        }
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
        let mut header = [0u8; 46];
        file.read_exact(&mut header).map_err(err)?;
        if &header[..4] != b"PK\x01\x02" {
            return Err(invalid("ZIP central-directory framing"));
        }
        let lengths: u64 = [28, 30, 32]
            .iter()
            .map(|i| u16::from_le_bytes([header[*i], header[*i + 1]]) as u64)
            .sum();
        offset = offset
            .checked_add(46 + lengths)
            .ok_or_else(|| invalid("ZIP offset overflow"))?;
    }
    file.seek(SeekFrom::Start(offset)).map_err(err)?;
    let mut next = [0u8; 4];
    file.read_exact(&mut next).map_err(err)?;
    if next != *b"PK\x05\x06" && next != *b"PK\x06\x06" {
        return Err(invalid(
            "duplicate member or unsupported ZIP directory trailer",
        ));
    }
    Ok(())
}

fn read_zip(file: File, staging: Option<&Path>, limits: Limits) -> Result<ArchiveInfo> {
    let mut inventory = file.try_clone().map_err(err)?;
    let mut archive = zip::ZipArchive::new(file).map_err(err)?;
    if archive.len() > limits.max_entries {
        return Err(invalid("entry limit exceeded"));
    }
    check_zip_inventory(&mut archive, &mut inventory)?;
    let mut contents = Contents::default();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(err)?;
        if entry.encrypted() {
            return Err(invalid("encrypted ZIP entries are forbidden"));
        }
        // Older .NET/PowerShell ZIPs may use backslashes. Normalize separators
        // before checking traversal, absolute/UNC paths, drive letters or aliases.
        // macOS ditto stores UTF-8 bytes without the ZIP UTF-8 flag. Prefer
        // valid raw UTF-8 (including Unicode-path extra fields resolved by zip),
        // otherwise retain zip's legacy CP437 decoding.
        let name = std::str::from_utf8(entry.name_raw())
            .unwrap_or(entry.name())
            .replace('\\', "/");
        let directory = name.ends_with('/');
        let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
        if kind != 0 && kind != if directory { 0o040000 } else { 0o100000 } {
            return Err(invalid("ZIP links and special files are forbidden"));
        }
        check_zip_extra(entry.extra_data().unwrap_or_default())?;
        let size = entry.size();
        contents.entry(&name, directory, size, &mut entry, staging, limits)?;
    }
    contents.finish()
}
fn read_archive(archive: &Path, staging: Option<&Path>, limits: Limits) -> Result<ArchiveInfo> {
    let metadata = fs::symlink_metadata(archive).map_err(err)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid("archive must be a plain file"));
    }
    let mut file = File::open(archive).map_err(err)?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(err)?;
    file.seek(SeekFrom::Start(0)).map_err(err)?;
    if magic[..2] == [0x1f, 0x8b] {
        read_tar(MultiGzDecoder::new(file), staging, limits)
    } else if magic == *b"PK\x03\x04" || magic == *b"PK\x05\x06" {
        read_zip(file, staging, limits)
    } else {
        read_tar(file, staging, limits)
    }
}

/// Validates/extracts once to private staging, then invokes the callback, then
/// replaces ONLY the data directories present in the archive. The root `.env`
/// is left untouched; use `restore_archive_with_env` to opt into replacing it.
/// Callback failure leaves live data unchanged. Existing root directory
/// identities are preserved.
pub fn restore_archive<F>(
    root: &Path,
    archive: &Path,
    limits: Limits,
    before_replace: F,
) -> Result<RestoreReport>
where
    F: FnOnce(&ArchiveInfo) -> Result<()>,
{
    restore_archive_with_env(root, archive, limits, false, before_replace)
}

/// Same as `restore_archive`, with an explicit choice for the archived root
/// `.env`. The saved file is only replaced when `restore_env` is true and the
/// archive actually contains one; a missing `.env` is simply created.
pub fn restore_archive_with_env<F>(
    root: &Path,
    archive: &Path,
    limits: Limits,
    restore_env: bool,
    before_replace: F,
) -> Result<RestoreReport>
where
    F: FnOnce(&ArchiveInfo) -> Result<()>,
{
    let root = fs::canonicalize(root).map_err(err)?;
    let _lock = RestoreLock::new(&root)?;
    let mut scratch = Scratch::new(&root)?;
    let tree = scratch.path.join("new");
    fs::create_dir(&tree).map_err(err)?;
    let info = read_archive(archive, Some(&tree), limits)?;
    if info.directories.is_empty() && !(restore_env && info.has_env) {
        return Ok(RestoreReport {
            archive: info,
            cleanup_warning: None,
        });
    }
    for relative in &info.directories {
        check_directory(&root, relative)?;
    }
    before_replace(&info)?;
    // Recheck after the callback, which may have changed the runtime tree.
    for relative in &info.directories {
        check_directory(&root, relative)?;
    }
    let mut moves = Vec::new();
    let mut created = Vec::new();
    let replacement = (|| -> Result<()> {
        for (index, relative) in info.directories.iter().enumerate() {
            let destination = root.join(relative);
            let mut path = root.clone();
            for part in relative.split('/') {
                path.push(part);
                if !path.exists() {
                    fs::create_dir(&path).map_err(err)?;
                    created.push(path.clone());
                }
            }
            let old = scratch.path.join(format!("old-{index}"));
            fs::create_dir(&old).map_err(err)?;
            move_children(&destination, &old, &mut moves)?;
            move_children(&tree.join(relative), &destination, &mut moves)?;
        }
        if restore_env && info.has_env {
            let source = tree.join(ENV_FILE);
            let destination = root.join(ENV_FILE);
            let old = scratch.path.join("old-env");
            match fs::symlink_metadata(&destination) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    fs::rename(&destination, &old).map_err(err)?;
                    moves.push((destination.clone(), old));
                    fs::rename(&source, &destination).map_err(err)?;
                    moves.push((source, destination));
                }
                Ok(_) => {
                    return Err(format!(
                        "现有 .env 不是普通文件，未替换：{}",
                        destination.display()
                    ));
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    fs::rename(&source, &destination).map_err(err)?;
                    moves.push((source, destination));
                }
                Err(e) => return Err(err(e)),
            }
        }
        Ok(())
    })();
    if let Err(error) = replacement {
        let mut failures = Vec::new();
        for (from, to) in moves.iter().rev() {
            if let Err(e) = fs::rename(to, from) {
                failures.push(format!("{} -> {}: {e}", to.display(), from.display()));
            }
        }
        for path in created.iter().rev() {
            if let Err(e) = fs::remove_dir(path) {
                failures.push(format!("{}: {e}", path.display()));
            }
        }
        if !failures.is_empty() {
            scratch.keep = true;
            return Err(format!(
                "Restore failed: {error}; rollback incomplete: {}; recovery data: {}",
                failures.join("; "),
                scratch.path.display()
            ));
        }
        return Err(format!("Restore failed; previous data restored: {error}"));
    }
    let cleanup_warning = scratch.cleanup().err().map(|e| {
        scratch.keep = true;
        format!(
            "Restore committed; cleanup failed at {}: {e}",
            scratch.path.display()
        )
    });
    Ok(RestoreReport {
        archive: info,
        cleanup_warning,
    })
}
fn move_children(from: &Path, to: &Path, moves: &mut Vec<(PathBuf, PathBuf)>) -> Result<()> {
    for entry in fs::read_dir(from).map_err(err)? {
        let entry = entry.map_err(err)?;
        let source = entry.path();
        let destination = to.join(entry.file_name());
        fs::rename(&source, &destination)
            .map_err(|e| format!("{} -> {}: {e}", source.display(), destination.display()))?;
        moves.push((source, destination));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::Write;
    use std::process::Command;

    fn temp() -> Scratch {
        Scratch::new(&std::env::temp_dir()).unwrap()
    }
    fn put(root: &Path, relative: &str, value: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }
    fn fixture(parent: &Path) -> (PathBuf, PathBuf) {
        let source = parent.join("source");
        fs::create_dir(&source).unwrap();
        for relative in DATA_DIRECTORIES {
            put(
                &source,
                &format!("{relative}/nested/new.txt"),
                b"new\0data\n",
            );
        }
        put(&source, ".env", b"BOX_IMAGE_TAG=fixture\n");
        let archive = parent.join("backup.tar.gz");
        let info = create_archive(&source, &archive, Limits::default()).unwrap();
        assert_eq!(info.directories.len(), 4);
        assert_eq!(info.files, 5);
        assert!(info.has_env);
        (source, archive)
    }
    fn header(name: &str, kind: u8, data: &[u8]) -> Vec<u8> {
        let mut h = [0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..108].copy_from_slice(b"0000644\0");
        h[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
        h[156] = kind;
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        h[148..156].fill(b' ');
        let sum: u64 = h.iter().map(|v| *v as u64).sum();
        h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        let mut bytes = h.to_vec();
        bytes.extend_from_slice(data);
        bytes.resize(bytes.len().div_ceil(512) * 512, 0);
        bytes
    }
    fn raw_archive(path: &Path, entries: &[(&str, u8, &[u8])]) {
        let mut raw = header(README, b'0', README_TEXT.as_bytes());
        for (name, kind, data) in entries {
            raw.extend(header(name, *kind, data));
        }
        raw.extend([0u8; 1024]);
        let mut gzip = GzEncoder::new(File::create(path).unwrap(), Compression::default());
        gzip.write_all(&raw).unwrap();
        gzip.finish().unwrap();
    }
    #[test]
    fn real_tar_round_trip_replaces_old_files_preserving_root_identity() {
        let temp = temp();
        let (_, archive) = fixture(&temp.path);
        let target = temp.path.join("target");
        for relative in DATA_DIRECTORIES {
            put(&target, &format!("{relative}/nested/stale.txt"), b"old");
            put(&target, &format!("{relative}/obsolete.txt"), b"old");
        }
        put(&target, ".env", b"keep root configuration");
        #[cfg(unix)]
        let inodes: Vec<_> = {
            use std::os::unix::fs::MetadataExt;
            DATA_DIRECTORIES
                .iter()
                .map(|p| fs::metadata(target.join(p)).unwrap().ino())
                .collect()
        };
        let calls = Cell::new(0);
        let result = restore_archive(&target, &archive, Limits::default(), |_| {
            assert!(target
                .join("apps/local-engine/projects/obsolete.txt")
                .exists());
            calls.set(calls.get() + 1);
            Ok(())
        })
        .unwrap();
        assert!(result.cleanup_warning.is_none());
        assert_eq!(calls.get(), 1);
        for relative in DATA_DIRECTORIES {
            assert_eq!(
                fs::read(target.join(relative).join("nested/new.txt")).unwrap(),
                b"new\0data\n"
            );
            assert!(!target.join(relative).join("obsolete.txt").exists());
            assert!(!target.join(relative).join("nested/stale.txt").exists());
        }
        assert_eq!(
            fs::read(target.join(".env")).unwrap(),
            b"keep root configuration"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            for (p, inode) in DATA_DIRECTORIES.iter().zip(inodes) {
                assert_eq!(fs::metadata(target.join(p)).unwrap().ino(), inode);
            }
        }
        // Independent system-tar extraction also reads the format we published.
        let independent = temp.path.join("tar-extracted");
        fs::create_dir(&independent).unwrap();
        assert!(Command::new("tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&independent)
            .status()
            .unwrap()
            .success());
        assert_eq!(
            fs::read(independent.join("apps/voxa/data/nested/new.txt")).unwrap(),
            b"new\0data\n"
        );
        assert_eq!(
            fs::read(independent.join(".env")).unwrap(),
            b"BOX_IMAGE_TAG=fixture\n"
        );
    }
    #[test]
    fn env_is_replaced_only_when_the_caller_opts_in() {
        let temp = temp();
        let (_, archive) = fixture(&temp.path);
        let info = validate_archive(&archive, Limits::default()).unwrap();
        assert!(info.has_env);
        let target = temp.path.join("target");
        put(&target, ".env", b"current configuration\n");
        restore_archive(&target, &archive, Limits::default(), |_| Ok(())).unwrap();
        assert_eq!(
            fs::read(target.join(".env")).unwrap(),
            b"current configuration\n",
            "default restore must keep the live .env"
        );
        let result = restore_archive_with_env(&target, &archive, Limits::default(), true, |_| Ok(()))
            .unwrap();
        assert!(result.cleanup_warning.is_none());
        assert_eq!(
            fs::read(target.join(".env")).unwrap(),
            b"BOX_IMAGE_TAG=fixture\n"
        );
        // A .env-only archive still restores when explicitly requested.
        let only_env = temp.path.join("only-env");
        fs::create_dir(&only_env).unwrap();
        put(&only_env, ".env", b"only env\n");
        let only_env_archive = temp.path.join("only-env.tar.gz");
        create_archive(&only_env, &only_env_archive, Limits::default()).unwrap();
        restore_archive_with_env(&target, &only_env_archive, Limits::default(), true, |_| Ok(()))
            .unwrap();
        assert_eq!(fs::read(target.join(".env")).unwrap(), b"only env\n");
        // Requesting an env restore on an archive without one is a no-op.
        let no_env = temp.path.join("no-env");
        fs::create_dir(&no_env).unwrap();
        let no_env_archive = temp.path.join("no-env.tar.gz");
        create_archive(&no_env, &no_env_archive, Limits::default()).unwrap();
        restore_archive_with_env(&target, &no_env_archive, Limits::default(), true, |_| Ok(()))
            .unwrap();
        assert_eq!(fs::read(target.join(".env")).unwrap(), b"only env\n");
    }
    #[test]
    fn env_restore_refuses_a_non_file_target_and_rolls_back() {
        let temp = temp();
        let (_, archive) = fixture(&temp.path);
        let target = temp.path.join("target");
        fs::create_dir_all(target.join(".env")).unwrap();
        put(&target, "apps/local-engine/projects/old", b"old");
        let error = restore_archive_with_env(&target, &archive, Limits::default(), true, |_| Ok(()))
            .unwrap_err();
        assert!(error.contains(".env"), "{error}");
        assert!(target.join(".env").is_dir());
        assert_eq!(
            fs::read(target.join("apps/local-engine/projects/old")).unwrap(),
            b"old",
            "failed env replacement must roll the data directories back"
        );
    }
    #[test]
    fn empty_backup_is_valid_noop_and_explicit_empty_directory_clears_only_it() {
        let temp = temp();
        let source = temp.path.join("source");
        fs::create_dir(&source).unwrap();
        let archive = temp.path.join("empty.tar.gz");
        let info = create_archive(&source, &archive, Limits::default()).unwrap();
        assert!(info.directories.is_empty());
        assert!(!info.has_env, "installations without a .env must not claim one");
        let target = temp.path.join("target");
        for p in DATA_DIRECTORIES {
            put(&target, &format!("{p}/old"), b"old");
        }
        restore_archive(&target, &archive, Limits::default(), |_| {
            panic!("empty restore must not stop services")
        })
        .unwrap();
        for p in DATA_DIRECTORIES {
            assert!(target.join(p).join("old").exists());
        }
        fs::create_dir_all(source.join(DATA_DIRECTORIES[0])).unwrap();
        let archive = temp.path.join("empty-directory.tar.gz");
        create_archive(&source, &archive, Limits::default()).unwrap();
        restore_archive(&target, &archive, Limits::default(), |_| Ok(())).unwrap();
        assert_eq!(
            fs::read_dir(target.join(DATA_DIRECTORIES[0]))
                .unwrap()
                .count(),
            0
        );
        for p in &DATA_DIRECTORIES[1..] {
            assert!(target.join(p).join("old").exists());
        }
    }
    #[test]
    fn rejects_unsafe_paths_types_and_configuration_before_callback() {
        let temp = temp();
        let archive = temp.path.join("bad.tar.gz");
        let target = temp.path.join("target");
        put(&target, "apps/local-engine/projects/old", b"old");
        let invalid_entries = [
            ("../escape", b'0'),
            ("/absolute", b'0'),
            ("/", b'5'),
            ("apps/local-engine/projects/../../.env", b'0'),
            ("apps/local-engine/projects/..\\escape", b'0'),
            ("apps/local-engine/projects/C:evil", b'0'),
            ("apps/local-engine/projects/NUL", b'0'),
            ("apps/local-engine/projects/name.", b'0'),
            ("docker-compose.yml", b'0'),
            ("apps/local-engine/.env", b'0'),
            ("apps/voxa/config", b'0'),
            ("apps/local-engine/projects", b'0'),
            ("apps/local-engine/projects/link", b'1'),
            ("apps/local-engine/projects/link", b'2'),
            ("apps/local-engine/projects/device", b'3'),
            ("apps/local-engine/projects/device", b'4'),
            ("apps/local-engine/projects/fifo", b'6'),
            ("apps/local-engine/projects/sparse", b'S'),
            ("apps/local-engine/projects/pax", b'x'),
            ("apps/local-engine/projects/long", b'L'),
        ];
        for (name, kind) in invalid_entries {
            raw_archive(&archive, &[(name, kind, b"")]);
            assert!(
                validate_archive(&archive, Limits::default()).is_err(),
                "{name} {kind}"
            );
            assert!(
                restore_archive(&target, &archive, Limits::default(), |_| panic!(
                    "invalid archive stopped services"
                ))
                .is_err()
            );
            assert_eq!(
                fs::read(target.join("apps/local-engine/projects/old")).unwrap(),
                b"old"
            );
        }
    }
    #[test]
    fn rejects_duplicate_alias_conflict_corruption_and_limits() {
        let temp = temp();
        let archive = temp.path.join("bad.tar.gz");
        for entries in [
            vec![
                ("apps/voxa/data/a", b'0', &b"x"[..]),
                ("apps/voxa/data/a", b'0', &b"y"[..]),
            ],
            vec![
                ("apps/voxa/data/A/x", b'0', &b"x"[..]),
                ("apps/voxa/data/a/y", b'0', &b"y"[..]),
            ],
            vec![
                ("apps/voxa/data/a/b", b'0', &b"x"[..]),
                ("apps/voxa/data/a", b'0', &b"y"[..]),
            ],
        ] {
            raw_archive(&archive, &entries);
            assert!(validate_archive(&archive, Limits::default()).is_err());
        }
        raw_archive(&archive, &[("apps/voxa/data/a", b'0', b"payload")]);
        assert!(validate_archive(
            &archive,
            Limits {
                max_bytes: 1024,
                max_entries: 10
            }
        )
        .is_err());
        assert!(validate_archive(
            &archive,
            Limits {
                max_bytes: 10000,
                max_entries: 1
            }
        )
        .is_err());
        let valid = fs::read(&archive).unwrap();
        let mut corrupt = valid.clone();
        let n = corrupt.len();
        corrupt[n - 8] ^= 0xff;
        fs::write(&archive, corrupt).unwrap();
        assert!(validate_archive(&archive, Limits::default()).is_err());
        fs::write(&archive, &valid[..valid.len() - 5]).unwrap();
        assert!(validate_archive(&archive, Limits::default()).is_err());
        let mut gzip = GzEncoder::new(File::create(&archive).unwrap(), Compression::default());
        gzip.write_all(&[0; 1024]).unwrap();
        gzip.finish().unwrap();
        assert!(validate_archive(&archive, Limits::default()).is_err()); // no README
    }
    #[test]
    fn callback_failure_leaves_data_unchanged_and_cleans_scratch() {
        let temp = temp();
        let (_, archive) = fixture(&temp.path);
        let target = temp.path.join("target");
        put(&target, "apps/voxa/data/old", b"old");
        let result = restore_archive(&target, &archive, Limits::default(), |_| {
            Err("stop failed".into())
        });
        assert_eq!(result.unwrap_err(), "stop failed");
        assert_eq!(fs::read(target.join("apps/voxa/data/old")).unwrap(), b"old");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    }
    #[test]
    fn partial_replacement_failure_rolls_back_all_directories() {
        let temp = temp();
        let (_, archive) = fixture(&temp.path);
        let target = temp.path.join("target");
        for p in DATA_DIRECTORIES {
            put(&target, &format!("{p}/old"), b"old");
        }
        let result = restore_archive(&target, &archive, Limits::default(), |_| {
            // Deterministic I/O fault in private test staging, after validation:
            // projects is replaced; dist's old files are moved; new dist fails.
            let scratch = fs::read_dir(&target)
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| {
                    p.is_dir()
                        && p.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with(".box-backup-")
                })
                .unwrap();
            fs::remove_dir_all(scratch.join("new/apps/local-engine/dist")).unwrap();
            Ok(())
        });
        assert!(result.unwrap_err().contains("previous data restored"));
        for p in DATA_DIRECTORIES {
            assert_eq!(fs::read(target.join(p).join("old")).unwrap(), b"old");
            assert!(!target.join(p).join("nested/new.txt").exists());
        }
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    }
    #[test]
    fn creation_never_overwrites_existing_archive() {
        let temp = temp();
        let (source, archive) = fixture(&temp.path);
        let old = fs::read(&archive).unwrap();
        assert!(create_archive(&source, &archive, Limits::default()).is_err());
        assert_eq!(fs::read(archive).unwrap(), old);
    }
    #[test]
    fn restore_creates_missing_directories_and_refuses_concurrent_lock() {
        let temp = temp();
        let (_, archive) = fixture(&temp.path);
        let target = temp.path.join("target");
        fs::create_dir(&target).unwrap();
        let lock = RestoreLock::new(&target).unwrap();
        assert!(restore_archive(&target, &archive, Limits::default(), |_| panic!()).is_err());
        drop(lock);
        restore_archive(&target, &archive, Limits::default(), |_| Ok(())).unwrap();
        for p in DATA_DIRECTORIES {
            assert!(target.join(p).join("nested/new.txt").exists());
        }
    }
    #[cfg(unix)]
    #[test]
    fn rejects_source_links_and_destination_symlink_ancestors() {
        use std::os::unix::fs::symlink;
        let temp = temp();
        let (source, archive) = fixture(&temp.path);
        let target = temp.path.join("target");
        fs::create_dir(&target).unwrap();
        symlink(source.join("apps"), target.join("apps")).unwrap();
        assert!(restore_archive(&target, &archive, Limits::default(), |_| panic!()).is_err());
        let data = source.join(DATA_DIRECTORIES[0]);
        symlink(data.join("nested/new.txt"), data.join("symlink")).unwrap();
        assert!(
            create_archive(&source, &temp.path.join("link.tar.gz"), Limits::default()).is_err()
        );
        fs::remove_file(data.join("symlink")).unwrap();
        fs::hard_link(data.join("nested/new.txt"), data.join("hardlink")).unwrap();
        assert!(
            create_archive(&source, &temp.path.join("hard.tar.gz"), Limits::default()).is_err()
        );
    }
    #[test]
    fn real_legacy_tar_with_dot_prefix_is_accepted() {
        let temp = temp();
        let (source, _) = fixture(&temp.path);
        fs::remove_file(source.join(".env")).unwrap();
        fs::write(source.join(README), README_TEXT).unwrap();
        for format in ["ustar", "gnutar"] {
            let archive = temp.path.join(format!("legacy-{format}.tar.gz"));
            // BSD tar calls it gnutar; GNU tar calls it gnu.
            let version = Command::new("tar").arg("--version").output().unwrap();
            let format = if format == "gnutar"
                && String::from_utf8_lossy(&version.stdout).contains("GNU tar")
            {
                "gnu"
            } else {
                format
            };
            assert!(Command::new("tar")
                .arg(format!("--format={format}"))
                .env_remove("TAR_OPTIONS")
                .env("COPYFILE_DISABLE", "1")
                .arg("-czf")
                .arg(&archive)
                .arg("-C")
                .arg(&source)
                .arg(".")
                .status()
                .unwrap()
                .success());
            assert_eq!(
                validate_archive(&archive, Limits::default()).unwrap().files,
                4
            );
            let target = temp.path.join(format!("restored-{format}"));
            fs::create_dir(&target).unwrap();
            restore_archive(&target, &archive, Limits::default(), |_| Ok(())).unwrap();
            assert_eq!(
                fs::read(target.join("apps/voxa/data/nested/new.txt")).unwrap(),
                b"new\0data\n"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn owner_write_only_source_is_backed_up_and_permissions_restored() {
        use std::os::unix::fs::PermissionsExt;
        let temp = temp();
        let source = temp.path.join("source");
        let relative = "apps/local-engine/projects/write-only.bin";
        put(&source, relative, b"owner-write-only");
        let file = source.join(relative);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o200)).unwrap();
        let archive = temp.path.join("permissions.tar.gz");
        create_archive(&source, &archive, Limits::default()).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o200
        );
        let target = temp.path.join("target");
        fs::create_dir(&target).unwrap();
        restore_archive(&target, &archive, Limits::default(), |_| Ok(())).unwrap();
        assert_eq!(
            fs::read(target.join(relative)).unwrap(),
            b"owner-write-only"
        );
        // A later creation failure must not leave the original permission relaxed.
        assert!(create_archive(
            &source,
            &temp.path.join("limited.tar.gz"),
            Limits {
                max_bytes: 1,
                max_entries: 1
            }
        )
        .is_err());
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o200
        );
    }

    fn zip_fixture(path: &Path, entries: &[(&str, &[u8])], method: zip::CompressionMethod) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(method);
        writer.start_file(README, options).unwrap();
        writer.write_all(README_TEXT.as_bytes()).unwrap();
        for (name, bytes) in entries {
            if name.ends_with('/') || name.ends_with('\\') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        writer.finish().unwrap();
    }
    #[test]
    fn legacy_zip_stored_deflated_windows_paths_and_metadata_round_trip() {
        let temp = temp();
        for method in [
            zip::CompressionMethod::Stored,
            zip::CompressionMethod::Deflated,
        ] {
            let archive = temp.path.join(format!("legacy-{method:?}.zip"));
            zip_fixture(
                &archive,
                &[
                    ("./apps/local-engine/projects/", b""),
                    ("./apps/local-engine/projects/地图.json", b"zip data"),
                    ("apps\\voxa\\data\\", b""),
                    ("apps\\voxa\\data\\empty.bin", b""),
                    ("__MACOSX/", b""),
                    ("__MACOSX/._BACKUP-README.txt", b"metadata"),
                    (
                        "__MACOSX/apps/local-engine/projects/._地图.json",
                        b"metadata",
                    ),
                ],
                method,
            );
            let info = validate_archive(&archive, Limits::default()).unwrap();
            assert_eq!(info.files, 2);
            let target = temp.path.join(format!("target-{method:?}"));
            put(&target, "apps/local-engine/projects/old", b"stale");
            restore_archive(&target, &archive, Limits::default(), |_| Ok(())).unwrap();
            assert_eq!(
                fs::read(target.join("apps/local-engine/projects/地图.json")).unwrap(),
                b"zip data"
            );
            assert!(!target.join("apps/local-engine/projects/old").exists());
            assert!(target.join("apps/voxa/data/empty.bin").is_file());
            assert!(!target.join("__MACOSX").exists());
        }
        let empty = temp.path.join("empty.zip");
        zip_fixture(&empty, &[], zip::CompressionMethod::Deflated);
        assert!(validate_archive(&empty, Limits::default())
            .unwrap()
            .directories
            .is_empty());
        restore_archive(&temp.path, &empty, Limits::default(), |_| {
            panic!("empty ZIP must not stop services")
        })
        .unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn actual_legacy_desktop_ditto_zip_is_readable() {
        let temp = temp();
        let source = temp.path.join("source");
        put(&source, README, README_TEXT.as_bytes());
        put(
            &source,
            "apps/local-engine/projects/地图.json",
            b"ditto payload",
        );
        let archive = temp.path.join("desktop.zip");
        assert!(Command::new("/usr/bin/ditto")
            .args(["-c", "-k", "--norsrc"])
            .arg(&source)
            .arg(&archive)
            .status()
            .unwrap()
            .success());
        let info = validate_archive(&archive, Limits::default()).unwrap();
        assert_eq!(info.files, 1);
        let target = temp.path.join("target");
        fs::create_dir(&target).unwrap();
        restore_archive(&target, &archive, Limits::default(), |_| Ok(())).unwrap();
        assert_eq!(
            fs::read(target.join("apps/local-engine/projects/地图.json")).unwrap(),
            b"ditto payload"
        );
    }
    #[test]
    fn new_pax_and_legacy_gnu_preserve_chinese_deep_long_paths() {
        let temp = temp();
        let source = temp.path.join("source");
        let folders = (0..5)
            .map(|n| format!("地图项目{n}-{}", "a".repeat(48)))
            .collect::<Vec<_>>()
            .join("/");
        let relative = format!(
            "apps/local-engine/projects/{folders}/{}.json",
            "中文长文件名".repeat(8)
        );
        assert!(relative.chars().count() > 255);
        assert!(relative.rsplit('/').next().unwrap().len() > 100);
        put(&source, &relative, b"long path payload");
        put(&source, README, README_TEXT.as_bytes());
        let archive = temp.path.join("new.tar.gz");
        create_archive(&source, &archive, Limits::default()).unwrap();
        let mut parsed = tar::Archive::new(MultiGzDecoder::new(File::open(&archive).unwrap()));
        assert!(parsed.entries().unwrap().raw(true).any(|e| e
            .unwrap()
            .header()
            .entry_type()
            .is_pax_local_extensions()));
        let target = temp.path.join("pax-target");
        fs::create_dir(&target).unwrap();
        restore_archive(&target, &archive, Limits::default(), |_| Ok(())).unwrap();
        assert_eq!(
            fs::read(target.join(&relative)).unwrap(),
            b"long path payload"
        );
        // Independently extract our PAX output with the system implementation.
        let extracted = temp.path.join("system-tar");
        fs::create_dir(&extracted).unwrap();
        assert!(Command::new("tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&extracted)
            .status()
            .unwrap()
            .success());
        assert_eq!(
            fs::read(extracted.join(&relative)).unwrap(),
            b"long path payload"
        );
        let gnu = temp.path.join("gnu.tar.gz");
        let version = Command::new("tar").arg("--version").output().unwrap();
        let format = if String::from_utf8_lossy(&version.stdout).contains("GNU tar") {
            "gnu"
        } else {
            "gnutar"
        };
        assert!(Command::new("tar")
            .arg(format!("--format={format}"))
            .env_remove("TAR_OPTIONS")
            .env("COPYFILE_DISABLE", "1")
            .arg("-czf")
            .arg(&gnu)
            .arg("-C")
            .arg(&source)
            .arg(".")
            .status()
            .unwrap()
            .success());
        let target = temp.path.join("gnu-target");
        fs::create_dir(&target).unwrap();
        restore_archive(&target, &gnu, Limits::default(), |_| Ok(())).unwrap();
        assert_eq!(
            fs::read(target.join(relative)).unwrap(),
            b"long path payload"
        );
    }
    #[test]
    fn zip_rejects_traversal_configuration_aliases_and_metadata_bypasses() {
        let temp = temp();
        let archive = temp.path.join("bad.zip");
        let target = temp.path.join("target");
        fs::create_dir(&target).unwrap();
        for name in [
            "../escape",
            "/absolute",
            "C:\\escape",
            "\\\\server\\escape",
            "apps\\voxa\\data\\..\\..\\escape",
            "apps/voxa/config",
            "__MACOSX/../../escape",
            "__MACOSX/payload",
            "__MACOSX/apps/local-engine/._.env",
            "__MACOSX/apps/voxa/data/._..",
        ] {
            zip_fixture(&archive, &[(name, b"bad")], zip::CompressionMethod::Stored);
            assert!(
                validate_archive(&archive, Limits::default()).is_err(),
                "{name}"
            );
            assert!(
                restore_archive(&target, &archive, Limits::default(), |_| panic!(
                    "invalid ZIP stopped services"
                ))
                .is_err()
            );
        }
        zip_fixture(&archive, &[(".env", b"S=1")], zip::CompressionMethod::Stored);
        assert!(validate_archive(&archive, Limits::default())
            .unwrap()
            .has_env);
        zip_fixture(
            &archive,
            &[
                ("apps/voxa/data/Foo/x", b"a"),
                ("apps/voxa/data/foo/y", b"b"),
            ],
            zip::CompressionMethod::Stored,
        );
        assert!(validate_archive(&archive, Limits::default()).is_err());
    }
    #[test]
    fn zip_rejects_symlinks_special_modes_crc_failure_and_limits() {
        let temp = temp();
        let archive = temp.path.join("bad.zip");
        for name in ["apps/voxa/data/link", "__MACOSX/apps/voxa/data/._link"] {
            let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file(README, options).unwrap();
            writer.write_all(README_TEXT.as_bytes()).unwrap();
            writer
                .add_symlink(name, "../../../../escape", options)
                .unwrap();
            writer.finish().unwrap();
            assert!(validate_archive(&archive, Limits::default()).is_err());
        }
        zip_fixture(
            &archive,
            &[("apps/voxa/data/file", b"bytes")],
            zip::CompressionMethod::Stored,
        );
        let valid = fs::read(&archive).unwrap();
        let mut parsed = zip::ZipArchive::new(File::open(&archive).unwrap()).unwrap();
        let file = parsed.by_name("apps/voxa/data/file").unwrap();
        let data_offset = file.data_start() as usize;
        let central_offset = file.central_header_start() as usize;
        for mode in [0o010644u32, 0o020644, 0o060644, 0o140644] {
            let mut bad = valid.clone();
            bad[central_offset + 38..central_offset + 42]
                .copy_from_slice(&(mode << 16).to_le_bytes());
            fs::write(&archive, bad).unwrap();
            assert!(validate_archive(&archive, Limits::default()).is_err());
        }
        let mut bad = valid.clone();
        bad[data_offset] ^= 0xff;
        fs::write(&archive, bad).unwrap();
        assert!(validate_archive(&archive, Limits::default()).is_err());
        fs::write(&archive, valid).unwrap();
        assert!(validate_archive(
            &archive,
            Limits {
                max_bytes: 1,
                max_entries: 100
            }
        )
        .is_err());
        assert!(validate_archive(
            &archive,
            Limits {
                max_bytes: 10000,
                max_entries: 1
            }
        )
        .is_err());
    }
    #[test]
    #[cfg(unix)]
    fn creation_is_independent_of_platform_tar_pax_metadata() {
        use std::os::unix::fs::PermissionsExt;
        let temp = temp();
        let source = temp.path.join("source");
        put(&source, "apps/voxa/data/file", b"actual source bytes");
        let platform_archive = temp.path.join("platform.tar.gz");
        pax_fixture(&platform_archive, "LIBARCHIVE.creationtime", b"1234.567");
        let bin = temp.path.join("bin");
        fs::create_dir(&bin).unwrap();
        let tar = bin.join("tar");
        fs::write(
            &tar,
            "#!/bin/sh\n/bin/cp \"$BOX_BACKUP_PLATFORM_ARCHIVE\" \"$3\"\n",
        )
        .unwrap();
        fs::set_permissions(&tar, fs::Permissions::from_mode(0o755)).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backup::tests::creation_without_platform_metadata_probe",
                "--nocapture",
            ])
            .env("PATH", bin)
            .env("BOX_BACKUP_PLATFORM_ARCHIVE", platform_archive)
            .env("BOX_BACKUP_PROBE_ROOT", source)
            .env("BOX_BACKUP_PROBE_ARCHIVE", temp.path.join("backup.tar.gz"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    #[cfg(unix)]
    fn creation_without_platform_metadata_probe() {
        let Some(root) = std::env::var_os("BOX_BACKUP_PROBE_ROOT") else {
            return;
        };
        let archive = PathBuf::from(std::env::var_os("BOX_BACKUP_PROBE_ARCHIVE").unwrap());
        let info = create_archive(Path::new(&root), &archive, Limits::default()).unwrap();
        assert_eq!(info.files, 1);
        assert_eq!(info.data_bytes, 19);
    }

    fn pax_fixture(path: &Path, key: &str, value: &[u8]) {
        let gzip = GzEncoder::new(File::create(path).unwrap(), Compression::default());
        let mut builder = tar::Builder::new(gzip);
        let mut h = tar::Header::new_ustar();
        h.set_mode(0o644);
        h.set_size(README_TEXT.len() as u64);
        h.set_cksum();
        builder
            .append_data(&mut h, README, README_TEXT.as_bytes())
            .unwrap();
        builder.append_pax_extensions([(key, value)]).unwrap();
        h.set_size(0);
        h.set_cksum();
        builder
            .append_data(&mut h, "apps/voxa/data/file", io::empty())
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }
    #[test]
    fn pax_and_gnu_extensions_cannot_bypass_effective_path_or_type_checks() {
        let temp = temp();
        let archive = temp.path.join("bad.tar.gz");
        for (key, value) in [
            ("path", &b"../escape"[..]),
            ("path", b"docker-compose.yml"),
            ("path", b"__MACOSX/../../escape"),
            ("linkpath", b"escape"),
            ("GNU.sparse.name", b"apps/voxa/data/file"),
            ("SCHILY.filetype", b"symlink"),
        ] {
            pax_fixture(&archive, key, value);
            assert!(
                validate_archive(&archive, Limits::default()).is_err(),
                "{key}"
            );
        }
        for kind in [b'L', b'K'] {
            raw_archive(
                &archive,
                &[
                    ("././@LongLink", kind, b"../../escape\0"),
                    ("apps/voxa/data/file", b'0', b""),
                ],
            );
            assert!(validate_archive(&archive, Limits::default()).is_err());
        }
        pax_fixture(&archive, "mtime", b"1234.567");
        assert!(validate_archive(&archive, Limits::default()).is_ok());
        // A metadata budget error occurs before tar can retain a huge extension.
        let huge = vec![b'a'; MAX_TAR_METADATA as usize + 1];
        raw_archive(
            &archive,
            &[
                ("././@LongLink", b'L', &huge),
                ("apps/voxa/data/file", b'0', b""),
            ],
        );
        assert!(validate_archive(&archive, Limits::default())
            .unwrap_err()
            .contains("metadata limit"));
    }

    #[test]
    fn uncompressed_tar_is_validated_restored_and_rejects_unsafe_entries() {
        let temp = temp();
        let (_, gzip) = fixture(&temp.path);
        let plain = temp.path.join("legacy.tar");
        io::copy(
            &mut MultiGzDecoder::new(File::open(&gzip).unwrap()),
            &mut File::create(&plain).unwrap(),
        )
        .unwrap();
        assert_eq!(
            validate_archive(&plain, Limits::default()).unwrap(),
            validate_archive(&gzip, Limits::default()).unwrap()
        );
        let target = temp.path.join("target");
        put(&target, "apps/local-engine/projects/old", b"stale");
        restore_archive(&target, &plain, Limits::default(), |_| Ok(())).unwrap();
        assert!(!target.join("apps/local-engine/projects/old").exists());
        assert_eq!(
            fs::read(target.join("apps/voxa/data/nested/new.txt")).unwrap(),
            b"new\0data\n"
        );
        raw_archive(&gzip, &[("../escape", b'0', b"bad")]);
        io::copy(
            &mut MultiGzDecoder::new(File::open(&gzip).unwrap()),
            &mut File::create(&plain).unwrap(),
        )
        .unwrap();
        assert!(
            restore_archive(&target, &plain, Limits::default(), |_| panic!(
                "unsafe raw tar stopped services"
            ))
            .is_err()
        );
    }

    #[test]
    fn duplicate_zip_member_cannot_hide_a_symlink_from_the_crate_inventory() {
        let temp = temp();
        let archive = temp.path.join("hidden.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file(README, options).unwrap();
        writer.write_all(README_TEXT.as_bytes()).unwrap();
        writer
            .add_symlink("apps/voxa/data/first", "../../escape", options)
            .unwrap();
        writer.start_file("apps/voxa/data/other", options).unwrap();
        writer.write_all(b"safe").unwrap();
        writer.finish().unwrap();
        let mut bytes = fs::read(&archive).unwrap();
        // Make both local and central-directory names duplicate without asking
        // ZipWriter to emit duplicates (it correctly refuses to do so).
        for i in 0..=bytes.len() - 5 {
            if &bytes[i..i + 5] == b"first" {
                bytes[i..i + 5].copy_from_slice(b"other");
            }
        }
        fs::write(&archive, bytes).unwrap();
        assert!(validate_archive(&archive, Limits::default())
            .unwrap_err()
            .contains("hidden ZIP member"));
    }
}
