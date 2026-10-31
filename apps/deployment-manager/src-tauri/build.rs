use std::{env, fs, path::PathBuf};

fn main() {
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest directory"));
    let root_manifest = manifest.join("../../../package.json");
    println!("cargo:rerun-if-changed={}", root_manifest.display());
    let contents = fs::read_to_string(&root_manifest).expect("unable to read root package.json");
    let root_version = contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("\"version\": ").map(str::to_owned))
        .and_then(|value| {
            value
                .trim_matches(',')
                .trim_matches('"')
                .split_whitespace()
                .next()
                .map(str::to_owned)
        })
        .filter(|value| !value.is_empty())
        .expect("root package.json has no version");
    let version = env::var("BOX_BUILD_VERSION")
        .ok()
        .filter(|_| env::var("BOX_BUILD_CHANNEL").as_deref() == Ok("dev"))
        .unwrap_or(root_version);
    println!("cargo:rustc-env=BOX_ROOT_VERSION={version}");
    let project = if version.ends_with("-dev") {
        "box-local-engine-desktop-dev"
    } else if version.ends_with("-staging") {
        "box-local-engine-desktop-staging"
    } else {
        "box-local-engine-desktop"
    };
    println!("cargo:rustc-env=BOX_MANAGER_PROJECT_NAME={project}");
    for key in [
        "BOX_BUILD_CHANNEL",
        "BOX_BUILD_VERSION",
        "BOX_MANAGER_IMAGE_TAG",
        "BOX_MANAGER_REMOTE_IMAGE",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    tauri_build::build()
}
