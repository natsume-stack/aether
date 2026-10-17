//! Shared schema and validation for owner-managed Play map runtime policies.
//!
//! Both the desktop (Tauri) manager and the headless Web manager persist these
//! values in their deployment data directory. Keeping this module independent
//! of filesystem and UI concerns guarantees that they accept the same policy.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapRuntimeProfile {
    pub permanent_map_id: String,
    pub mode: String,
    pub player_limit: u32,
    pub room_limit: u32,
    pub idle_timeout_ms: u64,
    pub cpu_milli: Option<u32>,
    pub memory_mb: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MapRuntimeProfilesFile {
    pub version: u8,
    pub profiles: Vec<MapRuntimeProfile>,
}

impl Default for MapRuntimeProfilesFile {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: vec![],
        }
    }
}

pub fn valid_permanent_map_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

pub fn validate_map_runtime_profile(profile: &MapRuntimeProfile) -> Result<(), String> {
    if !valid_permanent_map_id(&profile.permanent_map_id) {
        return Err("地图永久 ID 格式无效".into());
    }
    if profile.mode != "play" {
        return Err("地图容器配置仅支持游玩端".into());
    }
    if !(1..=10_000).contains(&profile.player_limit) {
        return Err("人数上限必须在 1 到 10000 之间".into());
    }
    if !(1..=10_000).contains(&profile.room_limit) {
        return Err("房间上限必须在 1 到 10000 之间".into());
    }
    if !(1_000..=604_800_000).contains(&profile.idle_timeout_ms) {
        return Err("无用户时存活时间必须在 1000 到 604800000 ms 之间".into());
    }
    if profile
        .cpu_milli
        .is_some_and(|value| !(1..=128_000).contains(&value))
    {
        return Err("CPU 上限必须在 1 到 128000 m 之间".into());
    }
    if profile
        .memory_mb
        .is_some_and(|value| !(64..=1_048_576).contains(&value))
    {
        return Err("内存上限必须在 64 到 1048576 MB 之间".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn play_profile_validation_has_one_policy_for_all_managers() {
        let valid = MapRuntimeProfile {
            permanent_map_id: "demo-map-1".into(),
            mode: "play".into(),
            player_limit: 1,
            room_limit: 1,
            idle_timeout_ms: 1_000,
            cpu_milli: Some(1),
            memory_mb: Some(64),
        };
        assert!(validate_map_runtime_profile(&valid).is_ok());
        assert!(!valid_permanent_map_id("Demo_map"));
        assert!(validate_map_runtime_profile(&MapRuntimeProfile {
            mode: "creator".into(),
            ..valid
        })
        .is_err());
    }
}
