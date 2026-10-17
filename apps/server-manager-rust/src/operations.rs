//! Bounded progress records for authenticated HTTP commands. No worker or
//! request is held while a client polls. Finished records expire after 5 min.
use box_manager_core::services::{ImageDownloadProgress, InstallProgress};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};

struct Record {
    progress: InstallProgress,
    downloads: BTreeMap<String, ImageDownloadProgress>,
    updated: Instant,
    finished: bool,
}
pub struct Operations(Mutex<BTreeMap<String, Record>>, tokio::sync::broadcast::Sender<(String, InstallProgress)>);
impl Default for Operations {
    fn default() -> Self { Self(Mutex::new(BTreeMap::new()), tokio::sync::broadcast::channel(256).0) }
}
impl Operations {
    pub fn begin(&self, id: &str) -> Result<(), String> {
        if !(16..=80).contains(&id.len())
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err("任务标识无效".into());
        }
        let mut records = self.0.lock().map_err(|_| "任务进度不可用")?;
        records.retain(|_, r| !r.finished || r.updated.elapsed() < Duration::from_secs(300));
        if records.contains_key(id) {
            return Err("任务标识已使用，请重新发起操作".into());
        }
        if records.len() >= 256 {
            let oldest = records
                .iter()
                .filter(|(_, r)| r.finished)
                .min_by_key(|(_, r)| r.updated)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                records.remove(&id);
            } else {
                return Err("正在执行的任务过多，请稍后重试".into());
            }
        }
        records.insert(
            id.into(),
            Record {
                progress: InstallProgress {
                    stage: "queued".into(),
                    message: "正在准备操作…".into(),
                    percent: 0,
                    downloads: None,
                },
                downloads: BTreeMap::new(),
                updated: Instant::now(),
                finished: false,
            },
        );
        if let Some(record) = records.get(id) { let _ = self.1.send((id.into(), record.progress.clone())); }
        Ok(())
    }
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<(String, InstallProgress)> { self.1.subscribe() }
    pub fn update(&self, id: &str, stage: &str, message: &str, percent: u8, finished: bool) {
        if let Ok(mut records) = self.0.lock() {
            if let Some(record) = records.get_mut(id) {
                if record.finished {
                    return;
                }
                record.progress = InstallProgress {
                    stage: stage.into(),
                    message: message.into(),
                    percent: percent.min(100),
                    downloads: None,
                };
                record.downloads.clear();
                record.updated = Instant::now();
                record.finished = finished;
                let _ = self.1.send((id.into(), record.progress.clone()));
            }
        }
    }
    pub fn update_download(&self, id: &str, image: &str, bytes: u64, total: u64) {
        if let Ok(mut records) = self.0.lock() {
            if let Some(record) = records.get_mut(id) {
                if record.finished {
                    return;
                }
                let total = total.max(1);
                let bytes = bytes.min(total);
                let percent = (bytes.saturating_mul(100) / total).min(99) as u8;
                if record
                    .downloads
                    .get(image)
                    .is_some_and(|previous| previous.percent == percent)
                {
                    return;
                }
                record.downloads.insert(
                    image.to_owned(),
                    ImageDownloadProgress {
                        image: image.to_owned(),
                        bytes,
                        total,
                        percent,
                    },
                );
                let rows = record.downloads.values().cloned().collect::<Vec<_>>();
                record.progress = InstallProgress::for_downloads(rows);
                record.updated = Instant::now();
                let _ = self.1.send((id.to_owned(), record.progress.clone()));
            }
        }
    }
    pub fn begin_downloads(&self, id: &str, rows: Vec<ImageDownloadProgress>) {
        if rows.is_empty() { return; }
        if let Ok(mut records) = self.0.lock() {
            if let Some(record) = records.get_mut(id).filter(|record| !record.finished) {
                record.downloads = rows.iter().map(|row| (row.image.clone(), row.clone())).collect();
                record.progress = InstallProgress::for_downloads(rows);
                record.updated = Instant::now();
                let _ = self.1.send((id.to_owned(), record.progress.clone()));
            }
        }
    }
    pub fn complete_download(&self, id: &str, image: &str) {
        if let Ok(mut records) = self.0.lock() {
            if let Some(record) = records.get_mut(id).filter(|record| !record.finished) {
                if let Some(row) = record.downloads.get_mut(image) {
                    row.bytes = row.total;
                    row.percent = 100;
                    record.progress = InstallProgress::for_downloads(record.downloads.values().cloned().collect());
                    record.updated = Instant::now();
                    let _ = self.1.send((id.to_owned(), record.progress.clone()));
                }
            }
        }
    }
    pub fn get(&self, id: &str) -> Option<InstallProgress> {
        let mut records = self.0.lock().ok()?;
        if records
            .get(id)
            .is_some_and(|r| r.finished && r.updated.elapsed() >= Duration::from_secs(300))
        {
            records.remove(id);
        }
        records.get(id).map(|r| r.progress.clone())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolates_operations_and_keeps_final_result() {
        let records = Operations::default();
        let a = "operation-00000001";
        let b = "operation-00000002";
        records.begin(a).unwrap();
        records.begin(b).unwrap();
        records.update(a, "database", "starting", 45, false);
        assert_eq!(records.get(a).unwrap().percent, 45);
        assert_eq!(records.get(b).unwrap().percent, 0);
        records.update(a, "error", "failed", 100, true);
        records.update(a, "start", "late event", 65, false);
        assert_eq!(records.get(a).unwrap().stage, "error");
        assert!(records.begin(a).is_err());
        assert!(records.begin("../invalid").is_err());
    }
    #[test]
    fn expires_completed_operations() {
        let records = Operations::default();
        let id = "operation-00000003";
        records.begin(id).unwrap();
        records.update(id, "complete", "done", 100, true);
        records.0.lock().unwrap().get_mut(id).unwrap().updated =
            Instant::now() - Duration::from_secs(301);
        assert!(records.get(id).is_none());
    }
    #[test]
    fn download_counts_stay_fixed_and_complete_only_after_verification() {
        let records = Operations::default();
        let id = "operation-download-shared";
        records.begin(id).unwrap();
        records.begin_downloads(id, ["box-local-engine-voxa", "box-local-engine-creator"].iter().map(|image| ImageDownloadProgress { image: (*image).into(), bytes: 0, total: 100, percent: 0 }).collect());
        assert_eq!(records.get(id).unwrap().message, "2 个镜像 · 已完成 0/2");
        records.update_download(id, "box-local-engine-creator", 100, 100);
        let pending = records.get(id).unwrap();
        assert_eq!(pending.downloads.unwrap()[0].percent, 99);
        assert_eq!(pending.message, "2 个镜像 · 已完成 0/2");
        records.complete_download(id, "box-local-engine-creator");
        assert_eq!(records.get(id).unwrap().message, "2 个镜像 · 已完成 1/2");
        records.update_download(id, "box-local-engine-voxa", 100, 100);
        assert_eq!(records.get(id).unwrap().percent, 99);
        records.complete_download(id, "box-local-engine-voxa");
        let complete = records.get(id).unwrap();
        assert_eq!(complete.percent, 100);
        assert_eq!(complete.message, "2 个镜像 · 已完成 2/2");
        assert_eq!(complete.downloads.unwrap()[0].image, "box-local-engine-creator");
    }
}
