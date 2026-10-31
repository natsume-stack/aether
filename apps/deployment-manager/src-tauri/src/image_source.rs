//! Download sources are pinned by the installer and never fall back across channels.
pub(crate) fn download_url(base: Option<&str>, archive: &str) -> Result<String, String> {
    box_manager_core::release_channel::image_download_url(base, archive)
}
