//! Data contracts shared by the Tauri command implementations.
//!
//! These types intentionally contain no filesystem, Docker, or configuration
//! behavior. Keeping the serialization contract here lets `commands` focus on
//! orchestration while the frontend-facing shape remains explicit and stable.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineImageManifest {
    pub(crate) format_version: u8,
    pub(crate) archive: String,
    pub(crate) sha256: String,
    pub(crate) image_tag: String,
    pub(crate) platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AboutInfo {
    pub(crate) application_version: String,
    pub(crate) image_tag: String,
    pub(crate) source_revision: String,
    pub(crate) build_created_at: String,
    pub(crate) build_source: String,
    pub(crate) platform: String,
    pub(crate) architecture: String,
    pub(crate) license: String,
    pub(crate) service_images: Vec<ServiceImageInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceImageInfo {
    pub(crate) name: String,
    pub(crate) image: String,
    pub(crate) tag: String,
    pub(crate) platform: String,
    pub(crate) image_id: String,
    pub(crate) created_at: String,
    pub(crate) source_revision: String,
    pub(crate) build_source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedImageInfo {
    pub(crate) images: Vec<EmbeddedServiceImageInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedServiceImageInfo {
    pub(crate) image: String,
    pub(crate) tag: String,
    pub(crate) image_id: String,
    pub(crate) created_at: String,
    pub(crate) platform: String,
    pub(crate) source_revision: String,
    pub(crate) build_source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegalNotices {
    pub(crate) license_name: String,
    pub(crate) license_text: String,
}

pub(crate) use box_manager_core::services::ServiceStatus;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemStatus {
    pub(crate) docker_ready: bool,
    pub(crate) docker_cli_available: bool,
    pub(crate) docker_cli_version: String,
    pub(crate) docker_message: String,
    pub(crate) configured: bool,
    pub(crate) all_healthy: bool,
    pub(crate) services: Vec<ServiceStatus>,
    pub(crate) data_directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DockerCheck {
    pub(crate) cli_available: bool,
    pub(crate) cli_version: String,
    pub(crate) engine_ready: bool,
    pub(crate) message: String,
}

/// Safe per-project runtime data for the desktop UI. This deliberately omits
/// environment variables, credentials and arbitrary container diagnostics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRuntimeStatus {
    pub(crate) project_id: String,
    pub(crate) permanent_map_id: String,
    pub(crate) name: String,
    pub(crate) map_role: String,
    pub(crate) main_project_id: String,
    pub(crate) edit: RuntimeEndpointStatus,
    pub(crate) play: RuntimeEndpointStatus,
}

/// Runtime inventories are intentionally kept separate because Creator
/// projects and imported Play worlds are stored in different local libraries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRuntimeCatalog {
    pub(crate) creator: Vec<ProjectRuntimeStatus>,
    pub(crate) play: Vec<ProjectRuntimeStatus>,
    /// Published Play maps for configuration pickers. Unlike `play`, this is
    /// not restricted to maps that currently have a running instance.
    pub(crate) play_maps: Vec<ProjectRuntimeStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeEndpointStatus {
    pub(crate) phase: String,
    pub(crate) percent: u8,
    pub(crate) message: String,
    pub(crate) updated_at: String,
    pub(crate) cpu_percent: Option<f64>,
    pub(crate) memory_bytes: Option<u64>,
    pub(crate) uptime_ms: Option<u64>,
    pub(crate) process_count: u32,
    pub(crate) rooms: Vec<RuntimeRoomStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeRoomStatus {
    pub(crate) room_id: String,
    pub(crate) active: bool,
    pub(crate) created_at: u64,
    pub(crate) last_access_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServicePerformance {
    pub(crate) name: String,
    pub(crate) enabled: bool,
    pub(crate) running: bool,
    pub(crate) cpu_percent: f64,
    pub(crate) memory_usage: String,
    pub(crate) memory_limit: String,
    pub(crate) memory_percent: f64,
    pub(crate) pids: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PerformanceStatus {
    pub(crate) sampled_at: u128,
    pub(crate) services: Vec<ServicePerformance>,
}

pub(crate) use box_manager_core::backup_store::BackupInfo;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionTest {
    pub(crate) ok: bool,
    pub(crate) message: String,
}

pub(crate) use box_manager_core::services::InstallProgress;
