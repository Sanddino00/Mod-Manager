// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn set_windows_app_user_model_id() {
    use std::iter;
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let app_id: Vec<u16> = "com.sandrino.mod-manager-v2"
        .encode_utf16()
        .chain(iter::once(0))
        .collect();

    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    set_windows_app_user_model_id();

    mod_manager_v2_lib::run()
}
