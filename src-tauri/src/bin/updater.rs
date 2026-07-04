/// Standalone updater binary for mod-manager-v2.
///
/// Launched by the manager before it closes:
///   updater.exe --manager-pid <PID> --install-dir <dir> --app-url <url>
///
/// Flow:
///   1. Wait for the manager process (--manager-pid) to exit.
///   2. Download new mod-manager-v2.exe to a temp file, then replace the old one.
///   3. Re-launch mod-manager-v2.exe and exit.
///
/// The manager itself handles replacing update.exe after it relaunches.

use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;

use serde_json::{Map, Value};

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut install_dir: Option<PathBuf> = None;
    let mut manager_pid: Option<u32> = None;
    let mut app_url: Option<String> = None;
    let mut app_tag: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--install-dir" if i + 1 < args.len() => {
                install_dir = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--manager-pid" if i + 1 < args.len() => {
                manager_pid = args[i + 1].parse().ok();
                i += 2;
            }
            "--app-url" if i + 1 < args.len() => {
                app_url = Some(args[i + 1].clone());
                i += 2;
            }
            "--app-tag" if i + 1 < args.len() => {
                app_tag = Some(args[i + 1].clone());
                i += 2;
            }
            // Accept but ignore --updater-url (manager handles its own updater refresh)
            "--updater-url" if i + 1 < args.len() => {
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    // Determine install dir from current exe location if not provided
    let install_dir = install_dir.unwrap_or_else(|| {
        env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    });

    // Step 1: Wait for the manager to fully exit
    if let Some(pid) = manager_pid {
        log_line(&install_dir, &format!("Waiting for manager PID {pid} to exit..."));
        wait_for_process_exit(pid);
        log_line(&install_dir, "Manager exited.");
    } else {
        // No PID supplied — give the manager a moment to close
        thread::sleep(Duration::from_secs(2));
    }

    // Step 2: Download and replace mod-manager-v2.exe
    if let Some(ref url) = app_url {
        log_line(&install_dir, &format!("Downloading new app from {url}"));
        let target = install_dir.join("mod-manager-v2.exe");
        let temp = install_dir.join("mod-manager-v2.exe.new");
        if download_file(url, &temp) {
            match replace_with_retries(&temp, &target) {
                Ok(_) => {
                    log_line(&install_dir, "Replaced mod-manager-v2.exe");
                    if let Some(tag) = app_tag.as_ref() {
                        let _ = write_installed_app_tag(&install_dir, tag);
                    }
                }
                Err(e) => {
                    log_line(&install_dir, &format!("Failed to replace app exe: {e}"));
                    let _ = std::fs::remove_file(&temp);
                }
            }
        } else {
            log_line(&install_dir, "App download failed — keeping existing exe.");
        }
    } else {
        log_line(&install_dir, "No --app-url provided; skipping app download.");
    }

    // Step 3: Re-launch manager (manager will handle updating update.exe itself)
    let manager_exe = install_dir.join("mod-manager-v2.exe");
    if manager_exe.exists() {
        log_line(&install_dir, &format!("Relaunching {}", manager_exe.display()));
        let _ = Command::new(&manager_exe)
            .current_dir(&install_dir)
            .spawn();
    } else {
        log_line(
            &install_dir,
            &format!(
                "mod-manager-v2.exe not found at {}; cannot relaunch.",
                install_dir.display()
            ),
        );
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Poll tasklist until the given PID disappears (max 60 s).
fn wait_for_process_exit(pid: u32) {
    for _ in 0..600 {
        if !is_process_running(pid) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    eprintln!("[updater] Timed out waiting for PID {}", pid);
}

fn is_process_running(pid: u32) -> bool {
    let output = Command::new("tasklist")
        .args([
            "/FI",
            &format!("PID eq {}", pid),
            "/NH",
            "/FO",
            "CSV",
        ])
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains(&pid.to_string())
        }
        Err(_) => false,
    }
}

fn download_file(url: &str, dest: &PathBuf) -> bool {
    let status = Command::new("curl")
        .args([
            "-L",
            "--fail",
            "-o",
            dest.to_str().unwrap_or("download_tmp"),
            url,
        ])
        .status();
    matches!(status, Ok(s) if s.success())
}

fn log_line(install_dir: &PathBuf, message: &str) {
    eprintln!("[updater] {message}");
    let log_path = install_dir.join("updater.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[updater] {message}");
    }
}

fn replace_with_retries(temp: &PathBuf, target: &PathBuf) -> Result<(), String> {
    for _ in 0..120 {
        let _ = fs::remove_file(target);
        if fs::rename(temp, target).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }

    // Last chance: copy-over if rename keeps failing.
    fs::copy(temp, target)
        .map_err(|e| format!("rename/copy failed for {}: {e}", target.display()))?;
    let _ = fs::remove_file(temp);
    Ok(())
}

fn normalize_release_tag(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string()
}

fn write_installed_app_tag(install_dir: &PathBuf, tag: &str) -> Result<(), String> {
    let normalized = normalize_release_tag(tag);
    if normalized.is_empty() {
        return Ok(());
    }

    let resources_dir = install_dir.join("resources");
    let settings_path = resources_dir.join("settings.json");

    let mut settings = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));

    if !settings.is_object() {
        settings = Value::Object(Map::new());
    }

    if let Value::Object(map) = &mut settings {
        map.insert(
            "last_app_release_tag".to_string(),
            Value::String(normalized.clone()),
        );
        map.insert("last_release_tag".to_string(), Value::String(normalized));
        // Clear the update check cache so the freshly-launched manager hits
        // the API instead of serving a stale "update available" result.
        map.remove("update_check_ts");
        map.remove("update_check_result");
        // Also strip old key names written by previous versions.
        map.remove("last_update_check_ts");
        map.remove("last_update_check_result");
    }

    std::fs::create_dir_all(&resources_dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, body).map_err(|e| e.to_string())?;
    Ok(())
}


