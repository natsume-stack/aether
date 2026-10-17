// A release launcher is a graphical application. Without this linker setting
// Windows starts a visible console window alongside the Tauri window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    box_local_engine_manager_lib::run();
}
