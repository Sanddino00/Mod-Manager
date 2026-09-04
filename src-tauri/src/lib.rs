use base64::Engine;
use ddsfile::Dds;
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{image::Image, Emitter, Listener, LogicalPosition, LogicalSize, Manager, Position, Size};
use tauri_plugin_opener::OpenerExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const DEFAULT_VERSION: &str = "1.2.3";
const APP_RELEASES_API: &str = "https://api.github.com/repos/Sanddino00/Mod-Manager/releases/latest";
const RESOURCES_RELEASES_API: &str =
    "https://api.github.com/repos/Sanddino00/Resources-for-Fixmanager-and-Modmanager/releases/latest";
const CUSTOM_FIXES_DIR_NAME: &str = "custom fixes";
const STOCK_GAME_KEYS: [&str; 5] = ["gi", "hsr", "wuwa", "zzz", "end"];
const ICON_DIR_CANDIDATES: [&str; 3] = ["Icon", "Icons", "icons"];
const DEV_BACKGROUND_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

#[derive(Debug, Serialize)]
struct LegacyInstall {
    base_dir: String,
    resources_dir: String,
    settings_path: String,
}

#[derive(Debug, Serialize)]
struct BootstrapState {
    legacy_install: Option<LegacyInstall>,
    settings: Value,
    settings_found: bool,
    detected_paths: Vec<String>,
    app_version: String,
    needs_setup: bool,
    exe_dir: String,
}

#[derive(Debug, Serialize)]
struct ModEntrySummary {
    name: String,
    display_name: String,
    path: String,
    disabled: bool,
    time_added_epoch: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ItemScanSummary {
    item_id: String,
    path: String,
    total_mods: usize,
    enabled_mods: usize,
    disabled_mods: usize,
    mods: Vec<ModEntrySummary>,
}

#[derive(Debug, Serialize)]
struct CategoryScanSummary {
    category: String,
    folder_path: String,
    exists: bool,
    total_items: usize,
    total_mods: usize,
    enabled_mods: usize,
    disabled_mods: usize,
    items: Vec<ItemScanSummary>,
}

#[derive(Debug, Serialize)]
struct GameScanSummary {
    game: String,
    mod_root: String,
    exists: bool,
    total_items: usize,
    total_mods: usize,
    enabled_mods: usize,
    disabled_mods: usize,
    categories: Vec<CategoryScanSummary>,
}

#[derive(Debug, Serialize)]
struct ItemCatalogEntry {
    id: String,
    name: String,
    path: String,
    exists: bool,
    favorite: bool,
    is_custom: bool,
    total_mods: usize,
    enabled_mods: usize,
    disabled_mods: usize,
    icon_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct CategoryInventorySummary {
    category: String,
    folder_path: String,
    exists: bool,
    items: Vec<ItemCatalogEntry>,
}

#[derive(Debug, Serialize)]
struct GameInventorySummary {
    game: String,
    mod_root: String,
    categories: Vec<CategoryInventorySummary>,
}

#[derive(Debug, Serialize)]
struct ItemModsSummary {
    game: String,
    category: String,
    item_id: String,
    item_name: String,
    path: String,
    exists: bool,
    total_mods: usize,
    enabled_mods: usize,
    disabled_mods: usize,
    mods: Vec<ModEntrySummary>,
}

#[derive(Debug, Serialize)]
struct FixScriptSummary {
    name: String,
    kind: String,
}

#[derive(Debug, Serialize)]
struct FixesPanelData {
    game: String,
    info_text: String,
    scripts: Vec<FixScriptSummary>,
}

#[derive(Debug, Serialize)]
struct IniToggleVar {
    name: String,
    values: Vec<String>,
}

#[derive(Debug, Serialize)]
struct IniToggleEntry {
    name: String,
    key: String,
    back: Option<String>,
    vars: Vec<IniToggleVar>,
}

#[derive(Debug, Serialize)]
struct ModDetailSummary {
    mod_path: String,
    ini_path: Option<String>,
    toggles: Vec<IniToggleEntry>,
}

#[derive(Debug, Serialize)]
struct DownloadInstallResult {
    installed_path: String,
    destination_path: String,
    preview_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct PreviewBuildResult {
    model_path: Option<String>,
    diffuse_texture_path: Option<String>,
    texture_bindings: HashMap<String, String>,
    metadata_path: String,
    recipe_path: String,
    toggle_count: usize,
    message: String,
}

const CATEGORY_KEYS: [&str; 6] = [
    "characters",
    "weapons",
    "ui",
    "objects",
    "npcs",
    "buffervalues",
];

static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

fn is_valid_window_position(x: f64, y: f64) -> bool {
    x.is_finite() && y.is_finite() && x > -30000.0 && y > -30000.0
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let tick = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}_{tick}_{counter}"))
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn local_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn install_path_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("install_path.json"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("install_path.json"));
        }
    }

    if let Some(base) = get_appdata_base() {
        candidates.push(base.join("install_path.json"));
    }

    candidates
}

fn read_install_path_document() -> Option<(PathBuf, Value)> {
    for candidate in install_path_file_candidates() {
        let raw = fs::read_to_string(&candidate).ok()?;
        let value = serde_json::from_str::<Value>(&raw).ok()?;
        return Some((candidate, value));
    }
    None
}

fn write_install_path_document(body: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(body).map_err(|err| err.to_string())?;

    let candidate = install_path_file_candidates()
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("install_path.json"));

    if let Some(parent) = candidate.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    fs::write(&candidate, &serialized).map_err(|err| err.to_string())?;
    Ok(())
}

fn write_install_path_file(install_base: &Path) -> Result<(), String> {
    let mut body = read_install_path_document()
        .map(|(_, value)| value)
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !body.is_object() {
        body = Value::Object(Map::new());
    }

    if let Value::Object(map) = &mut body {
        map.insert(
            "install_path".to_string(),
            Value::String(normalize_path(install_base)),
        );
    }

    write_install_path_document(&body)?;

    Ok(())
}

fn background_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(target_os = "windows")]
fn create_desktop_shortcut(target_exe: &Path, working_dir: &Path) -> Result<(), String> {
    let user_profile = std::env::var("USERPROFILE").map_err(|err| err.to_string())?;
    let desktop = PathBuf::from(user_profile).join("Desktop");
    let shortcut = desktop.join("Mod Manager v2.lnk");

    let target = local_path(target_exe).replace('"', "\"\"");
    let workdir = local_path(working_dir).replace('"', "\"\"");
    let shortcut_path = local_path(&shortcut).replace('"', "\"\"");

    let command = format!(
        "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut(\"{shortcut_path}\"); $Shortcut.TargetPath = \"{target}\"; $Shortcut.WorkingDirectory = \"{workdir}\"; $Shortcut.Save()"
    );

    let status = background_command("powershell")
        .args(["-NoProfile", "-Command", &command])
        .status()
        .map_err(|err| err.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to create desktop shortcut".to_string())
    }
}

#[cfg(target_os = "windows")]
fn desktop_shortcut_path() -> Result<PathBuf, String> {
    let user_profile = std::env::var("USERPROFILE").map_err(|err| err.to_string())?;
    Ok(PathBuf::from(user_profile)
        .join("Desktop")
        .join("Mod Manager v2.lnk"))
}

#[cfg(not(target_os = "windows"))]
fn desktop_shortcut_path() -> Result<PathBuf, String> {
    Ok(PathBuf::from("Mod Manager v2"))
}

#[cfg(not(target_os = "windows"))]
fn create_desktop_shortcut(_target_exe: &Path, _working_dir: &Path) -> Result<(), String> {
    Ok(())
}

fn category_folder_name(category: &str) -> &str {
    if category.eq_ignore_ascii_case("buffervalues") {
        "BufferValues"
    } else {
        category
    }
}

fn build_item_folder_path(base_path: &Path, category: &str, item_id: Option<&str>) -> PathBuf {
    let category_path = base_path.join(category_folder_name(category));

    if category.eq_ignore_ascii_case("buffervalues")
        && item_id.is_none_or(|value| value.eq_ignore_ascii_case("__root__"))
    {
        return category_path;
    }

    match item_id {
        Some(value) => category_path.join(value),
        None => category_path,
    }
}

fn get_appdata_base() -> Option<PathBuf> {
    std::env::var("APPDATA")
        .ok()
        .map(|appdata| PathBuf::from(appdata).join("mod-manager-v2"))
}

fn read_install_path_from_file(path: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    let install_path = value.get("install_path").and_then(Value::as_str)?.trim();
    if install_path.is_empty() {
        return None;
    }
    Some(PathBuf::from(install_path))
}


fn local_install_base() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("install_path.json"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("install_path.json"));
    }

    candidates
        .into_iter()
        .find_map(|candidate| read_install_path_from_file(&candidate))
}

fn resolve_install_base() -> Option<PathBuf> {
    local_install_base().or_else(get_appdata_base)
}

fn default_resources_dir() -> Result<PathBuf, String> {
    if let Some(base) = resolve_install_base() {
        return Ok(base.join("resources"));
    }
    Ok(std::env::current_dir()
        .map_err(|err| err.to_string())?
        .join("resources"))
}

fn resolve_resources_dir() -> Result<PathBuf, String> {
    if let Some(install) = detect_legacy_install() {
        return Ok(PathBuf::from(install.resources_dir));
    }

    default_resources_dir()
}

fn read_json_value(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

fn read_json_array(path: &Path) -> Vec<Value> {
    match read_json_value(path) {
        Some(Value::Array(values)) => values,
        _ => Vec::new(),
    }
}

fn favorites_file_path(resources_dir: &Path, game: &str) -> PathBuf {
    resources_dir.join(format!("{game}_fav_char.json"))
}

fn read_favorites(resources_dir: &Path, game: &str, settings: &Value) -> BTreeSet<String> {
    let per_game_path = favorites_file_path(resources_dir, game);
    let per_game_values = read_json_array(&per_game_path);

    if !per_game_values.is_empty() {
        return per_game_values
            .into_iter()
            .filter_map(|entry| entry.as_str().map(|value| value.to_string()))
            .collect();
    }

    settings
        .get("favorites")
        .and_then(|value| value.get(game))
        .and_then(Value::as_array)
        .into_iter()
        .flat_map(|entries| entries.iter())
        .filter_map(|entry| entry.as_str().map(|value| value.to_string()))
        .collect()
}

fn extract_item_name(value: &Value, fallback: &str) -> String {
    value
        .get("name")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| fallback.to_string())
}

fn extract_item_id(value: &Value) -> Option<String> {
    value
        .get("id")
        .and_then(Value::as_str)
        .map(|item_id| item_id.trim().to_string())
        .filter(|item_id| !item_id.is_empty())
}

fn collect_category_items(
    resources_dir: &Path,
    settings: &Value,
    game: &str,
    category: &str,
) -> Vec<(String, String, bool, bool)> {
    if category.eq_ignore_ascii_case("buffervalues") {
        return vec![(
            "__root__".to_string(),
            "BufferValues".to_string(),
            false,
            false,
        )];
    }

    let builtin_entries = read_json_array(&resources_dir.join(format!("{category}_{game}.json")));
    let custom_entries = if category.eq_ignore_ascii_case("characters") {
        read_json_array(&resources_dir.join(format!("addedCharacters_{game}.json")))
    } else {
        vec![]
    };

    let favorites = read_favorites(resources_dir, game, settings);
    let mut deduped = BTreeSet::new();
    let mut items = builtin_entries
        .into_iter()
        .map(|entry| (entry, false))
        .chain(custom_entries.into_iter().map(|entry| (entry, true)))
        .filter_map(|(entry, is_custom)| {
            let id = extract_item_id(&entry)?;
            if !deduped.insert(id.clone()) {
                return None;
            }

            let name = extract_item_name(&entry, &id);
            let favorite = favorites.contains(&id);
            Some((id, name, favorite, is_custom))
        })
        .collect::<Vec<_>>();

    items.sort_by(|left, right| {
        left.2
            .cmp(&right.2)
            .reverse()
            .then_with(|| left.1.to_lowercase().cmp(&right.1.to_lowercase()))
    });

    items
}

fn load_settings_snapshot() -> Result<Value, String> {
    if let Some(install) = detect_legacy_install() {
        return Ok(load_settings_from_install(&install).0);
    }

    if let Some(base) = resolve_install_base() {
        let resources = base.join("resources");
        let settings_path = resources.join("settings.json");
        if settings_path.is_file() {
            let mock_install = LegacyInstall {
                base_dir: normalize_path(&base),
                resources_dir: normalize_path(&resources),
                settings_path: normalize_path(&settings_path),
            };
            return Ok(load_settings_from_install(&mock_install).0);
        }
    }

    let base_dir = resolve_install_base().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });
    Ok(default_settings(&base_dir))
}

fn load_fixes_info_text(resources_dir: &Path) -> String {
    let info_path = resources_dir.join("info.json");

    match read_json_value(&info_path) {
        Some(Value::Object(map)) => map
            .get("info")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                serde_json::to_string_pretty(&Value::Object(map)).unwrap_or_default()
            }),
        Some(value) => serde_json::to_string_pretty(&value).unwrap_or_default(),
        None => "(No info.json found in resources)".to_string(),
    }
}

fn find_first_ini_file(mod_folder_path: &Path) -> Option<PathBuf> {
    // Fast path for large merged packs: root-level merged ini is usually authoritative.
    let preferred_root = ["merged.ini", "---merged.ini", "---merged - kopie.ini"];
    for name in preferred_root {
        let candidate = mod_folder_path.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    if let Ok(entries) = fs::read_dir(mod_folder_path) {
        let mut root_ini_files = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_file()
                    && path
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("ini"))
            })
            .collect::<Vec<_>>();

        root_ini_files.sort_by(|left, right| {
            let left_name = left
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let right_name = right
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();

            let left_rank = if left_name == "merged.ini" {
                0
            } else if left_name.contains("merged") {
                1
            } else {
                2
            };
            let right_rank = if right_name == "merged.ini" {
                0
            } else if right_name.contains("merged") {
                1
            } else {
                2
            };

            left_rank.cmp(&right_rank).then_with(|| left_name.cmp(&right_name))
        });

        if let Some(root_ini) = root_ini_files.into_iter().next() {
            return Some(root_ini);
        }
    }

    let mut stack = vec![mod_folder_path.to_path_buf()];

    while let Some(current_dir) = stack.pop() {
        let mut subdirs = Vec::new();
        let mut ini_files = Vec::new();

        for entry in fs::read_dir(&current_dir).ok()?.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                subdirs.push(path);
            } else if path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("ini"))
            {
                ini_files.push(path);
            }
        }

        subdirs.sort();
        subdirs.retain(|path| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            name != "preview_build"
        });
        ini_files.sort();

        if let Some(first_ini) = ini_files.into_iter().next() {
            return Some(first_ini);
        }

        subdirs.reverse();
        stack.extend(subdirs);
    }

    None
}

fn extract_ini_toggle_entries(ini_path: &Path) -> Vec<IniToggleEntry> {
    let bytes = match fs::read(ini_path) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let content = String::from_utf8_lossy(&bytes);

    let mut toggles = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_key: Option<String> = None;
    let mut current_back: Option<String> = None;
    let mut current_vars: Vec<IniToggleVar> = Vec::new();

    let flush = |toggles: &mut Vec<IniToggleEntry>,
                 current_name: &mut Option<String>,
                 current_key: &mut Option<String>,
                 current_back: &mut Option<String>,
                 current_vars: &mut Vec<IniToggleVar>| {
        if let (Some(name), Some(key)) = (current_name.take(), current_key.take()) {
            toggles.push(IniToggleEntry {
                name,
                key,
                back: current_back.take(),
                vars: std::mem::take(current_vars),
            });
        } else {
            current_name.take();
            current_key.take();
            current_back.take();
            current_vars.clear();
        }
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            flush(
                &mut toggles,
                &mut current_name,
                &mut current_key,
                &mut current_back,
                &mut current_vars,
            );
            let section_name = &trimmed[1..trimmed.len().saturating_sub(1)];
            if section_name.to_ascii_lowercase().starts_with("key") {
                current_name = Some(section_name.to_string());
            }
            continue;
        }

        if current_name.is_none() {
            continue;
        }

        if let Some((left, right)) = trimmed.split_once('=') {
            let field = left.trim().to_ascii_lowercase();
            let value = right.trim().to_string();
            if field == "key" {
                current_key = Some(value);
            } else if field == "back" {
                current_back = Some(value);
            } else if field.starts_with('$') {
                let values = value
                    .split(',')
                    .map(|entry| entry.trim().to_string())
                    .filter(|entry| !entry.is_empty())
                    .collect::<Vec<_>>();
                if !values.is_empty() {
                    current_vars.push(IniToggleVar {
                        name: field,
                        values,
                    });
                }
            }
        }
    }

    flush(
        &mut toggles,
        &mut current_name,
        &mut current_key,
        &mut current_back,
        &mut current_vars,
    );
    toggles
}

fn scan_mod_entries(folder: &Path) -> Vec<ModEntrySummary> {
    fn directory_added_epoch(path: &Path) -> Option<u64> {
        let metadata = fs::metadata(path).ok()?;
        let timestamp = metadata
            .created()
            .ok()
            .or_else(|| metadata.modified().ok())?;
        timestamp
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|value| value.as_secs())
    }

    let mut mods = fs::read_dir(folder)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            let path = entry.path();

            if !path.is_dir() {
                return None;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let disabled = name.starts_with("DISABLED_");
            let display_name = name.replacen("DISABLED_", "", 1);

            Some(ModEntrySummary {
                name,
                display_name,
                path: normalize_path(&path),
                disabled,
                time_added_epoch: directory_added_epoch(&path),
            })
        })
        .collect::<Vec<_>>();

    mods.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });

    mods
}

fn summarize_item_folder(item_id: String, folder: &Path) -> ItemScanSummary {
    let mods = scan_mod_entries(folder);
    let total_mods = mods.len();
    let disabled_mods = mods.iter().filter(|entry| entry.disabled).count();
    let enabled_mods = total_mods.saturating_sub(disabled_mods);

    ItemScanSummary {
        item_id,
        path: normalize_path(folder),
        total_mods,
        enabled_mods,
        disabled_mods,
        mods,
    }
}

fn resolve_icon_path(icon_dirs: &[String], item_id: &str) -> Option<String> {
    fn matches_icon_stem(stem: &str, item_id: &str) -> bool {
        let normalized_stem = stem.replace(['_', '-', ' '], "").to_ascii_lowercase();
        let normalized_id = item_id.replace(['_', '-', ' '], "").to_ascii_lowercase();

        if normalized_stem == normalized_id {
            return true;
        }

        // Avoid very short ids (like "ui") matching unrelated names (like "mavuika").
        if normalized_id.len() < 4 {
            return false;
        }

        normalized_stem.contains(&normalized_id)
    }

    for dir_str in icon_dirs {
        let dir = PathBuf::from(dir_str);
        if !dir.is_dir() {
            continue;
        }

        for ext in &["webp", "png", "jpg", "jpeg"] {
            let candidate = dir.join(format!("{item_id}.{ext}"));
            if candidate.is_file() {
                return Some(local_path(&candidate));
            }
        }

        // Try case-insensitive match
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.filter_map(Result::ok) {
                let entry_path = entry.path();
                if !entry_path.is_file() {
                    continue;
                }

                let ext = entry_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or_default();
                if !["webp", "png", "jpg", "jpeg"].iter().any(|x| x.eq_ignore_ascii_case(ext)) {
                    continue;
                }

                let stem = entry_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default();
                if matches_icon_stem(stem, item_id) {
                    return Some(local_path(&entry_path));
                }
            }
        }

        // Check one nested directory level for packs that keep icons in subfolders.
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.filter_map(Result::ok) {
                let subdir = entry.path();
                if !subdir.is_dir() {
                    continue;
                }

                if let Ok(sub_entries) = fs::read_dir(&subdir) {
                    for sub_entry in sub_entries.filter_map(Result::ok) {
                        let icon = sub_entry.path();
                        if !icon.is_file() {
                            continue;
                        }

                        let ext = icon
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or_default();
                        if !["webp", "png", "jpg", "jpeg"].iter().any(|x| x.eq_ignore_ascii_case(ext)) {
                            continue;
                        }

                        let stem = icon.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
                        if matches_icon_stem(stem, item_id) {
                            return Some(local_path(&icon));
                        }
                    }
                }
            }
        }
    }

    None
}

fn summarize_item_catalog_entry(
    item_id: String,
    item_name: String,
    favorite: bool,
    is_custom: bool,
    folder: &Path,
    icon_dirs: &[String],
) -> ItemCatalogEntry {
    let mods = scan_mod_entries(folder);
    let total_mods = mods.len();
    let disabled_mods = mods.iter().filter(|entry| entry.disabled).count();
    let enabled_mods = total_mods.saturating_sub(disabled_mods);
    let icon_path = resolve_icon_path(icon_dirs, &item_id);

    ItemCatalogEntry {
        id: item_id,
        name: item_name,
        path: normalize_path(folder),
        exists: folder.is_dir(),
        favorite,
        is_custom,
        total_mods,
        enabled_mods,
        disabled_mods,
        icon_path,
    }
}

fn summarize_category_folder(category: &str, mod_root: &Path) -> CategoryScanSummary {
    let folder = mod_root.join(category_folder_name(category));
    let exists = folder.is_dir();
    let mut items = Vec::new();

    if exists {
        if category.eq_ignore_ascii_case("buffervalues") {
            items.push(summarize_item_folder("__root__".to_string(), &folder));
        } else {
            let mut item_folders = fs::read_dir(&folder)
                .ok()
                .into_iter()
                .flat_map(|entries| entries.filter_map(Result::ok))
                .filter_map(|entry| {
                    let path = entry.path();
                    if path.is_dir() {
                        Some((entry.file_name().to_string_lossy().to_string(), path))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();

            item_folders.sort_by(|left, right| left.0.to_lowercase().cmp(&right.0.to_lowercase()));

            for (item_id, path) in item_folders {
                items.push(summarize_item_folder(item_id, &path));
            }
        }
    }

    let total_items = items.len();
    let total_mods = items.iter().map(|item| item.total_mods).sum();
    let enabled_mods = items.iter().map(|item| item.enabled_mods).sum();
    let disabled_mods = items.iter().map(|item| item.disabled_mods).sum();

    CategoryScanSummary {
        category: category.to_string(),
        folder_path: normalize_path(&folder),
        exists,
        total_items,
        total_mods,
        enabled_mods,
        disabled_mods,
        items,
    }
}

fn default_mod_paths(_base_dir: &Path) -> Value {
    json!({
        "gi": "",
        "hsr": "",
        "wuwa": "",
        "zzz": "",
        "end": "",
    })
}

fn parse_version_tuple(value: &str) -> Option<Vec<u32>> {
    let parts = value
        .split('.')
        .map(str::trim)
        .map(|part| part.parse::<u32>().ok())
        .collect::<Option<Vec<_>>>()?;

    if parts.is_empty() {
        return None;
    }

    Some(parts)
}

fn normalize_release_tag(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('v')
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
}

/// Launch a process that may require UAC elevation.
/// `Command::new().spawn()` fails with os error 740 when the target exe has a
/// requireAdministrator manifest and the current process is not elevated.
/// Falling back to `powershell Start-Process` causes Windows to show a UAC
/// prompt instead of silently failing.
fn spawn_possibly_elevated(
    path: &std::path::Path,
    work_dir: &std::path::Path,
    args: &[String],
) -> Result<(), String> {
    let result = Command::new(path)
        .current_dir(work_dir)
        .args(args)
        .spawn();

    match result {
        Ok(_) => Ok(()),
        Err(e) if e.raw_os_error() == Some(740) => {
            // Build a PowerShell argument list: each token as a quoted string.
            let arg_list = if args.is_empty() {
                String::new()
            } else {
                args.iter()
                    .map(|a| format!("'{}'", a.replace('\'', "''")))
                    .collect::<Vec<_>>()
                    .join(",")
            };
            let ps_cmd = format!(
                "Start-Process -FilePath '{}' -WorkingDirectory '{}'{}",
                path.display().to_string().replace('\'', "''"),
                work_dir.display().to_string().replace('\'', "''"),
                if arg_list.is_empty() {
                    String::new()
                } else {
                    format!(" -ArgumentList {}", arg_list)
                }
            );
            Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
                .spawn()
                .map(|_| ())
                .map_err(|err| err.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn fetch_latest_release_json(api_url: &str) -> Result<Value, String> {
    let output = background_command("curl")
        .args([
            "-s",
            "-L",
            "-H",
            "Accept: application/vnd.github.v3+json",
            "-H",
            "User-Agent: mod-manager-v2",
            api_url,
        ])
        .output()
        .map_err(|err| format!("curl not available: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.is_empty() {
            "Failed to reach GitHub API (network error)".to_string()
        } else {
            format!("Failed to reach GitHub API: {}", stderr.trim())
        });
    }

    let body = String::from_utf8_lossy(&output.stdout);
    let json: Value = serde_json::from_str(&body).map_err(|err| err.to_string())?;

    // GitHub returns {"message":"..."} for errors (Not Found, rate limit, etc.)
    if let Some(msg) = json.get("message").and_then(Value::as_str) {
        if msg.eq_ignore_ascii_case("not found") {
            return Err("No releases published yet for this repository".to_string());
        }
        if msg.to_ascii_lowercase().contains("rate limit") {
            return Err("rate_limit_exceeded".to_string());
        }
        return Err(format!("GitHub API error: {msg}"));
    }

    Ok(json)
}

fn extract_asset_url(release: &Value, asset_name: &str) -> Option<String> {
    release["assets"].as_array().and_then(|assets| {
        assets
            .iter()
            .find(|a| a["name"].as_str() == Some(asset_name))
            .and_then(|a| a["browser_download_url"].as_str())
            .map(ToOwned::to_owned)
    })
}

fn extract_asset_url_any(release: &Value, asset_names: &[&str]) -> Option<String> {
    release["assets"].as_array().and_then(|assets| {
        assets
            .iter()
            .find(|asset| {
                let Some(name) = asset["name"].as_str() else {
                    return false;
                };
                asset_names
                    .iter()
                    .any(|candidate| name.eq_ignore_ascii_case(candidate))
            })
            .and_then(|asset| asset["browser_download_url"].as_str())
            .map(ToOwned::to_owned)
    })
}

fn extract_app_exe_url(release: &Value) -> Option<String> {
    extract_asset_url_any(
        release,
        &["mod-manager-v2.exe", "modmanager.exe", "mod-manager.exe"],
    )
    .or_else(|| {
        release["assets"].as_array().and_then(|assets| {
            assets
                .iter()
                .find(|asset| {
                    let Some(name) = asset["name"].as_str() else {
                        return false;
                    };
                    let lower = name.to_ascii_lowercase();
                    lower.ends_with(".exe")
                        && !lower.contains("update")
                        && !lower.contains("updater")
                })
                .and_then(|asset| asset["browser_download_url"].as_str())
                .map(ToOwned::to_owned)
        })
    })
}

fn extract_updater_exe_url(release: &Value) -> Option<String> {
    extract_asset_url_any(release, &["update.exe", "updater.exe"]).or_else(|| {
        release["assets"].as_array().and_then(|assets| {
            assets
                .iter()
                .find(|asset| {
                    let Some(name) = asset["name"].as_str() else {
                        return false;
                    };
                    let lower = name.to_ascii_lowercase();
                    lower.ends_with(".exe")
                        && (lower.contains("update") || lower.contains("updater"))
                })
                .and_then(|asset| asset["browser_download_url"].as_str())
                .map(ToOwned::to_owned)
        })
    })
}

fn save_settings_metadata(update: impl FnOnce(&mut Map<String, Value>)) {
    let Ok(resources_dir) = resolve_resources_dir() else {
        return;
    };
    let settings_path = resources_dir.join("settings.json");
    if !settings_path.is_file() {
        return;
    }

    let Ok(raw) = fs::read_to_string(&settings_path) else {
        return;
    };
    let Ok(mut settings_json) = serde_json::from_str::<Value>(&raw) else {
        return;
    };

    if let Value::Object(map) = &mut settings_json {
        // Migrate away from old verbose key names written by earlier versions.
        map.remove("last_update_check_ts");
        map.remove("last_update_check_result");
        update(map);
    }

    if let Ok(body) = serde_json::to_string_pretty(&settings_json) {
        let _ = fs::write(&settings_path, body);
    }
}

fn detect_resource_version(resources_dir: &Path) -> String {
    let mut versions = fs::read_dir(resources_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();

            if !name.ends_with(".txt") {
                return None;
            }

            let raw = name.trim_end_matches(".txt");
            let parsed = parse_version_tuple(raw)?;
            Some((parsed, raw.to_string()))
        })
        .collect::<Vec<_>>();

    versions.sort_by(|left, right| left.0.cmp(&right.0));

    versions
        .pop()
        .map(|(_, version)| version)
        .unwrap_or_else(|| DEFAULT_VERSION.to_string())
}

fn default_settings(base_dir: &Path) -> Value {
    let resources_dir = base_dir.join("resources");

    json!({
        "mod_paths": default_mod_paths(base_dir),
        "nextcloud_links": {
            "gi": "",
            "hsr": "",
            "wuwa": "",
            "zzz": "",
            "end": ""
        },
        "nextcloud_side_link": "",
        "theme": "dark",
        "language": "en",
        "mod_sort_order": "name",
        "script_targets": {},
        "version": detect_resource_version(&resources_dir),
        "auto_check_updates": false,
        "remember_web_sessions": true,
        "enable_login_helper_hints": true,
        "enable_web_adblocker": true,
        "remove_downloaded_stock_fixes_after_update": false,
        "show_nextcloud_tabs": true,
        "show_discord_tab": true,
        "show_modding_sides_tab": true,
        "gamebanana_saved_username": "",
        "gamebanana_saved_password": "",
        "arca_saved_username": "",
        "arca_saved_password": "",
        "dev_mode": false,
        "dev_use_image_background": false,
        "dev_use_all_backgrounds": false,
        "dev_enable_model_preview_tab": false,
        "last_release_tag": Value::Null,
        "last_app_release_tag": Value::Null,
        "last_resources_release_tag": Value::Null,
        "resources_last_downloaded_at": Value::Null,
        "resources_last_download_url": Value::Null,
        "install_path_info": Value::Null,
        "last_selected_game": "gi",
        "window_width": 1200,
        "window_height": 800,
        "window_x": 100,
        "window_y": 100,
        "favorites": {},
        "right_click_toggle_mods": false,
    })
}

fn sanitize_script_relative_path(script_name: &str) -> Result<PathBuf, String> {
    let trimmed = script_name.trim();
    if trimmed.is_empty() {
        return Err("Script name is empty".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        return Err("Script path must be relative".to_string());
    }

    for component in candidate.components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err("Invalid script path".to_string());
            }
            _ => {}
        }
    }

    Ok(candidate)
}

fn collect_fix_scripts_recursive(
    root: &Path,
    dir: &Path,
    dedupe: &mut HashMap<String, FixScriptSummary>,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            collect_fix_scripts_recursive(root, &path, dedupe)?;
            continue;
        }

        if !path.is_file() {
            continue;
        }

        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let kind = if ext == "py" {
            Some("python")
        } else if ext == "exe" {
            Some("exe")
        } else {
            None
        };

        let Some(kind) = kind else {
            continue;
        };

        let rel = path
            .strip_prefix(root)
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        dedupe.entry(rel.clone()).or_insert_with(|| FixScriptSummary {
            name: rel,
            kind: kind.to_string(),
        });
    }

    Ok(())
}

fn merge_json(base: &mut Value, loaded: &Value) {
    match (base, loaded) {
        (Value::Object(base_map), Value::Object(loaded_map)) => {
            for (key, value) in loaded_map {
                match base_map.get_mut(key) {
                    Some(existing) => merge_json(existing, value),
                    None => {
                        base_map.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (base_slot, loaded_value) => {
            *base_slot = loaded_value.clone();
        }
    }
}

fn push_candidate(
    candidates: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
    candidate: PathBuf,
) {
    if candidate.as_os_str().is_empty() {
        return;
    }

    let key = normalize_path(&candidate).to_ascii_lowercase();
    if seen.insert(key) {
        candidates.push(candidate);
    }
}

fn seed_paths() -> Vec<PathBuf> {
    let mut seeds = Vec::new();

    if let Ok(current_dir) = std::env::current_dir() {
        seeds.push(current_dir);
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            seeds.push(parent.to_path_buf());
        }
    }

    seeds
}

fn legacy_candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for seed in seed_paths() {
        push_candidate(&mut candidates, &mut seen, seed.clone());

        for ancestor in seed.ancestors().take(6) {
            let ancestor = ancestor.to_path_buf();
            push_candidate(&mut candidates, &mut seen, ancestor.clone());
            push_candidate(
                &mut candidates,
                &mut seen,
                ancestor.join("modmanager"),
            );
            push_candidate(
                &mut candidates,
                &mut seen,
                ancestor.join("V7.Try2").join("modmanager"),
            );
            push_candidate(
                &mut candidates,
                &mut seen,
                ancestor
                    .join("#1scripts")
                    .join("V7.Try2")
                    .join("modmanager"),
            );
            push_candidate(
                &mut candidates,
                &mut seen,
                ancestor
                    .join("My Games")
                    .join("#1scripts")
                    .join("V7.Try2")
                    .join("modmanager"),
            );
        }
    }

    candidates
}

fn detect_legacy_install() -> Option<LegacyInstall> {
    legacy_candidate_paths().into_iter().find_map(|candidate| {
        let resources_dir = candidate.join("resources");
        let settings_path = resources_dir.join("settings.json");
        let modmanager_path = candidate.join("modmanager.py");

        if resources_dir.is_dir() && (settings_path.is_file() || modmanager_path.is_file()) {
            Some(LegacyInstall {
                base_dir: normalize_path(&candidate),
                resources_dir: normalize_path(&resources_dir),
                settings_path: normalize_path(&settings_path),
            })
        } else {
            None
        }
    })
}

fn load_settings_from_install(install: &LegacyInstall) -> (Value, bool) {
    let mut settings = default_settings(Path::new(&install.base_dir));

    let loaded = fs::read_to_string(&install.settings_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

    if let Some(loaded_settings) = loaded {
        merge_json(&mut settings, &loaded_settings);
        if let Value::Object(map) = &mut settings {
            map.entry("script_targets".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            map.entry("favorites".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            map.entry("right_click_toggle_mods".to_string())
                .or_insert_with(|| Value::Bool(false));
        }
        return (settings, true);
    }

    (settings, false)
}

#[tauri::command]
fn load_bootstrap_state() -> Result<BootstrapState, String> {
    if let Ok(resources_dir) = resolve_resources_dir() {
        let _ = ensure_custom_fixes_scaffold(&resources_dir);
        if let Some(base) = resources_dir.parent() {
            let _ = ensure_runtime_tools_scaffold(base);
        }
    }
    if let Some(base) = resolve_best_dev_app_base().or_else(resolve_install_base) {
        let _ = ensure_dev_app_scaffold(&base);
        let _ = ensure_runtime_tools_scaffold(&base);
    }

    let detected_paths = legacy_candidate_paths()
        .into_iter()
        .map(|path| normalize_path(&path))
        .collect::<Vec<_>>();

    let legacy_install = detect_legacy_install();

    let (settings, settings_found) = if let Some(install) = &legacy_install {
        load_settings_from_install(install)
    } else if let Some(base) = resolve_install_base() {
        let resources = base.join("resources");
        let settings_path = resources.join("settings.json");
        if settings_path.is_file() {
            let mock_install = LegacyInstall {
                base_dir: normalize_path(&base),
                resources_dir: normalize_path(&resources),
                settings_path: normalize_path(&settings_path),
            };
            load_settings_from_install(&mock_install)
        } else {
            (default_settings(&base), false)
        }
    } else {
        let base_dir = std::env::current_dir().map_err(|err| err.to_string())?;
        (default_settings(&base_dir), false)
    };

    let app_version = settings
        .get("last_app_release_tag")
        .or_else(|| settings.get("last_release_tag"))
        .and_then(Value::as_str)
        .map(normalize_release_tag)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let exe_dir_str = normalize_path(&exe_dir);

    let needs_setup = legacy_install.is_none() && !settings_found;

    Ok(BootstrapState {
        legacy_install,
        settings,
        settings_found,
        detected_paths,
        app_version,
        needs_setup,
        exe_dir: exe_dir_str,
    })
}

#[tauri::command]
fn save_legacy_settings(base_dir: Option<String>, settings: Value) -> Result<String, String> {
    let install_base = base_dir
        .map(PathBuf::from)
        .or_else(|| detect_legacy_install().map(|install| PathBuf::from(install.base_dir)))
        .or_else(resolve_install_base)
        .ok_or_else(|| "No install location found. APPDATA env var may be missing.".to_string())?;

    let resources_dir = install_base.join("resources");
    let settings_path = resources_dir.join("settings.json");
    let mut merged = default_settings(&install_base);

    merge_json(&mut merged, &settings);

    fs::create_dir_all(&resources_dir).map_err(|err| err.to_string())?;
    let body = serde_json::to_string_pretty(&merged).map_err(|err| err.to_string())?;
    fs::write(&settings_path, body).map_err(|err| err.to_string())?;

    if let Some(paths) = merged.get("mod_paths").and_then(Value::as_object) {
        for (game, path_value) in paths {
            if let Some(path) = path_value.as_str() {
                let trimmed = path.trim();
                if trimmed.is_empty() {
                    continue;
                }

                // Best-effort scaffold so new mod roots are immediately usable.
                let _ = create_mod_folder_scaffold_internal(game, trimmed);
            }
        }
    }

    Ok(normalize_path(&settings_path))
}

#[tauri::command]
fn scan_game_mods(game: String, mod_root: String) -> Result<GameScanSummary, String> {
    let mod_root_path = PathBuf::from(&mod_root);
    let exists = mod_root_path.is_dir();

    let categories = CATEGORY_KEYS
        .into_iter()
        .map(|category| summarize_category_folder(category, &mod_root_path))
        .collect::<Vec<_>>();

    let total_items = categories.iter().map(|category| category.total_items).sum();
    let total_mods = categories.iter().map(|category| category.total_mods).sum();
    let enabled_mods = categories
        .iter()
        .map(|category| category.enabled_mods)
        .sum();
    let disabled_mods = categories
        .iter()
        .map(|category| category.disabled_mods)
        .sum();

    Ok(GameScanSummary {
        game,
        mod_root: normalize_path(&mod_root_path),
        exists,
        total_items,
        total_mods,
        enabled_mods,
        disabled_mods,
        categories,
    })
}

#[tauri::command]
fn load_game_inventory(game: String, mod_root: String) -> Result<GameInventorySummary, String> {
    let resources_dir = resolve_resources_dir()?;
    let settings = load_settings_snapshot()?;
    let mod_root_path = PathBuf::from(&mod_root);
    let icons_base = resources_dir.join("icons");

    let categories = CATEGORY_KEYS
        .iter()
        .map(|category| {
            let category_folder = build_item_folder_path(&mod_root_path, category, None);
            let game_human = match game.as_str() {
                "gi" => "genshin",
                "hsr" => "hsr",
                "wuwa" => "wuwa",
                "zzz" => "zzz",
                "end" => "end",
                _ => game.as_str(),
            };
            let icon_candidates = vec![
                icons_base.join(format!("{}_{}", game, category)),
                icons_base.join(format!("{}_{}", game_human, category)),
                icons_base.join(&game),
                icons_base.join(game_human),
            ];
            let icon_dirs = icon_candidates
                .into_iter()
                .filter(|p| p.is_dir())
                .map(|p| normalize_path(&p))
                .collect::<Vec<_>>();
            let items = collect_category_items(&resources_dir, &settings, &game, category)
                .into_iter()
                .map(|(item_id, item_name, favorite, is_custom)| {
                    let item_folder =
                        build_item_folder_path(&mod_root_path, category, Some(&item_id));
                    summarize_item_catalog_entry(
                        item_id,
                        item_name,
                        favorite,
                        is_custom,
                        &item_folder,
                        &icon_dirs,
                    )
                })
                .collect::<Vec<_>>();

            CategoryInventorySummary {
                category: (*category).to_string(),
                folder_path: normalize_path(&category_folder),
                exists: category_folder.is_dir(),
                items,
            }
        })
        .collect::<Vec<_>>();

    Ok(GameInventorySummary {
        game,
        mod_root: normalize_path(&mod_root_path),
        categories,
    })
}

#[tauri::command]
fn load_item_mods(
    game: String,
    category: String,
    item_id: String,
    item_name: String,
    mod_root: String,
) -> Result<ItemModsSummary, String> {
    let item_path = build_item_folder_path(Path::new(&mod_root), &category, Some(&item_id));
    let mods = scan_mod_entries(&item_path);
    let total_mods = mods.len();
    let disabled_mods = mods.iter().filter(|entry| entry.disabled).count();
    let enabled_mods = total_mods.saturating_sub(disabled_mods);

    Ok(ItemModsSummary {
        game,
        category,
        item_id,
        item_name,
        path: normalize_path(&item_path),
        exists: item_path.is_dir(),
        total_mods,
        enabled_mods,
        disabled_mods,
        mods,
    })
}

#[tauri::command]
fn toggle_mod_folder(path: String) -> Result<String, String> {
    let current_path = PathBuf::from(&path);

    if !current_path.is_dir() {
        return Err("Mod folder not found".to_string());
    }

    let parent = current_path
        .parent()
        .ok_or_else(|| "Cannot toggle root folder".to_string())?;
    let folder_name = current_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid folder name".to_string())?;

    let next_name = if let Some(stripped) = folder_name.strip_prefix("DISABLED_") {
        let base = strip_disabled_duplicate_prefix(stripped).to_string();
        find_available_enabled_name(parent, &base)
    } else {
        find_available_disabled_name(parent, folder_name)
    };

    let next_path = parent.join(next_name);
    fs::rename(&current_path, &next_path).map_err(|err| err.to_string())?;
    Ok(normalize_path(&next_path))
}

#[tauri::command]
fn rename_mod_folder(path: String, new_name: String) -> Result<String, String> {
    let current_path = PathBuf::from(&path);

    if !current_path.is_dir() {
        return Err("Mod folder not found".to_string());
    }

    let parent = current_path
        .parent()
        .ok_or_else(|| "Cannot rename root folder".to_string())?;
    let current_name = current_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid folder name".to_string())?;

    let requested = new_name.trim();
    if requested.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }

    let sanitized = sanitize_folder_name(requested);
    let base_name = sanitized
        .trim_start_matches("DISABLED_")
        .trim()
        .to_string();
    if base_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }

    // Preserve current enabled/disabled state while renaming.
    let next_name = if current_name.starts_with("DISABLED_") {
        format!("DISABLED_{base_name}")
    } else {
        base_name
    };

    if next_name == current_name {
        return Ok(normalize_path(&current_path));
    }

    let next_path = parent.join(&next_name);
    if next_path.exists() {
        return Err(format!("A folder named '{next_name}' already exists."));
    }

    fs::rename(&current_path, &next_path).map_err(|err| err.to_string())?;
    Ok(normalize_path(&next_path))
}

#[tauri::command]
fn webview_eval(
    app: tauri::AppHandle,
    label: String,
    script: String,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{label}' not found"))?;

    webview.eval(&script).map_err(|err| err.to_string())
}

fn unique_download_destination(dir: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let mut target = dir.join(file_name);
    let mut idx: u32 = 1;
    let name_lossy = file_name.to_string_lossy().into_owned();
    while target.exists() {
        let stem = Path::new(&name_lossy)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("download");
        let ext = Path::new(&name_lossy)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let next_name = if ext.is_empty() {
            format!("{stem}_copy{idx}")
        } else {
            format!("{stem}_copy{idx}.{ext}")
        };
        target = dir.join(next_name);
        idx += 1;
    }
    target
}

// Handles the real WebView2/WKWebView download flow so Discord attachment CDNs and
// Arca.live cloud-storage downloads land in the app's managed folder, regardless of
// whether the site triggers them via a link, redirect, or JS confirm button.
fn handle_browser_download(
    app: &tauri::AppHandle,
    source: &str,
    downloads_dir: &Path,
    event: tauri::webview::DownloadEvent<'_>,
) -> bool {
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            let _ = fs::create_dir_all(downloads_dir);
            let file_name = destination
                .file_name()
                .map(|name| name.to_os_string())
                .unwrap_or_else(|| std::ffi::OsString::from("download.bin"));
            let resolved = unique_download_destination(downloads_dir, &file_name);

            let _ = app.emit(
                "mod-manager-web-download-started",
                json!({
                    "source": source,
                    "url": url.to_string(),
                    "fileName": resolved.file_name().and_then(|n| n.to_str()),
                    "path": resolved.to_str(),
                }),
            );

            *destination = resolved;
            true
        }
        tauri::webview::DownloadEvent::Finished { url, path, success } => {
            let payload = json!({
                "source": source,
                "url": url.to_string(),
                "fileName": path.as_ref().and_then(|p| p.file_name()).and_then(|n| n.to_str()),
                "path": path.as_ref().and_then(|p| p.to_str()),
                "success": success,
            });
            let _ = app.emit("mod-manager-web-download-finished", payload);
            true
        }
        _ => true,
    }
}

// Creates the embedded Discord/Arca browser panel via Rust (instead of the JS Webview API) so
// real `on_download` hooks can be attached, giving the tab genuine in-app download handling.
// `on_new_window` is deliberately NOT used to build another window/webview: that callback runs
// on the main UI thread, and building a window there self-deadlocks the whole app. Instead any
// second-tab/popup request is handed off to the system's real default browser (which also has
// the user's actual login/session for that site).
#[tauri::command]
async fn create_managed_browser_webview(
    app: tauri::AppHandle,
    window_label: String,
    label: String,
    url: String,
    source: String,
    downloads_folder: String,
    data_directory: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if app.get_webview(&label).is_some() {
        return Ok(());
    }

    let window = app
        .get_window(&window_label)
        .ok_or_else(|| format!("Window '{window_label}' not found"))?;

    let trimmed = url.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err("Invalid browser URL".to_string());
    }
    let parsed = tauri::Url::parse(trimmed).map_err(|err| err.to_string())?;

    let downloads_dir = PathBuf::from(downloads_folder.trim());

    let download_app = app.clone();
    let download_source = source.clone();
    let download_dir = downloads_dir.clone();

    let newwin_app = app.clone();

    // `add_child` hops to the main thread and blocks for the result, so this must run off
    // whatever thread is dispatching this command to avoid a self-deadlock on the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
            .on_download(move |_webview, event| {
                handle_browser_download(&download_app, &download_source, &download_dir, event)
            })
            .on_new_window(move |new_url, _features| {
                let _ = newwin_app.opener().open_url(new_url.to_string(), None::<&str>);
                tauri::webview::NewWindowResponse::Deny
            });

        if let Some(dir) = data_directory.filter(|value| !value.trim().is_empty()) {
            builder = builder.data_directory(PathBuf::from(dir));
        }

        window
            .add_child(
                builder,
                Position::Logical(LogicalPosition::new(x, y)),
                Size::Logical(LogicalSize::new(width, height)),
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

static RELAY_REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
fn gamebanana_relay_response(app: tauri::AppHandle, request_id: String, ok: bool, body: String) -> Result<(), String> {
    app.emit(&format!("gamebanana-relay-{request_id}"), json!({ "ok": ok, "body": body }))
        .map_err(|err| err.to_string())
}

// Fetches GameBanana API endpoints through the embedded GameBanana webview's own JS `fetch`
// (with credentials included) so the request carries the real logged-in session cookies and
// looks like normal in-browser traffic. A plain curl request with a copied cookie gets blocked
// by GameBanana's bot protection, which previously broke the whole Mod Browser tab.
#[tauri::command]
async fn gamebanana_api_request_via_webview(app: tauri::AppHandle, endpoint: String) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_start_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("Missing GameBanana API endpoint".to_string());
    }

    let webview = app
        .get_webview("gb-browser-view")
        .ok_or_else(|| "Open the GameBanana tab under Modding Sides once first.".to_string())?;

    let request_id = RELAY_REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();
    let event_name = format!("gamebanana-relay-{request_id}");

    let (tx, rx) = std::sync::mpsc::channel::<(bool, String)>();
    let tx = std::sync::Mutex::new(Some(tx));

    let listener_id = app.listen_any(event_name, move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let body = payload
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if let Some(sender) = tx.lock().unwrap().take() {
                let _ = sender.send((ok, body));
            }
        }
    });

    let url = format!("https://gamebanana.com/apiv11/{trimmed}");
    let script = format!(
        r#"(() => {{
      fetch({url_json}, {{ credentials: 'include', headers: {{ Accept: 'application/json' }} }})
        .then((response) => response.text())
        .then((body) => {{
          window.__TAURI_INTERNALS__.invoke('gamebanana_relay_response', {{ requestId: {request_id_json}, ok: true, body }});
        }})
        .catch((err) => {{
          window.__TAURI_INTERNALS__.invoke('gamebanana_relay_response', {{ requestId: {request_id_json}, ok: false, body: String(err) }});
        }});
    }})();"#,
        url_json = json!(url),
        request_id_json = json!(request_id),
    );

    if let Err(err) = webview.eval(&script) {
        app.unlisten(listener_id);
        return Err(err.to_string());
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(20))
    })
    .await
    .map_err(|err| err.to_string())?;

    app.unlisten(listener_id);

    match result {
        Ok((true, body)) => Ok(body),
        Ok((false, body)) => Err(format!("GameBanana request failed: {body}")),
        Err(_) => Err(
            "Timed out waiting for GameBanana. Keep the GameBanana tab open (Modding Sides) and try again."
                .to_string(),
        ),
    }
}

#[tauri::command]
fn emit_web_download_request(
    app: tauri::AppHandle,
    source: String,
    url: String,
    file_name: Option<String>,
) -> Result<(), String> {
    let payload = json!({
        "source": source,
        "url": url,
        "fileName": file_name,
    });

    app.emit("mod-manager-web-download-request", payload)
        .map_err(|err| err.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadLogEntry {
    id: String,
    source: String,
    status: String,
    mod_name: String,
    file_name: String,
    destination_path: String,
    installed_path: Option<String>,
    preview_path: Option<String>,
    message: Option<String>,
    started_at: f64,
    finished_at: Option<f64>,
}

fn download_log_path() -> Result<PathBuf, String> {
    let resources_dir = resolve_resources_dir()?;
    Ok(resources_dir.join("downloads.json"))
}

// Persists completed/failed downloads across app restarts so the Downloads tab keeps its
// history instead of resetting every session.
#[tauri::command]
fn load_download_log() -> Result<Vec<DownloadLogEntry>, String> {
    let path = download_log_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let body = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    serde_json::from_str(&body).map_err(|err| err.to_string())
}

#[tauri::command]
fn append_download_log_entry(entry: DownloadLogEntry) -> Result<(), String> {
    let path = download_log_path()?;
    let mut entries: Vec<DownloadLogEntry> = if path.exists() {
        let body = fs::read_to_string(&path).map_err(|err| err.to_string())?;
        serde_json::from_str(&body).unwrap_or_default()
    } else {
        Vec::new()
    };

    entries.retain(|existing| existing.id != entry.id);
    entries.push(entry);

    const MAX_ENTRIES: usize = 500;
    if entries.len() > MAX_ENTRIES {
        let excess = entries.len() - MAX_ENTRIES;
        entries.drain(0..excess);
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let body = serde_json::to_string_pretty(&entries).map_err(|err| err.to_string())?;
    fs::write(&path, body).map_err(|err| err.to_string())
}

#[tauri::command]
fn clear_download_log() -> Result<(), String> {
    let path = download_log_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn toggle_item_favorite(game: String, item_id: String) -> Result<bool, String> {
    let resources_dir = resolve_resources_dir()?;
    let settings = load_settings_snapshot()?;
    let mut favorites = read_favorites(&resources_dir, &game, &settings);

    let next_state = if favorites.contains(&item_id) {
        favorites.remove(&item_id);
        false
    } else {
        favorites.insert(item_id.clone());
        true
    };

    let favorites_path = favorites_file_path(&resources_dir, &game);
    let favorites_json = favorites.into_iter().collect::<Vec<_>>();
    if let Some(parent) = favorites_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let body = serde_json::to_string_pretty(&favorites_json).map_err(|err| err.to_string())?;
    fs::write(favorites_path, body).map_err(|err| err.to_string())?;

    Ok(next_state)
}

#[tauri::command]
fn load_fixes_panel(game: String) -> Result<FixesPanelData, String> {
    let resources_dir = resolve_resources_dir()?;
    ensure_custom_fixes_scaffold(&resources_dir)?;

    let mut dedupe: HashMap<String, FixScriptSummary> = HashMap::new();
    let script_roots = [
        resources_dir.join(CUSTOM_FIXES_DIR_NAME).join(&game),
        resources_dir.join(&game),
    ];

    for script_root in script_roots {
        collect_fix_scripts_recursive(&script_root, &script_root, &mut dedupe)?;
    }

    let mut scripts = dedupe.into_values().collect::<Vec<_>>();
    scripts.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok(FixesPanelData {
        game,
        info_text: load_fixes_info_text(&resources_dir),
        scripts,
    })
}

#[tauri::command]
fn run_fix_script(game: String, script_name: String, target_path: String) -> Result<(), String> {
    let resources_dir = resolve_resources_dir()?;
    ensure_custom_fixes_scaffold(&resources_dir)?;
    let script_relative = sanitize_script_relative_path(&script_name)?;

    let custom_script_path = resources_dir
        .join(CUSTOM_FIXES_DIR_NAME)
        .join(&game)
        .join(&script_relative);
    let stock_script_path = resources_dir.join(&game).join(&script_relative);
    let script_path = if custom_script_path.is_file() {
        custom_script_path
    } else {
        stock_script_path
    };

    if !script_path.is_file() {
        return Err("Script not found".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let target_dir = PathBuf::from(&target_path);
        let cwd = if target_dir.is_dir() {
            target_dir
        } else {
            target_dir
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&target_path))
        };

        let extension = script_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if extension == "py" {
            let run_cmd = format!("python -u '{}'", script_path.display());

            // Open a persistent console so script output/errors remain visible.
            Command::new("powershell")
                .current_dir(&cwd)
                .args(["-NoExit", "-Command", &run_cmd])
                .spawn()
                .map_err(|err| err.to_string())?;
        } else {
            // Keep terminal open and run EXE with robust path quoting.
            let run_cmd = format!("& '{}'", script_path.display());
            Command::new("powershell")
                .current_dir(&cwd)
                .args(["-NoExit", "-Command", &run_cmd])
                .spawn()
                .map_err(|err| err.to_string())?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let target_dir = PathBuf::from(&target_path);
        let cwd = if target_dir.is_dir() {
            target_dir
        } else {
            target_dir
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&target_path))
        };

        Command::new(&script_path)
            .current_dir(cwd)
            .spawn()
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn launch_fix_script_source(game: String, script_name: String) -> Result<(), String> {
    let resources_dir = resolve_resources_dir()?;
    ensure_custom_fixes_scaffold(&resources_dir)?;
    let script_relative = sanitize_script_relative_path(&script_name)?;

    let custom_script_path = resources_dir
        .join(CUSTOM_FIXES_DIR_NAME)
        .join(&game)
        .join(&script_relative);
    let stock_script_path = resources_dir.join(&game).join(&script_relative);
    let script_path = if custom_script_path.is_file() {
        custom_script_path
    } else {
        stock_script_path
    };

    if !script_path.is_file() {
        return Err("Script not found".to_string());
    }

    let source_dir = script_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| resources_dir.clone());

    #[cfg(target_os = "windows")]
    {
        let extension = script_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if extension == "py" {
            let run_cmd = format!("python -u '{}'", script_path.display());

            Command::new("powershell")
                .current_dir(&source_dir)
                .args(["-NoExit", "-Command", &run_cmd])
                .spawn()
                .map_err(|err| err.to_string())?;
        } else {
            let run_cmd = format!("& '{}'", script_path.display());
            Command::new("powershell")
                .current_dir(&source_dir)
                .args(["-NoExit", "-Command", &run_cmd])
                .spawn()
                .map_err(|err| err.to_string())?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new(&script_path)
            .current_dir(source_dir)
            .spawn()
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn load_mod_details(path: String) -> Result<ModDetailSummary, String> {
    let mod_path = PathBuf::from(&path);
    if !mod_path.is_dir() {
        return Err("Mod folder not found".to_string());
    }

    let ini_path = find_first_ini_file(&mod_path);
    let toggles = ini_path
        .as_ref()
        .map(|value| extract_ini_toggle_entries(value))
        .unwrap_or_default();

    Ok(ModDetailSummary {
        mod_path: normalize_path(&mod_path),
        ini_path: ini_path.as_ref().map(|value| normalize_path(value)),
        toggles,
    })
}

#[tauri::command]
fn build_preview_glb_from_dump(
    dump_path: String,
    mod_path: String,
    output_dir: Option<String>,
) -> Result<PreviewBuildResult, String> {
    let dump_root = {
        let value = dump_path.trim();
        if value.is_empty() {
            None
        } else {
            let candidate = PathBuf::from(value);
            if !candidate.is_dir() {
                return Err("Dump path not found".to_string());
            }
            Some(candidate)
        }
    };

    let mod_root = PathBuf::from(mod_path.trim());
    if !mod_root.is_dir() {
        return Err("Mod folder not found".to_string());
    }

    let output_root = output_dir
        .as_ref()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| mod_root.join("preview_build"));
    fs::create_dir_all(&output_root).map_err(|err| err.to_string())?;

    let ini_path = find_first_ini_file(&mod_root);
    let diffuse_texture_path = find_preferred_mod_diffuse_texture(&mod_root).map(|value| normalize_path(&value));
    let ini_first_index_texture_map = ini_path
        .as_ref()
        .map(|value| parse_ini_first_index_texture_map(value, &mod_root))
        .unwrap_or_default();
    let ini_ib_texture_map = ini_path
        .as_ref()
        .map(|value| parse_ini_ib_texture_by_resource(value, &mod_root))
        .unwrap_or_default();
    let mut texture_bindings: HashMap<String, String> = HashMap::new();
    let toggles = ini_path
        .as_ref()
        .map(|value| extract_ini_toggle_entries(value))
        .unwrap_or_default();

    let metadata_path = output_root.join("preview_toggles.json");
    let metadata_json = json!({
        "mod_path": normalize_path(&mod_root),
        "dump_path": dump_root.as_ref().map(|value| normalize_path(value)),
        "ini_path": ini_path.as_ref().map(|value| normalize_path(value)),
        "diffuse_texture_path": diffuse_texture_path.clone(),
        "texture_bindings": texture_bindings.clone(),
        "toggle_count": toggles.len(),
        "toggles": toggles,
    });
    fs::write(
        &metadata_path,
        serde_json::to_string_pretty(&metadata_json).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;

    let recipe_path = output_root.join("build_recipe.txt");
    let recipe_body = [
        "3DMigoto Preview Build Recipe",
        "",
        "1) Use the installed mod folder. Optionally provide a 3DMigoto/XXMI dump folder as a fallback source.",
        "2) Use preview_toggles.json to map Key sections to your preview tool toggles.",
        "3) The app first tries to build preview_model.glb from mod VB/IB binary buffers in the ini resources.",
        "4) If that fails and a dump folder is provided, it falls back to dump VB/IB text mesh data.",
        "",
        "If no valid mesh is found, it falls back to a proxy model so preview still works.",
    ]
    .join("\r\n");
    fs::write(&recipe_path, recipe_body).map_err(|err| err.to_string())?;

    let model_output = output_root.join("preview_model.glb");
    let mesh_source = build_mod_binary_preview_mesh(&mod_root, ini_path.as_deref())?
        .map(|mesh| (mesh, "mod binary buffers".to_string()))
        .or_else(|| {
            dump_root.as_ref().and_then(|root| {
                build_dump_preview_mesh(root)
                    .ok()
                    .flatten()
                    .map(|mesh| (mesh, "dump text mesh data".to_string()))
            })
        });

    let message = if let Some((mesh, source_label)) = mesh_source {
        texture_bindings = build_preview_texture_bindings(
            &mesh.parts,
            &mod_root,
            &ini_first_index_texture_map,
            &ini_ib_texture_map,
        );
        if texture_bindings.is_empty() {
            if let Some(diffuse) = &diffuse_texture_path {
                for part in &mesh.parts {
                    let key = sanitize_material_name(&part.name);
                    if !key.is_empty() {
                        texture_bindings.insert(key, diffuse.clone());
                    }
                }
            }
        }

        texture_bindings = build_preview_texture_png_cache(&output_root, &texture_bindings);

        let metadata_json = json!({
            "mod_path": normalize_path(&mod_root),
            "dump_path": dump_root.as_ref().map(|value| normalize_path(value)),
            "ini_path": ini_path.as_ref().map(|value| normalize_path(value)),
            "diffuse_texture_path": diffuse_texture_path.clone(),
            "texture_bindings": texture_bindings.clone(),
            "toggle_count": toggles.len(),
            "toggles": toggles,
        });
        fs::write(
            &metadata_path,
            serde_json::to_string_pretty(&metadata_json).map_err(|err| err.to_string())?,
        )
        .map_err(|err| err.to_string())?;

        create_preview_glb_from_mesh(&model_output, &mesh, &metadata_json)?;
        format!(
            "Preview model generated from {} ({} vertices, {} triangles).",
            source_label,
            mesh.positions.len(),
            mesh.indices.len() / 3
        )
    } else {
        let token_source = dump_root.as_ref().unwrap_or(&mod_root);
        let parts = discover_preview_parts(token_source, &mod_root);
        create_cube_mesh_glb(&model_output, &parts, &metadata_json)?;
        "Preview model generated (proxy fallback).".to_string()
    };

    Ok(PreviewBuildResult {
        model_path: Some(normalize_path(&model_output)),
        diffuse_texture_path,
        texture_bindings,
        metadata_path: normalize_path(&metadata_path),
        recipe_path: normalize_path(&recipe_path),
        toggle_count: toggles.len(),
        message,
    })
}

#[tauri::command]
fn find_mod_preview_images(path: String) -> Vec<String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Vec::new();
    }

    let image_extensions = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
    let mut images = Vec::new();
    let mut stack = vec![root];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut subdirs = Vec::new();

        for entry in entries.filter_map(Result::ok) {
            let p = entry.path();
            if p.is_dir() {
                subdirs.push(p);
            } else if p
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| image_extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
            {
                images.push(local_path(&p));
            }
        }

        subdirs.sort();
        subdirs.reverse();
        stack.extend(subdirs);
    }

    images.sort_by(|left, right| {
        let left_name = Path::new(left)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let right_name = Path::new(right)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let left_priority = if left_name.starts_with("preview") || left_name.starts_with("0preview") {
            0
        } else {
            1
        };
        let right_priority = if right_name.starts_with("preview") || right_name.starts_with("0preview") {
            0
        } else {
            1
        };

        left_priority
            .cmp(&right_priority)
            .then_with(|| left_name.cmp(&right_name))
    });
    images
}

#[tauri::command]
fn copy_mod_preview_image(mod_path: String, image_path: String) -> Result<String, String> {
    let mod_dir = PathBuf::from(&mod_path);
    if !mod_dir.is_dir() {
        return Err(format!("Mod folder not found: {mod_path}"));
    }

    let source = PathBuf::from(&image_path);
    if !source.is_file() {
        return Err(format!("Image file not found: {image_path}"));
    }

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| ["png", "jpg", "jpeg", "webp", "bmp", "gif"].contains(&value.as_str()))
        .ok_or_else(|| "Selected file is not a supported image format.".to_string())?;

    let preview_path = mod_dir.join(format!("preview.{ext}"));
    fs::copy(&source, &preview_path).map_err(|err| err.to_string())?;
    Ok(normalize_path(&preview_path))
}

#[tauri::command]
fn load_image_data_url(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.is_file() {
        return Err("Image file not found".to_string());
    }

    let ext = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };

    let bytes = fs::read(&file_path).map_err(|err| err.to_string())?;
    let encoded = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    };

    Ok(format!("data:{mime};base64,{encoded}"))
}

#[tauri::command]
fn load_file_data_url(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(path.trim());
    if !file_path.is_file() {
        return Err("File not found".to_string());
    }

    let ext = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mime = match ext.as_str() {
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "dds" => "image/vnd-ms.dds",
        "ini" | "json" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };

    let bytes = fs::read(&file_path).map_err(|err| err.to_string())?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn resolve_preview_texture_bindings(
    mod_path: String,
    toggle_vars: HashMap<String, String>,
    output_dir: Option<String>,
) -> Result<HashMap<String, String>, String> {
    let mod_root = PathBuf::from(mod_path.trim());
    if !mod_root.is_dir() {
        return Err("Mod folder not found".to_string());
    }

    let Some(ini_path) = find_first_ini_file(&mod_root) else {
        return Ok(HashMap::new());
    };

    let mut normalized_vars = HashMap::new();
    for (key, value) in toggle_vars {
        normalized_vars.insert(normalize_ini_var_name(&key), value.trim().to_string());
    }

    let ini_first_index_texture_map = parse_ini_first_index_texture_map(&ini_path, &mod_root);
    let ini_ib_texture_map = parse_ini_ib_texture_by_resource_for_vars(&ini_path, &mod_root, &normalized_vars);

    let output_root = output_dir
        .as_ref()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| mod_root.join("preview_build"));

    let metadata_path = output_root.join("preview_toggles.json");
    let base_bindings = fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("texture_bindings").cloned())
        .and_then(|value| serde_json::from_value::<HashMap<String, String>>(value).ok())
        .unwrap_or_default();

    if base_bindings.is_empty() {
        let Some(mesh) = build_mod_binary_preview_mesh(&mod_root, Some(&ini_path))? else {
            return Ok(HashMap::new());
        };

        return Ok(build_preview_texture_bindings(
            &mesh.parts,
            &mod_root,
            &ini_first_index_texture_map,
            &ini_ib_texture_map,
        ));
    }

    let mut normalized_ib_lookup = ini_ib_texture_map
        .iter()
        .map(|(ib_resource, texture_path)| (sanitize_material_name(ib_resource), texture_path.clone()))
        .collect::<Vec<_>>();
    normalized_ib_lookup.sort_by(|left, right| right.0.len().cmp(&left.0.len()));

    let mut resolved = HashMap::new();
    for (material_key, existing_path) in base_bindings {
        let lower_key = material_key.to_ascii_lowercase();
        let replacement = normalized_ib_lookup
            .iter()
            .find(|(ib_key, _)| !ib_key.is_empty() && lower_key.starts_with(ib_key))
            .map(|(_, texture_path)| texture_path.clone());

        resolved.insert(material_key, replacement.unwrap_or(existing_path));
    }

    Ok(resolved)
}

#[tauri::command]
fn resolve_preview_active_first_indices(
    mod_path: String,
    toggle_vars: HashMap<String, String>,
) -> Result<Vec<u32>, String> {
    let mod_root = PathBuf::from(mod_path.trim());
    if !mod_root.is_dir() {
        return Err("Mod folder not found".to_string());
    }

    let Some(ini_path) = find_first_ini_file(&mod_root) else {
        return Ok(Vec::new());
    };

    let mut normalized_vars = parse_ini_default_vars(&ini_path);
    for (key, value) in toggle_vars {
        normalized_vars.insert(normalize_ini_var_name(&key), value.trim().to_string());
    }

    Ok(parse_ini_active_drawindexed_first_indices_for_vars(
        &ini_path,
        &normalized_vars,
    ))
}

#[tauri::command]
fn load_texture_data_url(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(path.trim());
    if !file_path.is_file() {
        return Err("Texture file not found".to_string());
    }

    let ext = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if ext == "dds" {
        let bytes = fs::read(&file_path).map_err(|err| err.to_string())?;
        let mut cursor = Cursor::new(&bytes);
        let dds = Dds::read(&mut cursor).map_err(|err| format!("Failed to parse DDS: {err}"))?;
        let image = image_dds::image_from_dds(&dds, 0).map_err(|err| format!("Failed to decode DDS: {err}"))?;

        let mut encoded_png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut encoded_png), ImageFormat::Png)
            .map_err(|err| format!("Failed to convert DDS to PNG: {err}"))?;

        return Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(encoded_png)
        ));
    }

    load_file_data_url(path)
}

#[tauri::command]
fn load_images_data_urls(paths: Vec<String>) -> HashMap<String, String> {
    let mut result = HashMap::new();

    for path in paths {
        if let Ok(data_url) = load_image_data_url(path.clone()) {
            result.insert(path, data_url);
        }
    }

    result
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(src).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let dest_child = dest.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_recursive(&entry.path(), &dest_child)?;
        } else {
            fs::copy(entry.path(), &dest_child).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn score_diffuse_candidate(name: &str) -> i32 {
    let lower = name.to_ascii_lowercase();
    let mut score = 0;
    if lower.contains("diffuse") {
        score += 100;
    }
    if lower.contains("main") {
        score += 20;
    }
    if lower.contains("body") {
        score += 18;
    }
    if lower.contains("head") {
        score += 14;
    }
    if lower.contains("dress") {
        score += 12;
    }
    if lower.contains("face") {
        score += 10;
    }
    if lower.contains("hair") {
        score += 8;
    }
    if lower.contains("normal") || lower.contains("lightmap") || lower.contains("mask") {
        score -= 80;
    }
    score
}

fn find_preferred_mod_diffuse_texture(mod_root: &Path) -> Option<PathBuf> {
    let mut stack = vec![mod_root.to_path_buf()];
    let mut best: Option<(i32, PathBuf)> = None;

    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            let ext = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if ext != "dds" {
                continue;
            }

            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            let score = score_diffuse_candidate(file_name);
            if score <= 0 {
                continue;
            }

            match &best {
                Some((current_score, _)) if score <= *current_score => {}
                _ => {
                    best = Some((score, path.clone()));
                }
            }
        }
    }

    best.map(|(_, path)| path)
}

fn sanitize_material_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('_');
        }
    }

    while out.contains("__") {
        out = out.replace("__", "_");
    }

    out.trim_matches('_').to_string()
}

fn extract_alnum_tokens(value: &str, min_len: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else if current.len() >= min_len {
            out.push(std::mem::take(&mut current));
        } else {
            current.clear();
        }
    }

    if current.len() >= min_len {
        out.push(current);
    }

    out
}

fn looks_like_hex_token(value: &str) -> bool {
    let len = value.len();
    (6..=16).contains(&len) && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn collect_mod_texture_candidates(mod_root: &Path) -> Vec<PathBuf> {
    let mut stack = vec![mod_root.to_path_buf()];
    let mut files = Vec::new();

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            let ext = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if ["dds", "png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
                files.push(path);
            }
        }
    }

    files
}

fn is_image_texture_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".dds")
        || lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".webp")
}

fn select_override_texture_resource(
    slot_resources: &HashMap<String, String>,
    resource_files: &HashMap<String, String>,
    mod_root: &Path,
) -> Option<String> {
    let mut candidates: Vec<(String, String, i32)> = Vec::new();

    for slot in ["ps-t1", "ps-t0", "ps-t2", "ps-t3"] {
        let Some(resource_name) = slot_resources.get(slot) else {
            continue;
        };
        let key = resource_name.to_ascii_lowercase();
        let Some(file_name) = resource_files.get(&key) else {
            continue;
        };
        let path = mod_root.join(file_name);
        if !path.exists() {
            continue;
        }
        let score = score_diffuse_candidate(file_name);
        candidates.push((resource_name.clone(), file_name.clone(), score));
    }

    if candidates.is_empty() {
        return None;
    }

    let mut best: Option<(String, i32)> = None;
    for (resource_name, _, score) in candidates {
        match &best {
            Some((_, current_score)) if score <= *current_score => {}
            _ => {
                best = Some((resource_name, score));
            }
        }
    }

    match best {
        Some((resource_name, score)) if score > 0 => Some(resource_name),
        _ => None,
    }
}

fn parse_ini_first_index_texture_map(ini_path: &Path, mod_root: &Path) -> HashMap<u32, String> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let mut resource_files: HashMap<String, String> = HashMap::new();

    let mut current_section = String::new();
    let mut pending_resource_name: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.split(';').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current_section = trimmed[1..trimmed.len() - 1].trim().to_string();
            if current_section.to_ascii_lowercase().starts_with("resource") {
                pending_resource_name = Some(current_section.clone());
            } else {
                pending_resource_name = None;
            }
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("filename") {
            continue;
        }

        let Some(resource_name) = &pending_resource_name else {
            continue;
        };
        let file_name = value.trim().trim_matches('"').to_string();
        if !is_image_texture_name(&file_name) {
            continue;
        }
        resource_files.insert(resource_name.to_ascii_lowercase(), file_name);
    }

    let mut first_index_to_texture: HashMap<u32, String> = HashMap::new();
    current_section.clear();
    let mut current_first_index: Option<u32> = None;
    let mut current_ps_slots: HashMap<String, String> = HashMap::new();

    let flush_override = |first_index: Option<u32>, slot_resources: &HashMap<String, String>, out: &mut HashMap<u32, String>| {
        let Some(index) = first_index else {
            return;
        };
        let Some(resource_name) = select_override_texture_resource(slot_resources, &resource_files, mod_root) else {
            return;
        };

        let key = resource_name.to_ascii_lowercase();
        let Some(file_name) = resource_files.get(&key) else {
            return;
        };

        let path = mod_root.join(file_name);
        if path.exists() {
            out.insert(index, normalize_path(&path));
        }
    };

    for line in raw.lines() {
        let trimmed = line.split(';').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if current_section.to_ascii_lowercase().starts_with("textureoverride") {
                flush_override(current_first_index, &current_ps_slots, &mut first_index_to_texture);
            }

            current_section = trimmed[1..trimmed.len() - 1].trim().to_string();
            current_first_index = None;
            current_ps_slots.clear();
            continue;
        }

        if !current_section.to_ascii_lowercase().starts_with("textureoverride") {
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('"');
        if key == "match_first_index" {
            current_first_index = value.parse::<u32>().ok();
        } else if key.starts_with("ps-t") {
            current_ps_slots.insert(key, value.to_string());
        }
    }

    if current_section.to_ascii_lowercase().starts_with("textureoverride") {
        flush_override(current_first_index, &current_ps_slots, &mut first_index_to_texture);
    }

    // WWMI-style overrides often assign textures through Resource\RabbitFX\Diffuse
    // and use many drawindexed slices under conditional branches.
    let mut vars = parse_ini_default_vars(ini_path);
    vars.entry("$mod_enabled".to_string()).or_insert_with(|| "1".to_string());

    let sections = parse_ini_sections(&raw);
    for (section_name, lines) in &sections {
        if !section_name.starts_with("textureoverride") {
            continue;
        }

        let assignments = collect_active_ini_assignments(lines, &vars);
        if assignments.is_empty() {
            continue;
        }

        let mut diffuse_resource: Option<String> = None;
        let mut ps_slots: HashMap<String, String> = HashMap::new();
        let mut draw_ranges: Vec<(usize, usize)> = Vec::new();

        for (key, value) in &assignments {
            if key == r"resource\rabbitfx\diffuse" {
                if let Some(resource) = parse_resource_ref(value) {
                    diffuse_resource = Some(resource);
                }
            } else if key.starts_with("ps-t") {
                ps_slots.insert(key.clone(), value.clone());
            } else if key == "drawindexed" {
                if let Some((count, first_index)) = parse_drawindexed_value(value) {
                    if count > 0 {
                        draw_ranges.push((count, first_index));
                    }
                }
            }
        }

        if draw_ranges.is_empty() {
            continue;
        }

        let texture_resource = if let Some(resource) = diffuse_resource {
            Some(resource)
        } else {
            select_override_texture_resource(&ps_slots, &resource_files, mod_root)
                .map(|value| value.to_ascii_lowercase())
        };

        let Some(texture_resource) = texture_resource else {
            continue;
        };
        let Some(file_name) = resource_files.get(&texture_resource) else {
            continue;
        };

        let path = mod_root.join(file_name);
        if !path.exists() {
            continue;
        }

        let normalized = normalize_path(&path);
        for (_, first_index) in draw_ranges {
            first_index_to_texture.insert(first_index as u32, normalized.clone());
        }
    }

    first_index_to_texture
}

#[derive(Debug, Clone, Default)]
struct IniResourceBufferInfo {
    filename: Option<String>,
    stride: Option<usize>,
    format: Option<String>,
}

fn parse_ini_resource_buffers(ini_path: &Path) -> HashMap<String, IniResourceBufferInfo> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let mut resources: HashMap<String, IniResourceBufferInfo> = HashMap::new();
    let mut current_resource: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.split(';').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = trimmed[1..trimmed.len() - 1].trim().to_string();
            if section.to_ascii_lowercase().starts_with("resource") {
                current_resource = Some(section.to_ascii_lowercase());
                resources.entry(section.to_ascii_lowercase()).or_default();
            } else {
                current_resource = None;
            }
            continue;
        }

        let Some(resource_name) = &current_resource else {
            continue;
        };
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };

        let entry = resources.entry(resource_name.clone()).or_default();
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('"');
        if key == "filename" {
            entry.filename = Some(value.to_string());
        } else if key == "stride" {
            entry.stride = value.parse::<usize>().ok();
        } else if key == "format" {
            entry.format = Some(value.to_ascii_lowercase());
        }
    }

    resources
}

fn parse_ini_sections(raw: &str) -> HashMap<String, Vec<String>> {
    let mut sections: HashMap<String, Vec<String>> = HashMap::new();
    let mut current_section: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.split(';').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = trimmed[1..trimmed.len() - 1].trim().to_ascii_lowercase();
            current_section = Some(section.clone());
            sections.entry(section).or_default();
            continue;
        }

        if let Some(section) = &current_section {
            sections.entry(section.clone()).or_default().push(trimmed.to_string());
        }
    }

    sections
}

fn parse_ini_assignment(line: &str) -> Option<(String, String)> {
    let (key, value) = line.split_once('=')?;
    Some((
        key.trim().to_ascii_lowercase(),
        value.trim().trim_matches('"').to_string(),
    ))
}

fn parse_ini_default_vars(ini_path: &Path) -> HashMap<String, String> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let mut defaults = HashMap::new();
    for line in raw.lines() {
        let trimmed = line.split(';').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }

        let Some((key, value)) = parse_ini_assignment(trimmed) else {
            continue;
        };
        if !key.starts_with("global") {
            continue;
        }

        // Handles patterns like: global persist $swapvar = 2
        let Some((left, right)) = value.split_once('=') else {
            continue;
        };
        let var_name = left.trim().split_whitespace().last().unwrap_or_default();
        if !var_name.starts_with('$') {
            continue;
        }

        let normalized = normalize_ini_var_name(var_name);
        let selected = right.trim().trim_matches('"');
        if selected.is_empty() {
            continue;
        }
        defaults.insert(normalized, selected.to_string());
    }

    defaults
}

fn parse_resource_ref(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }

    let candidate = if let Some(stripped) = trimmed.strip_prefix("ref ") {
        stripped.trim()
    } else {
        trimmed
    };

    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_ascii_lowercase())
    }
}

fn parse_drawindexed_value(value: &str) -> Option<(usize, usize)> {
    let mut parts = value.split(',').map(|entry| entry.trim());
    let count = parts.next()?.parse::<usize>().ok()?;
    let first_index = parts.next()?.parse::<usize>().ok()?;
    Some((count, first_index))
}

fn collect_textureoverride_ib_resources(
    section_lines: &[String],
    sections: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    let mut resources = Vec::new();
    let mut seen = HashSet::new();

    for ib in collect_ib_resources_from_lines(section_lines) {
        if seen.insert(ib.clone()) {
            resources.push(ib);
        }
    }

    for run_target in collect_textureoverride_run_targets(section_lines, sections) {
        let Some(run_lines) = sections.get(&run_target) else {
            continue;
        };
        for ib in collect_ib_resources_from_lines(run_lines) {
            if seen.insert(ib.clone()) {
                resources.push(ib);
            }
        }
    }

    resources
}

fn normalize_ini_var_name(name: &str) -> String {
    let trimmed = name.trim().trim_start_matches('$').to_ascii_lowercase();
    format!("${trimmed}")
}

fn eval_ini_condition(condition: &str, vars: &HashMap<String, String>) -> bool {
    let normalized = condition.trim();
    if normalized.is_empty() {
        return false;
    }

    for term in normalized.split("&&") {
        let term = term.trim();
        if term.is_empty() {
            continue;
        }

        let is_match = if let Some((left, right)) = term.split_once("==") {
            let key = normalize_ini_var_name(left);
            let expected = right.trim().trim_matches('"').trim_start_matches('$').to_ascii_lowercase();
            let actual = vars
                .get(&key)
                .map(|value| value.trim().trim_matches('"').to_ascii_lowercase())
                .unwrap_or_default();
            actual == expected
        } else if let Some((left, right)) = term.split_once("!=") {
            let key = normalize_ini_var_name(left);
            let expected = right.trim().trim_matches('"').trim_start_matches('$').to_ascii_lowercase();
            let actual = vars
                .get(&key)
                .map(|value| value.trim().trim_matches('"').to_ascii_lowercase())
                .unwrap_or_default();
            actual != expected
        } else if term.starts_with('$') {
            let key = normalize_ini_var_name(term);
            let actual = vars
                .get(&key)
                .map(|value| value.trim().trim_matches('"').to_ascii_lowercase())
                .unwrap_or_default();
            !actual.is_empty() && actual != "0"
        } else {
            false
        };

        if !is_match {
            return false;
        }
    }

    true
}

fn trim_wrapping_parens(value: &str) -> &str {
    let mut out = value.trim();
    while out.starts_with('(') && out.ends_with(')') && out.len() >= 2 {
        out = out[1..out.len() - 1].trim();
    }
    out
}

fn eval_toggle_expression_term(term: &str, vars: &HashMap<String, String>) -> bool {
    let value = trim_wrapping_parens(term);
    if value.is_empty() {
        return false;
    }

    if let Some(stripped) = value.strip_prefix('!') {
        return !eval_toggle_expression_term(stripped, vars);
    }

    if let Some((left, right)) = value.split_once("==") {
        let key = normalize_ini_var_name(left);
        let expected = trim_wrapping_parens(right)
            .trim_matches('"')
            .trim_start_matches('$')
            .to_ascii_lowercase();
        let actual = vars
            .get(&key)
            .map(|entry| entry.trim().trim_matches('"').to_ascii_lowercase())
            .unwrap_or_default();
        return actual == expected;
    }

    if let Some((left, right)) = value.split_once("!=") {
        let key = normalize_ini_var_name(left);
        let expected = trim_wrapping_parens(right)
            .trim_matches('"')
            .trim_start_matches('$')
            .to_ascii_lowercase();
        let actual = vars
            .get(&key)
            .map(|entry| entry.trim().trim_matches('"').to_ascii_lowercase())
            .unwrap_or_default();
        return actual != expected;
    }

    if value.starts_with('$') {
        let key = normalize_ini_var_name(value);
        let actual = vars
            .get(&key)
            .map(|entry| entry.trim().trim_matches('"').to_ascii_lowercase())
            .unwrap_or_default();
        return !actual.is_empty() && actual != "0";
    }

    false
}

fn eval_toggle_expression(value: &str, vars: &HashMap<String, String>) -> bool {
    for or_term in value.split("||") {
        let and_ok = or_term
            .split("&&")
            .map(str::trim)
            .filter(|term| !term.is_empty())
            .all(|term| eval_toggle_expression_term(term, vars));
        if and_ok {
            return true;
        }
    }

    false
}

fn apply_commandlist_process_toggles_vars(
    sections: &HashMap<String, Vec<String>>,
    vars: &mut HashMap<String, String>,
) {
    let Some(lines) = sections.get("commandlistprocesstoggles") else {
        return;
    };

    for line in lines {
        let Some((key, value)) = parse_ini_assignment(line) else {
            continue;
        };
        if !key.starts_with('$') {
            continue;
        }
        if !key.starts_with("$draw_component_") {
            continue;
        }

        let enabled = eval_toggle_expression(&value, vars);
        vars.insert(key, if enabled { "1".to_string() } else { "0".to_string() });
    }
}

fn parse_ini_active_drawindexed_first_indices_for_vars(
    ini_path: &Path,
    vars: &HashMap<String, String>,
) -> Vec<u32> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let sections = parse_ini_sections(&raw);
    let mut working_vars = vars.clone();
    working_vars
        .entry("$mod_enabled".to_string())
        .or_insert_with(|| "1".to_string());

    apply_commandlist_process_toggles_vars(&sections, &mut working_vars);

    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for (section_name, lines) in &sections {
        if !section_name.starts_with("textureoverride") {
            continue;
        }

        let assignments = collect_active_ini_assignments(lines, &working_vars);
        for (key, value) in assignments {
            if key != "drawindexed" {
                continue;
            }

            let Some((count, first_index)) = parse_drawindexed_value(&value) else {
                continue;
            };
            if count == 0 {
                continue;
            }

            let marker = first_index as u32;
            if seen.insert(marker) {
                out.push(marker);
            }
        }
    }

    out.sort_unstable();
    out
}

#[derive(Clone, Copy)]
struct IniIfFrame {
    parent_active: bool,
    current_active: bool,
    any_taken: bool,
}

fn collect_active_ini_assignments(
    lines: &[String],
    vars: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut stack: Vec<IniIfFrame> = Vec::new();
    let mut out = Vec::new();

    let is_effective_active = |frames: &[IniIfFrame]| -> bool {
        frames.iter().all(|frame| frame.current_active)
    };

    for raw_line in lines {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let lower = line.to_ascii_lowercase();
        if lower.starts_with("if ") {
            let condition = line[3..].trim();
            let parent_active = is_effective_active(&stack);
            let this_active = parent_active && eval_ini_condition(condition, vars);
            stack.push(IniIfFrame {
                parent_active,
                current_active: this_active,
                any_taken: this_active,
            });
            continue;
        }

        if lower.starts_with("else if ") {
            if let Some(frame) = stack.last_mut() {
                if !frame.parent_active || frame.any_taken {
                    frame.current_active = false;
                } else {
                    let condition = line[8..].trim();
                    let this_active = eval_ini_condition(condition, vars);
                    frame.current_active = this_active;
                    if this_active {
                        frame.any_taken = true;
                    }
                }
            }
            continue;
        }

        if lower == "else" {
            if let Some(frame) = stack.last_mut() {
                let this_active = frame.parent_active && !frame.any_taken;
                frame.current_active = this_active;
                if this_active {
                    frame.any_taken = true;
                }
            }
            continue;
        }

        if lower == "endif" {
            let _ = stack.pop();
            continue;
        }

        if !is_effective_active(&stack) {
            continue;
        }

        if let Some((key, value)) = parse_ini_assignment(line) {
            out.push((key, value));
        }
    }

    out
}

fn collect_run_targets_from_assignments(
    assignments: &[(String, String)],
    sections: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    let mut targets = Vec::new();
    let mut seen = HashSet::new();

    for (key, value) in assignments {
        if key != "run" {
            continue;
        }

        let candidate = value.to_ascii_lowercase();
        if sections.contains_key(&candidate) && seen.insert(candidate.clone()) {
            targets.push(candidate);
        }
    }

    targets
}

fn collect_ib_texture_slot_candidates_from_assignments(
    assignments: &[(String, String)],
) -> Vec<(String, HashMap<String, String>)> {
    let mut out = Vec::new();
    let mut current_ib: Option<String> = None;
    let mut current_ps_slots: HashMap<String, String> = HashMap::new();

    let flush = |out_map: &mut Vec<(String, HashMap<String, String>)>,
                 ib: &mut Option<String>,
                 slots: &mut HashMap<String, String>| {
        if let Some(resource) = ib.take() {
            if !slots.is_empty() {
                out_map.push((resource, slots.clone()));
            }
        }
        slots.clear();
    };

    for (key, value) in assignments {
        if key == "ib" {
            flush(&mut out, &mut current_ib, &mut current_ps_slots);
            if value.eq_ignore_ascii_case("null") {
                current_ib = None;
            } else {
                current_ib = Some(value.to_ascii_lowercase());
            }
        } else if key.starts_with("ps-t") {
            if current_ib.is_some() {
                current_ps_slots.insert(key.clone(), value.clone());
            }
        }
    }

    flush(&mut out, &mut current_ib, &mut current_ps_slots);
    out
}

fn parse_ini_ib_texture_by_resource_for_vars(
    ini_path: &Path,
    mod_root: &Path,
    vars: &HashMap<String, String>,
) -> HashMap<String, String> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let mut resource_files: HashMap<String, String> = HashMap::new();
    let mut current_resource: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.split(';').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = trimmed[1..trimmed.len() - 1].trim().to_string();
            if section.to_ascii_lowercase().starts_with("resource") {
                current_resource = Some(section.to_ascii_lowercase());
            } else {
                current_resource = None;
            }
            continue;
        }

        let Some(resource_name) = &current_resource else {
            continue;
        };
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("filename") {
            continue;
        }

        let file_name = value.trim().trim_matches('"').to_string();
        if !is_image_texture_name(&file_name) {
            continue;
        }
        resource_files.insert(resource_name.clone(), file_name);
    }

    let sections = parse_ini_sections(&raw);
    let mut out: HashMap<String, String> = HashMap::new();

    let apply_candidates = |pairs: Vec<(String, HashMap<String, String>)>, out_map: &mut HashMap<String, String>| {
        for (ib_resource, slot_resources) in pairs {
            let Some(resource_name) =
                select_override_texture_resource(&slot_resources, &resource_files, mod_root)
            else {
                continue;
            };

            let key = resource_name.to_ascii_lowercase();
            let Some(file_name) = resource_files.get(&key) else {
                continue;
            };

            let texture_path = mod_root.join(file_name);
            if texture_path.is_file() {
                out_map.insert(ib_resource.to_ascii_lowercase(), normalize_path(&texture_path));
            }
        }
    };

    fn collect_texture_candidates_for_section(
        section_name: &str,
        sections: &HashMap<String, Vec<String>>,
        vars: &HashMap<String, String>,
        visited: &mut HashSet<String>,
    ) -> Vec<(String, HashMap<String, String>)> {
        if !visited.insert(section_name.to_string()) {
            return Vec::new();
        }

        let mut out = Vec::new();
        let Some(lines) = sections.get(section_name) else {
            return out;
        };

        let assignments = collect_active_ini_assignments(lines, vars);
        out.extend(collect_ib_texture_slot_candidates_from_assignments(&assignments));

        for target in collect_run_targets_from_assignments(&assignments, sections) {
            out.extend(collect_texture_candidates_for_section(
                &target,
                sections,
                vars,
                visited,
            ));
        }

        out
    }

    for section_name in sections.keys() {
        if !section_name.starts_with("textureoverride") {
            continue;
        }

        let mut visited = HashSet::new();
        let pairs = collect_texture_candidates_for_section(section_name, &sections, vars, &mut visited);
        apply_candidates(pairs, &mut out);
    }

    out
}

fn collect_textureoverride_run_targets(
    lines: &[String],
    sections: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    let mut targets = Vec::new();
    let mut seen = HashSet::new();

    for line in lines {
        let Some((key, value)) = parse_ini_assignment(line) else {
            continue;
        };
        if key != "run" {
            continue;
        }

        let candidate = value.to_ascii_lowercase();
        if sections.contains_key(&candidate) && seen.insert(candidate.clone()) {
            targets.push(candidate);
        }
    }

    targets
}

fn collect_ib_resources_from_lines(lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for line in lines {
        let Some((key, value)) = parse_ini_assignment(line) else {
            continue;
        };
        if key != "ib" {
            continue;
        }
        if value.eq_ignore_ascii_case("null") {
            continue;
        }

        let normalized = value.to_ascii_lowercase();
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }

    out
}

fn collect_ib_texture_slot_candidates(lines: &[String]) -> Vec<(String, HashMap<String, String>)> {
    let mut out = Vec::new();
    let mut current_ib: Option<String> = None;
    let mut current_ps_slots: HashMap<String, String> = HashMap::new();

    let flush = |out_map: &mut Vec<(String, HashMap<String, String>)>,
                     ib: &mut Option<String>,
                     slots: &mut HashMap<String, String>| {
        if let Some(resource) = ib.take() {
            if !slots.is_empty() {
                out_map.push((resource, slots.clone()));
            }
        }
        slots.clear();
    };

    for line in lines {
        let Some((key, value)) = parse_ini_assignment(line) else {
            continue;
        };

        if key == "ib" {
            flush(&mut out, &mut current_ib, &mut current_ps_slots);
            if value.eq_ignore_ascii_case("null") {
                current_ib = None;
            } else {
                current_ib = Some(value.to_ascii_lowercase());
            }
        } else if key.starts_with("ps-t") {
            if current_ib.is_some() {
                current_ps_slots.insert(key, value);
            }
        }
    }

    flush(&mut out, &mut current_ib, &mut current_ps_slots);
    out
}

fn parse_ini_ib_first_index_by_resource(ini_path: &Path) -> HashMap<String, u32> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let sections = parse_ini_sections(&raw);
    let mut map = HashMap::new();

    for (section_name, lines) in &sections {
        if !section_name.starts_with("textureoverride") {
            continue;
        }

        let mut first_index: Option<u32> = None;
        for line in lines {
            let Some((key, value)) = parse_ini_assignment(line) else {
                continue;
            };
            if key == "match_first_index" {
                first_index = value.parse::<u32>().ok();
                break;
            }
        }

        let Some(index) = first_index else {
            continue;
        };

        for ib in collect_ib_resources_from_lines(lines) {
            map.insert(ib, index);
        }

        for run_target in collect_textureoverride_run_targets(lines, &sections) {
            let Some(run_lines) = sections.get(&run_target) else {
                continue;
            };
            for ib in collect_ib_resources_from_lines(run_lines) {
                map.insert(ib, index);
            }
        }
    }

    map
}

fn parse_ini_ib_texture_by_resource(ini_path: &Path, mod_root: &Path) -> HashMap<String, String> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let mut resource_files: HashMap<String, String> = HashMap::new();
    let mut current_resource: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.split(';').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = trimmed[1..trimmed.len() - 1].trim().to_string();
            if section.to_ascii_lowercase().starts_with("resource") {
                current_resource = Some(section.to_ascii_lowercase());
            } else {
                current_resource = None;
            }
            continue;
        }

        let Some(resource_name) = &current_resource else {
            continue;
        };
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("filename") {
            continue;
        }

        let file_name = value.trim().trim_matches('"').to_string();
        if !is_image_texture_name(&file_name) {
            continue;
        }
        resource_files.insert(resource_name.clone(), file_name);
    }

    let sections = parse_ini_sections(&raw);
    let mut out: HashMap<String, String> = HashMap::new();

    let apply_candidates = |pairs: Vec<(String, HashMap<String, String>)>, out_map: &mut HashMap<String, String>| {
        for (ib_resource, slot_resources) in pairs {
            let Some(resource_name) =
                select_override_texture_resource(&slot_resources, &resource_files, mod_root)
            else {
                continue;
            };

            let key = resource_name.to_ascii_lowercase();
            let Some(file_name) = resource_files.get(&key) else {
                continue;
            };

            let texture_path = mod_root.join(file_name);
            if texture_path.is_file() {
                out_map.insert(ib_resource.to_ascii_lowercase(), normalize_path(&texture_path));
            }
        }
    };

    for (section_name, lines) in &sections {
        if !section_name.starts_with("textureoverride") {
            continue;
        }

        apply_candidates(collect_ib_texture_slot_candidates(lines), &mut out);

        for run_target in collect_textureoverride_run_targets(lines, &sections) {
            let Some(run_lines) = sections.get(&run_target) else {
                continue;
            };
            apply_candidates(collect_ib_texture_slot_candidates(run_lines), &mut out);
        }
    }

    out
}

fn parse_ini_drawindexed_ranges_by_ib_resource(ini_path: &Path) -> HashMap<String, Vec<(usize, usize)>> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let sections = parse_ini_sections(&raw);
    let mut out: HashMap<String, Vec<(usize, usize)>> = HashMap::new();

    for (section_name, lines) in &sections {
        if !section_name.starts_with("textureoverride") {
            continue;
        }

        let ib_resources = collect_textureoverride_ib_resources(lines, &sections);
        if ib_resources.is_empty() {
            continue;
        }

        let mut ranges = Vec::new();
        let mut seen = HashSet::new();
        for line in lines {
            let Some((key, value)) = parse_ini_assignment(line) else {
                continue;
            };
            if key != "drawindexed" {
                continue;
            }

            let Some((count, first_index)) = parse_drawindexed_value(&value) else {
                continue;
            };
            if count == 0 {
                continue;
            }
            if seen.insert((count, first_index)) {
                ranges.push((count, first_index));
            }
        }

        if ranges.is_empty() {
            continue;
        }

        for ib in ib_resources {
            out.entry(ib.to_ascii_lowercase())
                .or_default()
                .extend(ranges.iter().copied());
        }
    }

    for values in out.values_mut() {
        values.sort_by_key(|(_, first_index)| *first_index);
        values.dedup();
    }

    out
}

fn parse_ini_ib_vertex_resources(ini_path: &Path) -> HashMap<String, HashMap<String, String>> {
    let raw = match fs::read_to_string(ini_path) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };

    let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current_section = String::new();
    let mut current_ib: Option<String> = None;
    let mut current_vb_slots: HashMap<String, String> = HashMap::new();

    let flush_override = |section: &str,
                          ib_resource: Option<String>,
                          vb_slots: &HashMap<String, String>,
                          out_map: &mut HashMap<String, HashMap<String, String>>| {
        if !section.to_ascii_lowercase().starts_with("textureoverride") {
            return;
        }
        let Some(ib) = ib_resource else {
            return;
        };
        if vb_slots.is_empty() {
            return;
        }
        out_map.insert(ib.to_ascii_lowercase(), vb_slots.clone());
    };

    for line in raw.lines() {
        let trimmed = line.split(';').next().unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            flush_override(&current_section, current_ib.take(), &current_vb_slots, &mut out);
            current_section = trimmed[1..trimmed.len() - 1].trim().to_string();
            current_ib = None;
            current_vb_slots.clear();
            continue;
        }

        if !current_section.to_ascii_lowercase().starts_with("textureoverride") {
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('"').to_string();
        if key == "ib" {
            current_ib = Some(value);
        } else if key.starts_with("vb") {
            current_vb_slots.insert(key, value);
        }
    }

    flush_override(&current_section, current_ib.take(), &current_vb_slots, &mut out);
    out
}

fn read_u32_indices(path: &Path, format: Option<&str>) -> Result<Vec<u32>, String> {
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }

    let wants_u16 = format
        .map(|value| value.to_ascii_lowercase().contains("r16"))
        .unwrap_or(false);
    if wants_u16 {
        let mut indices = Vec::with_capacity(bytes.len() / 2);
        for chunk in bytes.chunks_exact(2) {
            indices.push(u16::from_le_bytes([chunk[0], chunk[1]]) as u32);
        }
        return Ok(indices);
    }

    let wants_u32 = format
        .map(|value| value.to_ascii_lowercase().contains("r32"))
        .unwrap_or(false);
    if wants_u32 || bytes.len() % 4 == 0 {
        let mut indices = Vec::with_capacity(bytes.len() / 4);
        for chunk in bytes.chunks_exact(4) {
            indices.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        return Ok(indices);
    }

    let mut indices = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        indices.push(u16::from_le_bytes([chunk[0], chunk[1]]) as u32);
    }
    Ok(indices)
}

fn read_position_normal_buffer(path: &Path, stride: usize) -> Result<(Vec<[f32; 3]>, Vec<[f32; 3]>), String> {
    if stride < 12 {
        return Err("Position buffer stride is too small".to_string());
    }

    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    let count = bytes.len() / stride;
    let mut positions = Vec::with_capacity(count);
    let mut normals = Vec::with_capacity(count);

    for i in 0..count {
        let base = i * stride;
        let px = f32::from_le_bytes(bytes[base..base + 4].try_into().map_err(|_| "Invalid position buffer")?);
        let py = f32::from_le_bytes(bytes[base + 4..base + 8].try_into().map_err(|_| "Invalid position buffer")?);
        let pz = f32::from_le_bytes(bytes[base + 8..base + 12].try_into().map_err(|_| "Invalid position buffer")?);
        positions.push([px, py, pz]);

        if stride >= 24 {
            let nx = f32::from_le_bytes(bytes[base + 12..base + 16].try_into().map_err(|_| "Invalid normal buffer")?);
            let ny = f32::from_le_bytes(bytes[base + 16..base + 20].try_into().map_err(|_| "Invalid normal buffer")?);
            let nz = f32::from_le_bytes(bytes[base + 20..base + 24].try_into().map_err(|_| "Invalid normal buffer")?);
            normals.push([nx, ny, nz]);
        } else {
            normals.push([0.0, 1.0, 0.0]);
        }
    }

    Ok((positions, normals))
}

fn read_texcoord_buffer(path: &Path, stride: usize) -> Result<Vec<[f32; 2]>, String> {
    if stride < 8 {
        return Err("Texcoord buffer stride is too small".to_string());
    }

    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    let count = bytes.len() / stride;
    if count == 0 {
        return Ok(Vec::new());
    }

    let max_offset = stride.saturating_sub(8);
    let mut candidate_offsets = Vec::new();
    let mut offset = 0usize;
    while offset <= max_offset {
        candidate_offsets.push(offset);
        offset += 4;
    }

    let sample_count = count.min(64);
    let mut chosen_offset = 0usize;
    let mut chosen_score = i32::MIN;
    for cand in candidate_offsets {
        let mut score = 0i32;
        let mut valid = true;

        let mut prev_u: Option<f32> = None;
        let mut prev_v: Option<f32> = None;
        let mut varying_pairs = 0i32;
        for i in 0..sample_count {
            let base = i * stride + cand;
            let u = f32::from_le_bytes(bytes[base..base + 4].try_into().map_err(|_| "Invalid texcoord buffer")?);
            let v = f32::from_le_bytes(bytes[base + 4..base + 8].try_into().map_err(|_| "Invalid texcoord buffer")?);

            if !u.is_finite() || !v.is_finite() {
                valid = false;
                break;
            }

            if (-2.5..=2.5).contains(&u) && (-2.5..=2.5).contains(&v) {
                score += 3;
            }
            if (0.0..=1.5).contains(&u) && (0.0..=1.5).contains(&v) {
                score += 2;
            }

            if let (Some(pu), Some(pv)) = (prev_u, prev_v) {
                if (u - pu).abs() > 1e-6 || (v - pv).abs() > 1e-6 {
                    varying_pairs += 1;
                }
            }
            prev_u = Some(u);
            prev_v = Some(v);
        }

        if !valid {
            continue;
        }
        score += varying_pairs;
        if score > chosen_score {
            chosen_score = score;
            chosen_offset = cand;
        }
    }

    let mut uvs = Vec::with_capacity(count);
    for i in 0..count {
        let base = i * stride + chosen_offset;
        let u = f32::from_le_bytes(bytes[base..base + 4].try_into().map_err(|_| "Invalid texcoord buffer")?);
        let v = f32::from_le_bytes(bytes[base + 4..base + 8].try_into().map_err(|_| "Invalid texcoord buffer")?);
        uvs.push([u, v]);
    }
    Ok(uvs)
}

fn normalize_resource_name(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let trimmed = lower.strip_prefix("resource").unwrap_or(&lower);
    trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
}

fn strip_resource_suffix(value: &str, suffixes: &[&str]) -> String {
    for suffix in suffixes {
        if let Some(rest) = value.strip_suffix(suffix) {
            return rest.to_string();
        }
    }
    value.to_string()
}

fn common_prefix_len(left: &str, right: &str) -> usize {
    let mut count = 0usize;
    for (a, b) in left.chars().zip(right.chars()) {
        if a != b {
            break;
        }
        count += 1;
    }
    count
}

fn trailing_numeric_suffix(value: &str) -> Option<&str> {
    let (_, suffix) = value.rsplit_once('.')?;
    if suffix.chars().all(|ch| ch.is_ascii_digit()) {
        Some(suffix)
    } else {
        None
    }
}

fn best_resource_match(
    target: &str,
    candidates: &[(String, IniResourceBufferInfo)],
    suffixes: &[&str],
) -> Option<(String, IniResourceBufferInfo)> {
    let target_norm = strip_resource_suffix(&normalize_resource_name(target), suffixes);
    let target_variant = trailing_numeric_suffix(target);
    let mut best: Option<(i32, String, IniResourceBufferInfo)> = None;

    for (name, info) in candidates {
        let candidate_norm = strip_resource_suffix(&normalize_resource_name(name), suffixes);
        let candidate_variant = trailing_numeric_suffix(name);
        let mut score = common_prefix_len(&target_norm, &candidate_norm) as i32;
        if target_norm == candidate_norm {
            score += 10_000;
        } else if target_norm.contains(&candidate_norm) || candidate_norm.contains(&target_norm) {
            score += 500;
        }

        if let (Some(left), Some(right)) = (target_variant, candidate_variant) {
            if left == right {
                score += 2_000;
            } else {
                score -= 250;
            }
        }

        match &best {
            Some((best_score, best_name, _)) if score < *best_score || (score == *best_score && name > best_name) => {}
            _ => {
                best = Some((score, name.clone(), info.clone()));
            }
        }
    }

    best.map(|(_, name, info)| (name, info))
}

fn build_mod_binary_preview_mesh(mod_root: &Path, ini_path: Option<&Path>) -> Result<Option<PreviewMeshData>, String> {
    let Some(ini_path) = ini_path else {
        return Ok(None);
    };

    let resources = parse_ini_resource_buffers(ini_path);
    if resources.is_empty() {
        return Ok(None);
    }

    let mut position_resources: Vec<(String, IniResourceBufferInfo)> = Vec::new();
    let mut texcoord_resources: Vec<(String, IniResourceBufferInfo)> = Vec::new();
    let mut ib_resources: Vec<(String, IniResourceBufferInfo)> = Vec::new();

    for (name, info) in &resources {
        let Some(filename) = &info.filename else {
            continue;
        };
        let lower_file = filename.to_ascii_lowercase();
        let lower_name = name.to_ascii_lowercase();
        let lower_format = info.format.as_deref().unwrap_or_default().to_ascii_lowercase();
        let looks_like_uint_index_format = lower_format.contains("r16_uint")
            || lower_format.contains("r32_uint")
            || lower_format.contains("dxgi_format_r16_uint")
            || lower_format.contains("dxgi_format_r32_uint");

        let is_index_buffer = lower_file.ends_with(".ib")
            || (lower_file.ends_with(".buf")
                && (lower_name.contains("index")
                    || lower_name.ends_with("ib")
                    || looks_like_uint_index_format));

        if is_index_buffer {
            ib_resources.push((name.clone(), info.clone()));
            continue;
        }
        if lower_file.ends_with(".buf") && (lower_name.contains("position") || lower_file.contains("position")) {
            position_resources.push((name.clone(), info.clone()));
            continue;
        }
        if lower_file.ends_with(".buf") && (lower_name.contains("texcoord") || lower_file.contains("texcoord")) {
            texcoord_resources.push((name.clone(), info.clone()));
        }
    }

    if position_resources.is_empty() || ib_resources.is_empty() {
        return Ok(None);
    }

    position_resources.sort_by(|a, b| a.0.cmp(&b.0));
    texcoord_resources.sort_by(|a, b| a.0.cmp(&b.0));
    ib_resources.sort_by(|a, b| a.0.cmp(&b.0));

    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut normals: Vec<[f32; 3]> = Vec::new();
    let mut uvs: Vec<[f32; 2]> = Vec::new();
    let mut loaded_position_groups: HashMap<String, (u32, usize)> = HashMap::new();

    let first_index_by_ib_resource = parse_ini_ib_first_index_by_resource(ini_path);
    let draw_ranges_by_ib_resource = parse_ini_drawindexed_ranges_by_ib_resource(ini_path);
    let ib_vertex_resources = parse_ini_ib_vertex_resources(ini_path);
    let mut indices = Vec::new();
    let mut parts = Vec::new();

    for (resource_name, info) in ib_resources {
        let ib_key = resource_name.to_ascii_lowercase();
        let vb_overrides = ib_vertex_resources.get(&ib_key);

        let override_position = vb_overrides.and_then(|slots| {
            ["vb0", "vb1", "vb2", "vb3"].iter().find_map(|slot| {
                let target = slots.get(*slot)?;
                position_resources
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(target))
                    .cloned()
            })
        });

        let Some((position_name, position_info)) = override_position.or_else(|| {
            best_resource_match(
                &resource_name,
                &position_resources,
                &["position"],
            )
        }) else {
            continue;
        };

        let override_texcoord_name = vb_overrides.and_then(|slots| {
            ["vb0", "vb1", "vb2", "vb3"].iter().find_map(|slot| {
                let target = slots.get(*slot)?;
                texcoord_resources
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(target))
                    .map(|(name, _)| name.clone())
            })
        });
        let group_key = format!(
            "{}|{}",
            position_name.to_ascii_lowercase(),
            override_texcoord_name
                .as_deref()
                .unwrap_or_default()
                .to_ascii_lowercase()
        );

        let (vertex_offset, vertex_count) = if let Some(existing) = loaded_position_groups.get(&group_key) {
            *existing
        } else {
            let Some(pos_file) = position_info.filename.as_ref() else {
                continue;
            };
            let pos_path = mod_root.join(pos_file);
            if !pos_path.is_file() {
                continue;
            }

            let pos_stride = position_info.stride.unwrap_or(40);
            let (group_positions, group_normals) = read_position_normal_buffer(&pos_path, pos_stride)?;
            if group_positions.len() < 3 {
                continue;
            }

            let mut group_uvs = vec![[0.0_f32, 0.0_f32]; group_positions.len()];
            let texcoord_choice = if let Some(override_name) = &override_texcoord_name {
                texcoord_resources
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(override_name))
                    .cloned()
            } else {
                best_resource_match(
                    &position_name,
                    &texcoord_resources,
                    &["texcoord"],
                )
            };

            if let Some((_, tex_info)) = texcoord_choice {
                if let Some(tex_file) = tex_info.filename {
                    let tex_path = mod_root.join(tex_file);
                    if tex_path.is_file() {
                        let tex_stride = tex_info.stride.unwrap_or(20);
                        if let Ok(texcoords) = read_texcoord_buffer(&tex_path, tex_stride) {
                            let copy_count = group_uvs.len().min(texcoords.len());
                            group_uvs[..copy_count].copy_from_slice(&texcoords[..copy_count]);
                        }
                    }
                }
            }

            let offset = positions.len() as u32;
            let count = group_positions.len();
            positions.extend(group_positions);
            normals.extend(group_normals);
            uvs.extend(group_uvs);
            loaded_position_groups.insert(group_key, (offset, count));
            (offset, count)
        };

        let Some(file_name) = info.filename else {
            continue;
        };
        let ib_path = mod_root.join(&file_name);
        if !ib_path.is_file() {
            continue;
        }

        let raw_indices = read_u32_indices(&ib_path, info.format.as_deref())?;
        if raw_indices.len() < 3 {
            continue;
        }
        let file_stem = Path::new(&file_name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(&resource_name);
        let ib_key = resource_name.to_ascii_lowercase();
        let draw_ranges = draw_ranges_by_ib_resource
            .get(&ib_key)
            .cloned()
            .unwrap_or_default();

        let mut append_range = |range_count: usize, range_start: usize, first_index_hint: Option<u32>| {
            if range_start >= raw_indices.len() || range_count == 0 {
                return;
            }

            let range_end = range_start.saturating_add(range_count).min(raw_indices.len());
            let part_start = indices.len();
            for tri in raw_indices[range_start..range_end].chunks_exact(3) {
                let a = tri[0] as usize;
                let b = tri[1] as usize;
                let c = tri[2] as usize;
                if a >= vertex_count || b >= vertex_count || c >= vertex_count {
                    continue;
                }
                indices.push(tri[0] + vertex_offset);
                indices.push(tri[1] + vertex_offset);
                indices.push(tri[2] + vertex_offset);
            }

            let part_count = indices.len().saturating_sub(part_start);
            if part_count == 0 {
                return;
            }

            let first_index = first_index_hint.or_else(|| Some(range_start as u32));
            let first_index_label = first_index.map(|value| format!("fi{value}")).unwrap_or_default();
            parts.push(PreviewMeshPart {
                name: format!("{}_{}_{}", resource_name, first_index_label, file_stem),
                index_start: part_start,
                index_count: part_count,
                first_index,
                ib_resource: Some(resource_name.clone()),
            });
        };

        if draw_ranges.is_empty() {
            append_range(
                raw_indices.len(),
                0,
                first_index_by_ib_resource.get(&ib_key).copied(),
            );
        } else {
            for (count, first_index) in draw_ranges {
                append_range(count, first_index, Some(first_index as u32));
            }
        }
    }

    if indices.len() < 3 {
        return Ok(None);
    }

    Ok(Some(PreviewMeshData {
        positions,
        normals,
        uvs,
        indices,
        parts,
    }))
}

fn score_texture_for_part(part_name: &str, texture_path: &Path) -> i32 {
    let lower_part = part_name.to_ascii_lowercase();
    let file_name = texture_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let file_stem = texture_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let normalized_part = sanitize_material_name(&lower_part);
    let mut score = score_diffuse_candidate(&file_name);

    if !normalized_part.is_empty() {
        if file_name.contains(&normalized_part) {
            score += 150;
        }

        for token in normalized_part.split('_').filter(|token| token.len() >= 3) {
            if file_name.contains(token) {
                score += 35;
            }
        }
    }

    let part_tokens = extract_alnum_tokens(&normalized_part, 3);
    let file_tokens = extract_alnum_tokens(&file_stem, 3);
    for token in &part_tokens {
        if file_tokens.iter().any(|item| item == token) {
            score += 32;
        }
    }

    let part_hex: Vec<&String> = part_tokens.iter().filter(|token| looks_like_hex_token(token)).collect();
    let file_hex: Vec<&String> = file_tokens.iter().filter(|token| looks_like_hex_token(token)).collect();
    for token in &part_hex {
        if file_hex.iter().any(|item| *item == *token) {
            score += 220;
        }
    }

    if normalized_part.contains("head") && file_name.contains("head") {
        score += 55;
    }
    if normalized_part.contains("hair") && file_name.contains("hair") {
        score += 55;
    }
    if normalized_part.contains("body") && file_name.contains("body") {
        score += 55;
    }
    if normalized_part.contains("dress") && file_name.contains("dress") {
        score += 45;
    }

    if file_name.contains("normal") || file_name.contains("light") || file_name.contains("mask") {
        score -= 90;
    }

    score
}

fn build_preview_texture_bindings(
    parts: &[PreviewMeshPart],
    mod_root: &Path,
    ini_first_index_map: &HashMap<u32, String>,
    ini_ib_texture_map: &HashMap<String, String>,
) -> HashMap<String, String> {
    let textures = collect_mod_texture_candidates(mod_root);
    let mut bindings = HashMap::new();

    for part in parts {
        let key = sanitize_material_name(&part.name);
        if key.is_empty() {
            continue;
        }

        if let Some(first_index) = part.first_index {
            if let Some(mapped) = ini_first_index_map.get(&first_index) {
                bindings.insert(key, mapped.clone());
                continue;
            }
        }

        if let Some(ib_resource) = &part.ib_resource {
            if let Some(mapped) = ini_ib_texture_map.get(&ib_resource.to_ascii_lowercase()) {
                bindings.insert(key, mapped.clone());
                continue;
            }
        }

        let mut best: Option<(i32, PathBuf)> = None;
        for texture_path in &textures {
            let score = score_texture_for_part(&part.name, texture_path);
            if score <= 0 {
                continue;
            }

            match &best {
                Some((current, _)) if score <= *current => {}
                _ => {
                    best = Some((score, texture_path.clone()));
                }
            }
        }

        if let Some((_, texture_path)) = best {
            bindings.insert(key, normalize_path(&texture_path));
        }
    }

    bindings
}

#[derive(Debug, Clone)]
struct DumpVertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
}

#[derive(Debug, Clone)]
struct DumpVertexTemp {
    position: Option<[f32; 3]>,
    normal: Option<[f32; 3]>,
    uv: Option<[f32; 2]>,
}

#[derive(Debug, Clone)]
struct PreviewMeshData {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    uvs: Vec<[f32; 2]>,
    indices: Vec<u32>,
    parts: Vec<PreviewMeshPart>,
}

#[derive(Debug, Clone)]
struct PreviewMeshPart {
    name: String,
    index_start: usize,
    index_count: usize,
    first_index: Option<u32>,
    ib_resource: Option<String>,
}

#[derive(Debug, Clone)]
struct DumpPairSpec {
    key: String,
    vb_path: PathBuf,
    ib_path: PathBuf,
}

#[derive(Debug, Clone)]
struct DumpIbData {
    first_index: Option<u32>,
    triangles: Vec<[u32; 3]>,
}

fn parse_f32_triplet(payload: &str) -> Option<[f32; 3]> {
    let mut values = payload
        .split(',')
        .map(|value| value.trim().parse::<f32>().ok());
    Some([values.next()??, values.next()??, values.next()??])
}

fn parse_f32_pair(payload: &str) -> Option<[f32; 2]> {
    let mut values = payload
        .split(',')
        .map(|value| value.trim().parse::<f32>().ok());
    Some([values.next()??, values.next()??])
}

fn collect_dump_text_pairs(dump_root: &Path) -> Result<Vec<DumpPairSpec>, String> {
    let mut vb_map: HashMap<String, PathBuf> = HashMap::new();
    let mut ib_map: HashMap<String, PathBuf> = HashMap::new();
    let mut stack = vec![dump_root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }

            let Some(file_name_raw) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let file_name = file_name_raw.to_ascii_lowercase();
            if !file_name.ends_with(".txt") {
                continue;
            }

            if let Some((prefix, _)) = file_name.split_once("-vb0=") {
                vb_map.insert(prefix.to_string(), path.clone());
                continue;
            }

            if let Some((prefix, _)) = file_name.split_once("-ib=") {
                ib_map.insert(prefix.to_string(), path.clone());
            }
        }
    }

    let mut keys: Vec<String> = vb_map
        .keys()
        .filter(|key| ib_map.contains_key(*key))
        .cloned()
        .collect();
    keys.sort();

    let mut pairs = Vec::new();
    for key in keys {
        if let (Some(vb_path), Some(ib_path)) = (vb_map.get(&key), ib_map.get(&key)) {
            pairs.push(DumpPairSpec {
                key,
                vb_path: vb_path.clone(),
                ib_path: ib_path.clone(),
            });
        }
    }
    Ok(pairs)
}

fn parse_dump_vb(path: &Path) -> Result<Vec<Option<DumpVertex>>, String> {
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut vertices: HashMap<usize, DumpVertexTemp> = HashMap::new();
    let mut max_index: usize = 0;

    for line in raw.lines() {
        if !line.starts_with("vb0[") {
            continue;
        }

        let Some(end_bracket) = line.find(']') else {
            continue;
        };
        let Ok(vertex_index) = line[4..end_bracket].parse::<usize>() else {
            continue;
        };
        max_index = max_index.max(vertex_index);

        let entry = vertices.entry(vertex_index).or_insert(DumpVertexTemp {
            position: None,
            normal: None,
            uv: None,
        });

        if let Some((_, payload)) = line.split_once("POSITION:") {
            entry.position = parse_f32_triplet(payload);
            continue;
        }
        if let Some((_, payload)) = line.split_once("NORMAL:") {
            entry.normal = parse_f32_triplet(payload);
            continue;
        }
        if line.contains("TEXCOORD:") && !line.contains("TEXCOORD1:") {
            if let Some((_, payload)) = line.split_once("TEXCOORD:") {
                entry.uv = parse_f32_pair(payload);
            }
        }
    }

    let mut result = vec![None; max_index + 1];
    for (index, item) in vertices {
        let Some(position) = item.position else {
            continue;
        };
        result[index] = Some(DumpVertex {
            position,
            normal: item.normal.unwrap_or([0.0, 1.0, 0.0]),
            uv: item.uv.unwrap_or([0.0, 0.0]),
        });
    }

    Ok(result)
}

fn parse_dump_ib(path: &Path) -> Result<DumpIbData, String> {
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut first_index: Option<u32> = None;
    let mut triangles = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.to_ascii_lowercase().starts_with("first index:") {
            let value = trimmed
                .split_once(':')
                .map(|(_, rhs)| rhs.trim())
                .and_then(|rhs| rhs.parse::<u32>().ok());
            if value.is_some() {
                first_index = value;
            }
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() != 3 {
            continue;
        }

        let Ok(a) = parts[0].parse::<u32>() else {
            continue;
        };
        let Ok(b) = parts[1].parse::<u32>() else {
            continue;
        };
        let Ok(c) = parts[2].parse::<u32>() else {
            continue;
        };

        triangles.push([a, b, c]);
    }

    Ok(DumpIbData {
        first_index,
        triangles,
    })
}

fn build_dump_preview_mesh(dump_root: &Path) -> Result<Option<PreviewMeshData>, String> {
    let pairs = collect_dump_text_pairs(dump_root)?;
    if pairs.is_empty() {
        return Ok(None);
    }

    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut normals: Vec<[f32; 3]> = Vec::new();
    let mut uvs: Vec<[f32; 2]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut parts: Vec<PreviewMeshPart> = Vec::new();

    for pair in pairs {
        let vb_vertices = parse_dump_vb(&pair.vb_path)?;
        let ib_data = parse_dump_ib(&pair.ib_path)?;
        if vb_vertices.is_empty() || ib_data.triangles.is_empty() {
            continue;
        }

        let mut remap = vec![u32::MAX; vb_vertices.len()];
        for (vertex_index, maybe_vertex) in vb_vertices.iter().enumerate() {
            let Some(vertex) = maybe_vertex else {
                continue;
            };
            let mapped_index = positions.len() as u32;
            remap[vertex_index] = mapped_index;
            positions.push(vertex.position);
            normals.push(vertex.normal);
            uvs.push(vertex.uv);
        }

        let part_index_start = indices.len();
        for tri in ib_data.triangles {
            let a = tri[0] as usize;
            let b = tri[1] as usize;
            let c = tri[2] as usize;
            if a >= remap.len() || b >= remap.len() || c >= remap.len() {
                continue;
            }

            let ra = remap[a];
            let rb = remap[b];
            let rc = remap[c];
            if ra == u32::MAX || rb == u32::MAX || rc == u32::MAX {
                continue;
            }

            indices.push(ra);
            indices.push(rb);
            indices.push(rc);
        }

        let part_index_count = indices.len().saturating_sub(part_index_start);
        if part_index_count > 0 {
            parts.push(PreviewMeshPart {
                name: pair.key,
                index_start: part_index_start,
                index_count: part_index_count,
                first_index: ib_data.first_index,
                ib_resource: None,
            });
        }
    }

    if positions.len() < 3 || indices.len() < 3 {
        return Ok(None);
    }

    Ok(Some(PreviewMeshData {
        positions,
        normals,
        uvs,
        indices,
        parts,
    }))
}

fn create_preview_glb_from_mesh(output_path: &Path, mesh: &PreviewMeshData, metadata: &Value) -> Result<(), String> {
    if mesh.positions.is_empty() || mesh.indices.is_empty() {
        return Err("Mesh data is empty".to_string());
    }

    let mut position_bytes: Vec<u8> = Vec::with_capacity(mesh.positions.len() * 12);
    let mut normal_bytes: Vec<u8> = Vec::with_capacity(mesh.normals.len() * 12);
    let mut uv_bytes: Vec<u8> = Vec::with_capacity(mesh.uvs.len() * 8);

    let mut min = [f32::INFINITY, f32::INFINITY, f32::INFINITY];
    let mut max = [f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];

    for position in &mesh.positions {
        min[0] = min[0].min(position[0]);
        min[1] = min[1].min(position[1]);
        min[2] = min[2].min(position[2]);
        max[0] = max[0].max(position[0]);
        max[1] = max[1].max(position[1]);
        max[2] = max[2].max(position[2]);
        for component in position {
            position_bytes.extend_from_slice(&component.to_le_bytes());
        }
    }

    for normal in &mesh.normals {
        for component in normal {
            normal_bytes.extend_from_slice(&component.to_le_bytes());
        }
    }

    for uv in &mesh.uvs {
        uv_bytes.extend_from_slice(&uv[0].to_le_bytes());
        uv_bytes.extend_from_slice(&uv[1].to_le_bytes());
    }

    let mut binary = Vec::new();
    let position_offset = 0usize;
    binary.extend_from_slice(&position_bytes);
    while binary.len() % 4 != 0 {
        binary.push(0);
    }
    let normal_offset = binary.len();
    binary.extend_from_slice(&normal_bytes);
    while binary.len() % 4 != 0 {
        binary.push(0);
    }
    let uv_offset = binary.len();
    binary.extend_from_slice(&uv_bytes);
    while binary.len() % 4 != 0 {
        binary.push(0);
    }
    let mut buffer_views = vec![
        json!({ "buffer": 0, "byteOffset": position_offset, "byteLength": position_bytes.len(), "target": 34962 }),
        json!({ "buffer": 0, "byteOffset": normal_offset, "byteLength": normal_bytes.len(), "target": 34962 }),
        json!({ "buffer": 0, "byteOffset": uv_offset, "byteLength": uv_bytes.len(), "target": 34962 }),
    ];

    let mut accessors = vec![
        json!({
            "bufferView": 0,
            "componentType": 5126,
            "count": mesh.positions.len(),
            "type": "VEC3",
            "min": min,
            "max": max
        }),
        json!({
            "bufferView": 1,
            "componentType": 5126,
            "count": mesh.normals.len(),
            "type": "VEC3"
        }),
        json!({
            "bufferView": 2,
            "componentType": 5126,
            "count": mesh.uvs.len(),
            "type": "VEC2"
        }),
    ];

    let mut materials: Vec<Value> = Vec::new();
    let mut primitives: Vec<Value> = Vec::new();

    let parts = if mesh.parts.is_empty() {
        vec![PreviewMeshPart {
            name: "full_mesh".to_string(),
            index_start: 0,
            index_count: mesh.indices.len(),
            first_index: None,
            ib_resource: None,
        }]
    } else {
        mesh.parts.clone()
    };

    for (part_index, part) in parts.iter().enumerate() {
        let begin = part.index_start.min(mesh.indices.len());
        let end = (part.index_start + part.index_count).min(mesh.indices.len());
        if end <= begin {
            continue;
        }

        let mut part_index_bytes = Vec::with_capacity((end - begin) * 4);
        for idx in &mesh.indices[begin..end] {
            part_index_bytes.extend_from_slice(&idx.to_le_bytes());
        }

        let index_offset = binary.len();
        binary.extend_from_slice(&part_index_bytes);
        while binary.len() % 4 != 0 {
            binary.push(0);
        }

        let index_view = buffer_views.len();
        buffer_views.push(json!({
            "buffer": 0,
            "byteOffset": index_offset,
            "byteLength": part_index_bytes.len(),
            "target": 34963
        }));

        let index_accessor = accessors.len();
        accessors.push(json!({
            "bufferView": index_view,
            "componentType": 5125,
            "count": end - begin,
            "type": "SCALAR"
        }));

        let material_name = sanitize_material_name(&part.name);
        materials.push(json!({
            "name": if material_name.is_empty() { format!("part_{part_index}") } else { material_name },
            "pbrMetallicRoughness": {
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.95
            }
        }));

        primitives.push(json!({
            "attributes": {
                "POSITION": 0,
                "NORMAL": 1,
                "TEXCOORD_0": 2
            },
            "indices": index_accessor,
            "material": materials.len() - 1,
            "mode": 4
        }));
    }

    if primitives.is_empty() {
        return Err("No preview mesh primitives were generated.".to_string());
    }

    let gltf_json = json!({
        "asset": { "version": "2.0", "generator": "mod-manager-v2 dump preview builder" },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0, "name": "dump_preview" }],
        "meshes": [{
            "name": "dump_mesh",
            "primitives": primitives
        }],
        "materials": materials,
        "buffers": [{ "byteLength": binary.len() }],
        "bufferViews": buffer_views,
        "accessors": accessors,
        "extras": metadata,
    });

    let mut json_bytes = serde_json::to_vec(&gltf_json).map_err(|err| err.to_string())?;
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(0x20);
    }

    let mut glb = Vec::new();
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2u32.to_le_bytes());
    let total_length = 12 + 8 + json_bytes.len() + 8 + binary.len();
    glb.extend_from_slice(&(total_length as u32).to_le_bytes());
    glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&json_bytes);
    glb.extend_from_slice(&(binary.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"BIN\0");
    glb.extend_from_slice(&binary);

    fs::write(output_path, glb).map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
struct PreviewPartSpec {
    name: String,
    translation: [f32; 3],
    scale: [f32; 3],
}

fn collect_path_tokens_recursive(dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let token = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !token.is_empty() {
            out.push(token);
        }

        if path.is_dir() {
            collect_path_tokens_recursive(&path, out)?;
        }
    }

    Ok(())
}

fn contains_any_token(tokens: &[String], needles: &[&str]) -> bool {
    tokens.iter().any(|token| needles.iter().any(|needle| token.contains(needle)))
}

fn discover_preview_parts(dump_root: &Path, mod_root: &Path) -> Vec<PreviewPartSpec> {
    let mut tokens = Vec::new();
    let _ = collect_path_tokens_recursive(dump_root, &mut tokens);
    let _ = collect_path_tokens_recursive(mod_root, &mut tokens);

    let mut parts = Vec::new();
    let push_part = |parts: &mut Vec<PreviewPartSpec>, name: &str, translation: [f32; 3], scale: [f32; 3]| {
        parts.push(PreviewPartSpec {
            name: name.to_string(),
            translation,
            scale,
        });
    };

    if contains_any_token(&tokens, &["body", "torso", "dress"]) {
        push_part(&mut parts, "body", [0.0, 0.95, 0.0], [0.82, 1.12, 0.45]);
    }
    if contains_any_token(&tokens, &["dress", "skirt", "robe"]) {
        push_part(&mut parts, "dress", [0.0, 0.35, 0.0], [1.0, 1.28, 0.58]);
    }
    if contains_any_token(&tokens, &["head", "face", "eyes", "mask", "bangs", "hair", "headpiece"]) {
        push_part(&mut parts, "head", [0.0, 1.78, 0.0], [0.48, 0.56, 0.48]);
    }
    if contains_any_token(&tokens, &["hair", "bangs"]) {
        push_part(&mut parts, "hair", [0.0, 1.92, 0.0], [0.68, 0.86, 0.68]);
    }
    if contains_any_token(&tokens, &["bangs"]) {
        push_part(&mut parts, "bangs", [0.0, 1.73, 0.18], [0.56, 0.18, 0.10]);
    }
    if contains_any_token(&tokens, &["headpiece", "halo", "horn"]) {
        push_part(&mut parts, "headpiece", [0.0, 2.08, 0.0], [0.56, 0.18, 0.56]);
    }
    if contains_any_token(&tokens, &["mask"]) {
        push_part(&mut parts, "mask", [0.0, 1.63, 0.16], [0.34, 0.18, 0.08]);
    }
    if contains_any_token(&tokens, &["eyes", "eye"]) {
        push_part(&mut parts, "eyes", [0.0, 1.64, 0.22], [0.24, 0.06, 0.03]);
    }
    if contains_any_token(&tokens, &["veil", "veilhead"]) {
        push_part(&mut parts, "veil", [0.0, 1.48, -0.08], [0.95, 0.9, 0.08]);
    }
    if contains_any_token(&tokens, &["wing"]) {
        push_part(&mut parts, "wing_left", [-1.02, 1.48, 0.08], [0.26, 0.78, 0.10]);
        push_part(&mut parts, "wing_right", [1.02, 1.48, 0.08], [0.26, 0.78, 0.10]);
    }
    if contains_any_token(&tokens, &["transparency", "transparent", "extra"]) {
        push_part(&mut parts, "transparency", [0.0, 0.84, 0.20], [0.92, 1.1, 0.1]);
    }

    if parts.is_empty() {
        push_part(&mut parts, "body", [0.0, 0.95, 0.0], [0.82, 1.12, 0.45]);
        push_part(&mut parts, "head", [0.0, 1.78, 0.0], [0.48, 0.56, 0.48]);
        push_part(&mut parts, "hair", [0.0, 1.92, 0.0], [0.68, 0.86, 0.68]);
        push_part(&mut parts, "dress", [0.0, 0.35, 0.0], [1.0, 1.28, 0.58]);
    }

    parts
}

fn create_cube_mesh_glb(output_path: &Path, parts: &[PreviewPartSpec], metadata: &Value) -> Result<(), String> {
    let faces: [([f32; 3], [[f32; 3]; 4]); 6] = [
        ([0.0, 0.0, 1.0], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]),
        ([0.0, 0.0, -1.0], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]),
        ([1.0, 0.0, 0.0], [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]),
        ([-1.0, 0.0, 0.0], [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]]),
        ([0.0, 1.0, 0.0], [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]]),
        ([0.0, -1.0, 0.0], [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]),
    ];

    let mut positions = Vec::new();
    let mut normals = Vec::new();
    let mut indices = Vec::new();

    for (face_index, (normal, corners)) in faces.iter().enumerate() {
        let base = (face_index * 4) as u16;
        for corner in corners {
            for component in corner {
                positions.extend_from_slice(&component.to_le_bytes());
            }
            for component in normal {
                normals.extend_from_slice(&component.to_le_bytes());
            }
        }
        indices.extend_from_slice(&base.to_le_bytes());
        indices.extend_from_slice(&(base + 1).to_le_bytes());
        indices.extend_from_slice(&(base + 2).to_le_bytes());
        indices.extend_from_slice(&base.to_le_bytes());
        indices.extend_from_slice(&(base + 2).to_le_bytes());
        indices.extend_from_slice(&(base + 3).to_le_bytes());
    }

    let mut binary = Vec::new();
    let position_offset = 0usize;
    binary.extend_from_slice(&positions);
    while binary.len() % 4 != 0 {
        binary.push(0);
    }
    let normal_offset = binary.len();
    binary.extend_from_slice(&normals);
    while binary.len() % 4 != 0 {
        binary.push(0);
    }
    let index_offset = binary.len();
    binary.extend_from_slice(&indices);
    while binary.len() % 4 != 0 {
        binary.push(0);
    }

    let nodes: Vec<Value> = parts
        .iter()
        .map(|part| {
            json!({
                "mesh": 0,
                "translation": part.translation,
                "scale": part.scale,
                "name": part.name,
            })
        })
        .collect();
    let scene_nodes: Vec<usize> = (0..parts.len()).collect();

    let gltf_json = json!({
        "asset": { "version": "2.0", "generator": "mod-manager-v2 preview builder" },
        "scene": 0,
        "scenes": [{ "nodes": scene_nodes }],
        "nodes": nodes,
        "meshes": [{
            "name": "preview_cube",
            "primitives": [{
                "attributes": { "POSITION": 0, "NORMAL": 1 },
                "indices": 2,
                "material": 0,
                "mode": 4
            }]
        }],
        "materials": [{
            "name": "preview_material",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.88, 0.88, 0.95, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.92
            }
        }],
        "buffers": [{ "byteLength": binary.len() }],
        "bufferViews": [
            { "buffer": 0, "byteOffset": position_offset, "byteLength": positions.len(), "target": 34962 },
            { "buffer": 0, "byteOffset": normal_offset, "byteLength": normals.len(), "target": 34962 },
            { "buffer": 0, "byteOffset": index_offset, "byteLength": indices.len(), "target": 34963 }
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 24,
                "type": "VEC3",
                "min": [-0.5, -0.5, -0.5],
                "max": [0.5, 0.5, 0.5]
            },
            {
                "bufferView": 1,
                "componentType": 5126,
                "count": 24,
                "type": "VEC3"
            },
            {
                "bufferView": 2,
                "componentType": 5123,
                "count": 36,
                "type": "SCALAR"
            }
        ],
        "extras": metadata,
    });

    let mut json_bytes = serde_json::to_vec(&gltf_json).map_err(|err| err.to_string())?;
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(0x20);
    }

    let mut glb = Vec::new();
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2u32.to_le_bytes());
    let total_length = 12 + 8 + json_bytes.len() + 8 + binary.len();
    glb.extend_from_slice(&(total_length as u32).to_le_bytes());
    glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&json_bytes);
    glb.extend_from_slice(&(binary.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"BIN\0");
    glb.extend_from_slice(&binary);

    fs::write(output_path, glb).map_err(|err| err.to_string())
}

fn encode_texture_as_png(source_path: &Path) -> Result<Vec<u8>, String> {
    let ext = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if ext == "dds" {
        let bytes = fs::read(source_path).map_err(|err| err.to_string())?;
        let mut cursor = Cursor::new(&bytes);
        let dds = Dds::read(&mut cursor).map_err(|err| format!("Failed to parse DDS: {err}"))?;
        let image = image_dds::image_from_dds(&dds, 0)
            .map_err(|err| format!("Failed to decode DDS: {err}"))?;

        let mut encoded_png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut encoded_png), ImageFormat::Png)
            .map_err(|err| format!("Failed to encode PNG: {err}"))?;
        return Ok(encoded_png);
    }

    let bytes = fs::read(source_path).map_err(|err| err.to_string())?;
    let image = image::load_from_memory(&bytes)
        .map_err(|err| format!("Failed to decode image: {err}"))?;

    let mut encoded_png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut encoded_png), ImageFormat::Png)
        .map_err(|err| format!("Failed to encode PNG: {err}"))?;
    Ok(encoded_png)
}

fn build_preview_texture_png_cache(
    output_root: &Path,
    bindings: &HashMap<String, String>,
) -> HashMap<String, String> {
    if bindings.is_empty() {
        return HashMap::new();
    }

    let textures_dir = output_root.join("textures");
    if fs::create_dir_all(&textures_dir).is_err() {
        return bindings.clone();
    }

    let mut next = HashMap::new();
    let mut used_names = HashSet::new();

    for (material_key, source_path) in bindings {
        let source = PathBuf::from(source_path);
        if !source.is_file() {
            next.insert(material_key.clone(), source_path.clone());
            continue;
        }

        let mut file_stem = sanitize_material_name(material_key);
        if file_stem.is_empty() {
            file_stem = "texture".to_string();
        }

        let mut candidate = file_stem.clone();
        let mut counter = 2usize;
        while !used_names.insert(candidate.clone()) {
            candidate = format!("{file_stem}_{counter}");
            counter += 1;
        }

        let target = textures_dir.join(format!("{candidate}.png"));
        match encode_texture_as_png(&source)
            .and_then(|png_bytes| fs::write(&target, png_bytes).map_err(|err| err.to_string()))
        {
            Ok(_) => {
                next.insert(material_key.clone(), normalize_path(&target));
            }
            Err(_) => {
                next.insert(material_key.clone(), source_path.clone());
            }
        }
    }

    next
}

fn replace_dir_contents(src: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|err| err.to_string())?;
    }
    copy_dir_recursive(src, dest)
}

fn ensure_custom_fixes_scaffold(resources_dir: &Path) -> Result<(), String> {
    let custom_root = resources_dir.join(CUSTOM_FIXES_DIR_NAME);
    fs::create_dir_all(&custom_root).map_err(|err| err.to_string())?;

    for game in STOCK_GAME_KEYS {
        let per_game = custom_root.join(game);
        fs::create_dir_all(&per_game).map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn ensure_dev_app_scaffold(install_base: &Path) -> Result<(), String> {
    let app_root = install_base.join("app");
    fs::create_dir_all(&app_root).map_err(|err| err.to_string())?;
    fs::create_dir_all(app_root.join("icon")).map_err(|err| err.to_string())?;
    fs::create_dir_all(app_root.join("all")).map_err(|err| err.to_string())?;

    for game in STOCK_GAME_KEYS {
        fs::create_dir_all(app_root.join(game)).map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn ensure_runtime_tools_scaffold(install_base: &Path) -> Result<(), String> {
    let tools_dir = install_base.join("tools");
    fs::create_dir_all(&tools_dir).map_err(|err| err.to_string())?;

    // Move/sync extractor binaries from bundled app paths so clean systems do
    // not require a separate 7-Zip installation.
    let mut source_dirs: Vec<(PathBuf, bool)> = vec![(install_base.join("resources").join("tools"), true)];

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            source_dirs.push((exe_dir.join("resources").join("tools"), true));
            source_dirs.push((exe_dir.join("tools"), false));
        }
    }

    let tool_names = ["7za.exe", "7z.exe", "7zz.exe", "7zr.exe", "7z.dll"];
    for (source_dir, move_out_of_source) in source_dirs {
        if !source_dir.is_dir() {
            continue;
        }

        if source_dir == tools_dir {
            continue;
        }

        for tool_name in tool_names {
            let src = source_dir.join(tool_name);
            let dst = tools_dir.join(tool_name);
            if !src.is_file() {
                continue;
            }

            if move_out_of_source {
                if fs::rename(&src, &dst).is_err() {
                    if fs::copy(&src, &dst).is_ok() {
                        let _ = fs::remove_file(&src);
                    }
                }
            } else if !dst.is_file() {
                let _ = fs::copy(&src, &dst);
            }
        }

        if move_out_of_source {
            let _ = fs::remove_dir(&source_dir);
        }
    }

    Ok(())
}

fn push_unique_dev_base(candidates: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf) {
    let key = normalize_path(&path).to_ascii_lowercase();
    if seen.insert(key) {
        candidates.push(path);
    }
}

fn dev_app_base_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            push_unique_dev_base(&mut candidates, &mut seen, exe_dir.to_path_buf());
        }
    }

    if let Ok(resources_dir) = resolve_resources_dir() {
        if let Some(install_base) = resources_dir.parent() {
            push_unique_dev_base(&mut candidates, &mut seen, install_base.to_path_buf());
        }
    }

    if let Some(base) = resolve_install_base() {
        push_unique_dev_base(&mut candidates, &mut seen, base);
    }

    if let Ok(cwd) = std::env::current_dir() {
        push_unique_dev_base(&mut candidates, &mut seen, cwd);
    }

    candidates
}

fn dir_has_any_file(dir: &Path) -> bool {
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .any(|entry| entry.path().is_file())
}

fn dev_app_base_score(base: &Path) -> usize {
    let app_root = base.join("app");
    if !app_root.is_dir() {
        return 0;
    }

    let mut score = 100usize;
    if dir_has_any_file(&app_root.join("icon")) {
        score += 30;
    }
    if first_supported_image_in_dir(&app_root.join("all")).is_some() {
        score += 20;
    }
    if STOCK_GAME_KEYS
        .iter()
        .any(|game| first_supported_image_in_dir(&app_root.join(game)).is_some())
    {
        score += 10;
    }

    score
}

fn resolve_best_dev_app_base() -> Option<PathBuf> {
    let candidates = dev_app_base_candidates();
    if candidates.is_empty() {
        return None;
    }

    let mut best: Option<(usize, PathBuf)> = None;
    for candidate in candidates {
        let score = dev_app_base_score(&candidate);
        match &best {
            Some((best_score, _)) if *best_score >= score => {}
            _ => {
                best = Some((score, candidate));
            }
        }
    }

    if let Some((score, base)) = best {
        if score > 0 {
            return Some(base);
        }
    }

    dev_app_base_candidates().into_iter().next()
}

fn apply_dev_icon_to_main_window(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(dev_base) = resolve_best_dev_app_base() else {
        return Ok(None);
    };

    ensure_dev_app_scaffold(&dev_base)?;

    let Some(custom_icon_path) = resolve_dev_icon_candidate(&dev_base) else {
        return Ok(None);
    };

    let icon_bytes = fs::read(&custom_icon_path).map_err(|err| err.to_string())?;
    let icon = Image::from_bytes(&icon_bytes).map_err(|err| err.to_string())?;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    window.set_icon(icon).map_err(|err| err.to_string())?;

    let shortcut_refresh = apply_dev_shortcut_icons(&custom_icon_path)
        .map(|count| format!("; shortcuts refreshed: {count}"))
        .unwrap_or_else(|err| format!("; shortcut refresh failed: {err}"));

    Ok(Some(format!(
        "{}{}",
        normalize_path(&custom_icon_path),
        shortcut_refresh
    )))
}

#[cfg(target_os = "windows")]
fn apply_dev_shortcut_icons(icon_path: &Path) -> Result<usize, String> {
    let icon_native = local_path(icon_path).replace('"', "\"\"").replace('\'', "''");
        let script = format!(
                r#"
$icon='{icon_native}'
$roots=@(
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:PUBLIC 'Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)
$wsh=New-Object -ComObject WScript.Shell
$count=0
foreach($root in $roots) {{
    if(-not (Test-Path $root)) {{ continue }}
    Get-ChildItem -Path $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {{
        try {{
            $sc=$wsh.CreateShortcut($_.FullName)
            $target="$($sc.TargetPath)"
            if([string]::IsNullOrWhiteSpace($target)) {{ return }}
            $leaf=[System.IO.Path]::GetFileName($target.Trim('"'))
            if($leaf -ieq 'mod-manager-v2.exe') {{
                $sc.IconLocation="$icon,0"
                $sc.Save()
                $count++
            }}
        }} catch {{}}
    }}
}}
Write-Output $count
"#
        );

    let output = background_command("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "Failed to refresh shortcut icons: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let count = String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| line.trim().parse::<usize>().ok())
        .unwrap_or(0);

    let _ = background_command("ie4uinit.exe").args(["-show"]).status();
    let _ = background_command("ie4uinit.exe").args(["-ClearIconCache"]).status();

    Ok(count)
}

#[cfg(not(target_os = "windows"))]
fn apply_dev_shortcut_icons(_icon_path: &Path) -> Result<usize, String> {
    Ok(0)
}

fn clear_dir_contents(dir: &Path) -> Result<usize, String> {
    if !dir.is_dir() {
        return Ok(0);
    }

    let mut removed = 0usize;
    for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|err| err.to_string())?;
        } else {
            fs::remove_file(&path).map_err(|err| err.to_string())?;
        }
        removed += 1;
    }

    Ok(removed)
}

fn purge_downloaded_stock_fixes(resources_dir: &Path) -> Result<usize, String> {
    let mut removed_total = 0usize;

    for game in STOCK_GAME_KEYS {
        let game_dir = resources_dir.join(game);
        removed_total += clear_dir_contents(&game_dir)?;
    }

    Ok(removed_total)
}

fn first_supported_image_in_dir(folder: &Path) -> Option<PathBuf> {
    let mut matches = fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|ext| {
                        DEV_BACKGROUND_EXTENSIONS
                            .iter()
                            .any(|allowed| allowed.eq_ignore_ascii_case(ext))
                    })
        })
        .collect::<Vec<_>>();

    matches.sort_by(|left, right| {
        left.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .cmp(
                &right
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase(),
            )
    });

    matches.into_iter().next()
}

fn resolve_dev_icon_candidate(install_base: &Path) -> Option<PathBuf> {
    let app_root = install_base.join("app");
    let icon_dir = app_root.join("icon");

    let mut candidates = Vec::new();

    for folder in [&icon_dir, &app_root] {
        if let Ok(entries) = fs::read_dir(folder) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }

                let ext = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();

                if ["ico", "png", "jpg", "jpeg", "webp", "bmp", "gif"]
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(&ext))
                {
                    candidates.push(path);
                }
            }
        }
    }

    candidates.sort_by(|left, right| {
        let left_ext = left
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let right_ext = right
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let left_priority = if left_ext == "ico" { 0 } else { 1 };
        let right_priority = if right_ext == "ico" { 0 } else { 1 };

        left_priority.cmp(&right_priority).then_with(|| {
            left.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .cmp(
                    &right
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default()
                        .to_ascii_lowercase(),
                )
        })
    });

    candidates.into_iter().next()
}

fn resolve_dev_background_candidate(
    install_base: &Path,
    game: &str,
    use_all_folder: bool,
) -> Option<PathBuf> {
    let app_root = install_base.join("app");

    if use_all_folder {
        return first_supported_image_in_dir(&app_root.join("all"));
    }

    first_supported_image_in_dir(&app_root.join(game))
}

fn resolve_extracted_resources_root(extract_root: &Path) -> PathBuf {
    let nested_resources = extract_root.join("resources");
    if nested_resources.is_dir() {
        return nested_resources;
    }

    if let Ok(entries) = fs::read_dir(extract_root) {
        let dirs = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();

        if dirs.len() == 1 {
            let inner = dirs[0].join("resources");
            if inner.is_dir() {
                return inner;
            }

            let looks_like_resources = STOCK_GAME_KEYS
                .iter()
                .any(|game| dirs[0].join(game).is_dir());
            if looks_like_resources {
                return dirs[0].clone();
            }
        }
    }

    extract_root.to_path_buf()
}

fn sync_resources_with_cleanup(extracted_root: &Path, resources_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(resources_dir).map_err(|err| err.to_string())?;

    let payload_root = resolve_extracted_resources_root(extracted_root);
    let install_base = resources_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| resources_dir.to_path_buf());

    for icon_folder in ICON_DIR_CANDIDATES {
        let source_icons = payload_root.join(icon_folder);
        if source_icons.is_dir() {
            let dest_name = if resources_dir.join("Icon").exists() {
                "Icon"
            } else if resources_dir.join("Icons").exists() {
                "Icons"
            } else {
                "icons"
            };
            let dest_icons = resources_dir.join(dest_name);
            replace_dir_contents(&source_icons, &dest_icons)?;
            break;
        }
    }

    for game in STOCK_GAME_KEYS {
        let source_game = payload_root.join(game);
        if source_game.is_dir() {
            let dest_game = resources_dir.join(game);
            replace_dir_contents(&source_game, &dest_game)?;
        }
    }

    // If the update payload ships extractor tools, keep install/tools in sync so
    // already-installed users get required binaries without reinstalling.
    let source_tools = payload_root.join("tools");
    if source_tools.is_dir() {
        let dest_tools = install_base.join("tools");
        fs::create_dir_all(&dest_tools).map_err(|err| err.to_string())?;
        for entry in fs::read_dir(&source_tools).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if path.is_file() {
                let file_name = entry.file_name();
                let _ = fs::copy(path, dest_tools.join(file_name));
            }
        }
    }

    ensure_custom_fixes_scaffold(resources_dir)?;
    Ok(())
}

fn read_ini_lines(path: &Path) -> Result<Vec<String>, String> {
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8(raw.clone())
        .or_else(|_| {
            raw.iter()
                .map(|&b| if b > 127 { Err(()) } else { Ok(b as char) })
                .collect::<Result<String, ()>>()
                .map_err(|_| "Non-UTF8 content".to_string())
        })
        .unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
    Ok(text.lines().map(str::to_owned).collect())
}

#[tauri::command]
fn save_ini_value(
    ini_path: String,
    section: String,
    new_key: String,
    new_back: Option<String>,
) -> Result<(), String> {
    if new_key.trim().is_empty() {
        return Err("key binding cannot be empty".to_string());
    }
    let path = PathBuf::from(&ini_path);
    if !path.is_file() {
        return Err(format!("INI file not found: {ini_path}"));
    }

    let lines = read_ini_lines(&path)?;

    let mut new_lines: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut in_target = false;
    let mut key_replaced = false;
    let mut back_replaced = false;
    let mut key_line_pos: Option<usize> = None;

    for raw_line in &lines {
        let stripped = raw_line.trim();

        // Track section header
        if stripped.starts_with('[') && stripped.ends_with(']') {
            in_target = stripped[1..stripped.len() - 1] == section;
        }

        if in_target {
            // Replace key =
            if !key_replaced {
                if let Some(eq) = find_assignment(stripped, "key") {
                    let prefix = &raw_line[..raw_line.len() - raw_line.trim_start().len()];
                    new_lines.push(format!("{prefix}{eq} = {}", new_key.trim()));
                    key_replaced = true;
                    key_line_pos = Some(new_lines.len() - 1);
                    continue;
                }
            }
            // Replace or drop back =
            if find_assignment(stripped, "back").is_some() {
                match &new_back {
                    Some(b) if !b.trim().is_empty() => {
                        let prefix = &raw_line[..raw_line.len() - raw_line.trim_start().len()];
                        new_lines.push(format!("{prefix}back = {}", b.trim()));
                        back_replaced = true;
                    }
                    _ => {} // drop the line (removes back=)
                }
                continue;
            }
        }

        new_lines.push(raw_line.clone());
    }

    // If user supplied a back= but it didn't exist, insert after key= line
    if let (Some(b), Some(pos)) = (&new_back, key_line_pos) {
        if !b.trim().is_empty() && !back_replaced {
            new_lines.insert(pos + 1, format!("back = {}", b.trim()));
        }
    }

    if !key_replaced {
        return Err(format!("Could not find 'key =' in [{section}]"));
    }

    let content = new_lines.join("\n");
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns the part before `=` if the trimmed line matches `name =` (case-insensitive).
fn find_assignment<'a>(trimmed: &'a str, name: &'a str) -> Option<&'a str> {
    let lower = trimmed.to_ascii_lowercase();
    let prefix = format!("{} =", name.to_ascii_lowercase());
    let prefix2 = format!("{}=", name.to_ascii_lowercase());
    if lower.starts_with(&prefix) || lower.starts_with(&prefix2) {
        Some(name)
    } else {
        None
    }
}

fn strip_disabled_duplicate_prefix(name: &str) -> &str {
    let mut split = name.splitn(2, '_');
    let first = split.next().unwrap_or_default();
    let second = split.next();
    if !first.is_empty()
        && first.chars().all(|c| c.is_ascii_digit())
        && second.is_some()
    {
        second.unwrap_or(name)
    } else {
        name
    }
}

fn find_available_disabled_name(parent: &Path, base_name: &str) -> String {
    let primary = format!("DISABLED_{base_name}");
    if !parent.join(&primary).exists() {
        return primary;
    }

    let mut index: usize = 1;
    loop {
        let candidate = format!("DISABLED_{index}_{base_name}");
        if !parent.join(&candidate).exists() {
            return candidate;
        }
        index += 1;
    }
}

fn find_available_enabled_name(parent: &Path, base_name: &str) -> String {
    if !parent.join(base_name).exists() {
        return base_name.to_string();
    }

    let mut index: usize = 1;
    loop {
        let candidate = format!("{base_name}_copy{index}");
        if !parent.join(&candidate).exists() {
            return candidate;
        }
        index += 1;
    }
}

#[tauri::command]
fn batch_toggle_mods(item_path: String, enable: bool) -> Result<usize, String> {
    let dir = PathBuf::from(&item_path);
    if !dir.is_dir() {
        return Err(format!("Folder not found: {item_path}"));
    }

    let mut changed: usize = 0;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let is_disabled = name.starts_with("DISABLED_");

        let should_rename = if enable { is_disabled } else { !is_disabled };
        if !should_rename {
            continue;
        }

        let new_name = if enable {
            let stripped = name.trim_start_matches("DISABLED_");
            let base = strip_disabled_duplicate_prefix(stripped);
            find_available_enabled_name(&dir, base)
        } else {
            find_available_disabled_name(&dir, &name)
        };

        let new_path = dir.join(&new_name);
        fs::rename(&path, &new_path).map_err(|e| e.to_string())?;
        changed += 1;
    }
    Ok(changed)
}

fn find_mods_root(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(node) = current {
        let is_mods = node
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("mods"))
            .unwrap_or(false);
        if is_mods {
            return Some(node.to_path_buf());
        }
        current = node.parent();
    }
    None
}

fn collect_ini_files_recursive(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_ini_files_recursive(&path, out)?;
            continue;
        }
        let is_ini = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("ini"))
            .unwrap_or(false);
        if is_ini {
            out.push(path);
        }
    }
    Ok(())
}

fn extract_namespace(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some((left, right)) = trimmed.split_once('=') {
            if left.trim().eq_ignore_ascii_case("namespace") {
                let ns = right.trim();
                if !ns.is_empty() {
                    return Some(ns.to_string());
                }
            }
        }
    }
    None
}

fn parse_master_swapkeys(content: &str) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut by_path: HashMap<String, String> = HashMap::new();
    let mut by_namespace: HashMap<String, String> = HashMap::new();

    fn normalize_lhs(lhs: &str) -> String {
        let mut key = lhs.trim().replace('/', "\\").to_ascii_lowercase();
        if let Some(stripped) = key.strip_prefix("global ") {
            key = stripped.trim().to_string();
        }
        if let Some(stripped) = key.strip_prefix('$') {
            key = stripped.to_string();
        }
        if let Some(stripped) = key.strip_prefix('\\') {
            key = stripped.to_string();
        }
        key
    }

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
            continue;
        }

        let Some((left, right)) = trimmed.split_once('=') else {
            continue;
        };

        let key = normalize_lhs(left);

        let value = right
            .split(|c: char| c.is_whitespace() || c == ';' || c == '#')
            .find(|part| !part.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string();
        if value.is_empty() {
            continue;
        }

        // Namespace-style lookup can work with any normalized assignment key.
        by_namespace.insert(key.replace('\\', "."), value.clone());

        // Path-style lookup requires the traditional mods\... key prefix.
        if let Some(suffix) = key.strip_prefix("mods\\") {
            by_path.insert(suffix.to_string(), value.clone());
            by_namespace.insert(suffix.replace('\\', "."), value);
        }
    }

    (by_path, by_namespace)
}

#[tauri::command]
fn sync_global_persist_for_mod(mod_path: String, game_mod_root: Option<String>) -> Result<usize, String> {
    let mod_dir = PathBuf::from(&mod_path);
    if !mod_dir.is_dir() {
        return Err(format!("Mod folder not found: {mod_path}"));
    }

    let mods_root = if let Some(raw_root) = game_mod_root.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
        let root_path = PathBuf::from(raw_root);
        let is_mods = root_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("mods"))
            .unwrap_or(false);

        if is_mods {
            root_path
        } else {
            find_mods_root(&root_path)
                .ok_or_else(|| "Could not resolve selected game Mods folder from mod root.".to_string())?
        }
    } else {
        find_mods_root(&mod_dir)
            .ok_or_else(|| "Could not find parent Mods folder from selected mod path.".to_string())?
    };
    let mods_parent = mods_root
        .parent()
        .ok_or_else(|| "Could not determine Mods parent folder.".to_string())?;
    let master_ini_path = mods_parent.join("d3dx_user.ini");
    if !master_ini_path.is_file() {
        return Err(format!(
            "d3dx_user.ini not found at {}",
            normalize_path(&master_ini_path)
        ));
    }

    let master_content = fs::read_to_string(&master_ini_path).map_err(|err| err.to_string())?;
    let (mapping_by_path, mapping_by_namespace) = parse_master_swapkeys(&master_content);
    if mapping_by_path.is_empty() && mapping_by_namespace.is_empty() {
        return Err("No valid $mods mappings found in d3dx_user.ini".to_string());
    }

    let mut ini_files: Vec<PathBuf> = Vec::new();
    collect_ini_files_recursive(&mod_dir, &mut ini_files)?;

    let mut updated_files: usize = 0;

    for ini_path in ini_files {
        let file_name = ini_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_uppercase();
        if file_name.contains("DISABLED") {
            continue;
        }

        let raw = fs::read(&ini_path).map_err(|err| err.to_string())?;
        let content = String::from_utf8_lossy(&raw).into_owned();
        let namespace = extract_namespace(&content)
            .map(|ns| ns.replace(['\\', '/'], ".").to_ascii_lowercase());

        let rel_file = ini_path
            .strip_prefix(&mods_root)
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();

        let mut changed = false;
        let mut new_lines: Vec<String> = Vec::new();

        for line in content.lines() {
            let trimmed_start = line.trim_start();
            let lower = trimmed_start.to_ascii_lowercase();

            if lower.starts_with("global persist $") {
                let indent_len = line.len().saturating_sub(trimmed_start.len());
                let indent = &line[..indent_len];
                let rest = &trimmed_start["global persist $".len()..];

                if let Some((lhs, rhs)) = rest.split_once('=') {
                    let swap_key = lhs.trim();
                    if !swap_key.is_empty() {
                        let swap_key_lower = swap_key.to_ascii_lowercase();
                        let lookup = if let Some(ns) = &namespace {
                            mapping_by_namespace.get(&format!("{ns}.{swap_key_lower}"))
                        } else {
                            mapping_by_path.get(&format!("{rel_file}\\{swap_key_lower}"))
                        };

                        if let Some(new_value) = lookup {
                            let old_value = rhs
                                .split(|c: char| c.is_whitespace() || c == ';' || c == '#')
                                .find(|part| !part.trim().is_empty())
                                .unwrap_or("")
                                .trim();
                            if old_value != new_value {
                                new_lines.push(format!(
                                    "{indent}global persist ${swap_key} = {new_value}"
                                ));
                                changed = true;
                                continue;
                            }
                        }
                    }
                }
            }

            new_lines.push(line.to_string());
        }

        if changed {
            fs::write(&ini_path, new_lines.join("\n")).map_err(|err| err.to_string())?;
            updated_files += 1;
        }
    }

    Ok(updated_files)
}

fn sanitize_folder_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "mod".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_file_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "download.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

fn download_with_powershell(url: &str, destination: &Path) -> Result<(), String> {
    let url_quoted = escape_powershell_single_quoted(url);
    let out_quoted = escape_powershell_single_quoted(destination.to_string_lossy().as_ref());
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '{url_quoted}' -OutFile '{out_quoted}' -UseBasicParsing"
    );

    let output = background_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|err| format!("powershell not available: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "PowerShell download failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn download_to_path(url: &str, destination: &Path) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Invalid download URL".to_string());
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let output = background_command("curl")
        .args([
            "-L",
            "--fail",
            "-o",
            destination.to_str().unwrap_or_default(),
            url,
        ])
        .output();

    match output {
        Ok(curl_output) if curl_output.status.success() => return Ok(()),
        Ok(curl_output) => {
            if download_with_powershell(url, destination).is_ok() {
                return Ok(());
            }
            return Err(format!(
                "Download failed via curl and PowerShell. curl: {}",
                String::from_utf8_lossy(&curl_output.stderr)
            ));
        }
        Err(curl_err) => {
            download_with_powershell(url, destination).map_err(|ps_err| {
                format!("curl not available: {curl_err}; fallback also failed: {ps_err}")
            })?;
            return Ok(());
        }
    }
}

fn default_downloads_folder() -> Option<PathBuf> {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let downloads = PathBuf::from(user_profile).join("Downloads");
        return Some(downloads);
    }
    None
}

#[tauri::command]
fn get_default_downloads_folder() -> Result<String, String> {
    let folder = default_downloads_folder()
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| "Unable to determine default folder".to_string())?;
    Ok(normalize_path(&folder))
}

#[tauri::command]
fn default_downloads_dir() -> Result<String, String> {
    get_default_downloads_folder()
}

#[tauri::command]
fn download_file_to_folder(
    url: String,
    dest_folder: String,
    file_name: Option<String>,
) -> Result<String, String> {
    let trimmed_url = url.trim();
    if !trimmed_url.starts_with("https://") && !trimmed_url.starts_with("http://") {
        return Err("Invalid download URL".to_string());
    }

    let destination_dir = PathBuf::from(dest_folder.trim());
    fs::create_dir_all(&destination_dir).map_err(|err| err.to_string())?;

    let derived_name = file_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let path_part = trimmed_url.split('?').next().unwrap_or(trimmed_url);
            Path::new(path_part)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
        })
        .unwrap_or_else(|| "download.bin".to_string());

    let safe_name = sanitize_file_name(&derived_name);
    let mut destination_file = destination_dir.join(&safe_name);
    let mut idx: u32 = 1;
    while destination_file.exists() {
        let stem = Path::new(&safe_name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("download");
        let ext = Path::new(&safe_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let next_name = if ext.is_empty() {
            format!("{stem}_copy{idx}")
        } else {
            format!("{stem}_copy{idx}.{ext}")
        };
        destination_file = destination_dir.join(next_name);
        idx += 1;
    }

    let output = background_command("curl.exe")
        .args([
            "-L",
            "--fail",
            "-o",
            destination_file.to_str().unwrap_or_default(),
            trimmed_url,
        ])
        .output()
        .map_err(|err| format!("curl.exe not available: {err}"))?;

    if !output.status.success() {
        return Err(format!(
            "Download failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(normalize_path(&destination_file))
}

#[tauri::command]
fn ensure_buffer_values_folders(mod_paths: Value) -> Result<Vec<String>, String> {
    let mut created_for: Vec<String> = Vec::new();
    if let Value::Object(paths) = &mod_paths {
        for (game, path_val) in paths {
            if let Some(path_str) = path_val.as_str() {
                if !path_str.is_empty() {
                    let parent = PathBuf::from(path_str);
                    if parent.is_dir() {
                        let bv = parent.join("BufferValues");
                        if !bv.exists() {
                            fs::create_dir_all(&bv).map_err(|err| err.to_string())?;
                            created_for.push(game.clone());
                        }
                    }
                }
            }
        }
    }
    Ok(created_for)
}

#[tauri::command]
fn create_mod_folder_scaffold(game: String, mod_root: String) -> Result<usize, String> {
    create_mod_folder_scaffold_internal(&game, &mod_root)
}

#[tauri::command]
fn create_missing_folders_all_paths() -> Result<Value, String> {
    let settings = load_settings_snapshot()?;
    let mut per_game = Map::new();
    let mut total_created = 0usize;

    let Some(paths) = settings.get("mod_paths").and_then(Value::as_object) else {
        return Ok(json!({
            "total_created": 0,
            "configured_games": 0,
            "results": {}
        }));
    };

    let mut configured_games = 0usize;
    for (game, value) in paths {
        let Some(mod_root_raw) = value.as_str() else {
            continue;
        };

        let mod_root = mod_root_raw.trim();
        if mod_root.is_empty() {
            continue;
        }

        configured_games += 1;

        match create_mod_folder_scaffold_internal(game, mod_root) {
            Ok(created) => {
                total_created += created;
                per_game.insert(
                    game.clone(),
                    json!({
                        "path": normalize_path(&PathBuf::from(mod_root)),
                        "created": created
                    }),
                );
            }
            Err(err) => {
                per_game.insert(
                    game.clone(),
                    json!({
                        "path": mod_root,
                        "error": err
                    }),
                );
            }
        }
    }

    Ok(json!({
        "total_created": total_created,
        "configured_games": configured_games,
        "results": per_game
    }))
}

fn create_mod_folder_scaffold_internal(game: &str, mod_root: &str) -> Result<usize, String> {
    let mod_root = mod_root.trim();
    if mod_root.is_empty() {
        return Err("Mod root path is empty".to_string());
    }

    let mod_root_path = PathBuf::from(mod_root);
    let resources_dir = resolve_resources_dir()?;
    let mut created = 0usize;

    let mut ensure_dir = |path: PathBuf| -> Result<(), String> {
        if !path.exists() {
            fs::create_dir_all(&path).map_err(|err| err.to_string())?;
            created += 1;
        }
        Ok(())
    };

    for category in CATEGORY_KEYS {
        let category_path = build_item_folder_path(&mod_root_path, category, None);
        ensure_dir(category_path.clone())?;

        if category.eq_ignore_ascii_case("buffervalues") {
            continue;
        }

        let mut item_ids = BTreeSet::new();
        for entry in read_json_array(&resources_dir.join(format!("{category}_{game}.json"))) {
            if let Some(id) = extract_item_id(&entry) {
                item_ids.insert(id);
            }
        }

        if category.eq_ignore_ascii_case("characters") {
            for entry in read_json_array(&resources_dir.join(format!("addedCharacters_{game}.json"))) {
                if let Some(id) = extract_item_id(&entry) {
                    item_ids.insert(id);
                }
            }
        }

        for item_id in item_ids {
            let item_path = build_item_folder_path(&mod_root_path, category, Some(&item_id));
            ensure_dir(item_path)?;
        }
    }

    Ok(created)
}

fn download_and_install_mod_blocking(
    url: String,
    dest_item_path: String,
    mod_name: String,
    preview_url: Option<String>,
) -> Result<DownloadInstallResult, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Invalid download URL".to_string());
    }

    let download_root = unique_temp_dir("modmgr_dl");
    fs::create_dir_all(&download_root).map_err(|err| err.to_string())?;

    let url_path = url.split('?').next().unwrap_or(&url);
    let raw_ext = Path::new(url_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("zip")
        .to_lowercase();
    let ext = if ["zip", "rar", "7z"].contains(&raw_ext.as_str()) {
        raw_ext
    } else {
        "zip".to_string()
    };

    let archive_path = download_root.join(format!("download.{ext}"));
    let dl_output = background_command("curl.exe")
        .args([
            "-L",
            "--fail",
            "--retry",
            "2",
            "--retry-delay",
            "1",
            "-A",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ModManagerV2",
            "-o",
            archive_path.to_str().unwrap_or_default(),
            &url,
        ])
        .output()
        .map_err(|err| format!("curl.exe not available: {err}"))?;

    if !dl_output.status.success() {
        let _ = fs::remove_dir_all(&download_root);
        return Err(format!(
            "Download failed: {}",
            String::from_utf8_lossy(&dl_output.stderr)
        ));
    }

    let result = install_archive_mod_blocking(
        archive_path.to_str().unwrap_or_default().to_string(),
        dest_item_path,
        mod_name,
        preview_url,
    );
    let _ = fs::remove_dir_all(&download_root);
    result
}

fn install_archive_mod_blocking(
    archive_path: String,
    dest_item_path: String,
    mod_name: String,
    preview_url: Option<String>,
) -> Result<DownloadInstallResult, String> {
    let source_archive = PathBuf::from(&archive_path);
    if !source_archive.is_file() {
        return Err(format!("Archive not found: {archive_path}"));
    }

    let safe_name = sanitize_folder_name(&mod_name);

    let temp_root = unique_temp_dir("modmgr_extract");
    fs::create_dir_all(&temp_root).map_err(|err| err.to_string())?;

    let raw_ext = source_archive
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("zip")
        .to_lowercase();
    let ext = raw_ext;

    let extract_dir = temp_root.join("extract");
    fs::create_dir_all(&extract_dir).map_err(|err| err.to_string())?;

    fn run_external_extractor(program: &Path, archive: &Path, out_dir: &Path) -> Result<std::process::Output, String> {
        let program_str = program.to_string_lossy().to_string();
        background_command(&program_str)
            .args([
                "x",
                archive.to_str().unwrap_or_default(),
                &format!("-o{}", out_dir.to_string_lossy()),
                "-y",
            ])
            .output()
            .map_err(|err| err.to_string())
    }

    fn extraction_result_is_usable(output: &std::process::Output, out_dir: &Path) -> bool {
        if output.status.success() {
            return true;
        }

        // 7-Zip often returns 1 for warnings while still extracting usable files.
        if output.status.code() == Some(1) {
            if let Ok(mut entries) = fs::read_dir(out_dir) {
                return entries.next().is_some();
            }
        }

        false
    }

    fn run_winrar_extractor(program: &Path, archive: &Path, out_dir: &Path) -> Result<std::process::Output, String> {
        let program_str = program.to_string_lossy().to_string();
        let mut out_arg = out_dir.to_string_lossy().to_string();
        if !out_arg.ends_with('\\') && !out_arg.ends_with('/') {
            out_arg.push('\\');
        }
        background_command(&program_str)
            .args([
                "x",
                "-ibck",
                "-y",
                archive.to_str().unwrap_or_default(),
                &out_arg,
            ])
            .output()
            .map_err(|err| err.to_string())
    }

    fn extract_with_7z_or_winrar(archive: &Path, out_dir: &Path) -> Result<std::process::Output, String> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|dir| dir.to_path_buf()));

        let mut candidates: Vec<PathBuf> = vec![
            PathBuf::from("7z"),
            PathBuf::from("7z.exe"),
            PathBuf::from("7zz"),
            PathBuf::from("7zz.exe"),
            PathBuf::from("7zr"),
            PathBuf::from("7zr.exe"),
            PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
            PathBuf::from(r"C:\Program Files\7-Zip\7zz.exe"),
            PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe"),
            PathBuf::from(r"C:\Program Files (x86)\7-Zip\7zz.exe"),
            PathBuf::from(r"C:\Program Files\WinRAR\UnRAR.exe"),
            PathBuf::from(r"C:\Program Files (x86)\WinRAR\UnRAR.exe"),
        ];

        if let Some(dir) = exe_dir {
            candidates.push(dir.join("7za.exe"));
            candidates.push(dir.join("7z.exe"));
            candidates.push(dir.join("7zz.exe"));
            candidates.push(dir.join("7zr.exe"));
            candidates.push(dir.join("tools").join("7za.exe"));
            candidates.push(dir.join("tools").join("7z.exe"));
            candidates.push(dir.join("tools").join("7zz.exe"));
            candidates.push(dir.join("tools").join("7zr.exe"));
            candidates.push(dir.join("resources").join("tools").join("7za.exe"));
            candidates.push(dir.join("resources").join("tools").join("7z.exe"));
            candidates.push(dir.join("resources").join("tools").join("7zz.exe"));
            candidates.push(dir.join("resources").join("tools").join("7zr.exe"));
            candidates.push(dir.join("bin").join("7za.exe"));
            candidates.push(dir.join("bin").join("7z.exe"));
            candidates.push(dir.join("bin").join("7zz.exe"));
            candidates.push(dir.join("bin").join("7zr.exe"));
        }

        let winrar_candidates = vec![
            PathBuf::from(r"C:\Program Files\WinRAR\WinRAR.exe"),
            PathBuf::from(r"C:\Program Files (x86)\WinRAR\WinRAR.exe"),
        ];

        candidates.extend(winrar_candidates.iter().cloned());

        // Discover extractors from PATH/custom installs.
        for name in ["7z", "7z.exe", "7zz", "7zz.exe", "7zr", "7zr.exe", "UnRAR.exe", "WinRAR.exe"] {
            if let Ok(output) = background_command("where")
                .args([name])
                .output()
            {
                if output.status.success() {
                    for line in String::from_utf8_lossy(&output.stdout).lines() {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            candidates.push(PathBuf::from(trimmed));
                        }
                    }
                }
            }
        }

        let mut unique_candidates: Vec<PathBuf> = Vec::new();
        for candidate in candidates {
            if !unique_candidates.iter().any(|seen| seen == &candidate) {
                unique_candidates.push(candidate);
            }
        }

        let mut saw_spawn_error = false;
        let mut last_output: Option<std::process::Output> = None;

        for candidate in unique_candidates {
            let is_winrar = candidate
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("winrar.exe"));

            let result = if is_winrar {
                run_winrar_extractor(&candidate, archive, out_dir)
            } else {
                run_external_extractor(&candidate, archive, out_dir)
            };

            match result {
                Ok(output) => {
                    if extraction_result_is_usable(&output, out_dir) {
                        return Ok(output);
                    }
                    last_output = Some(output);
                }
                Err(err) => {
                    let err_lower = err.to_lowercase();
                    if err_lower.contains("program not found")
                        || err_lower.contains("cannot find the file")
                        || err_lower.contains("the system cannot find")
                        || err_lower.contains("os error 2")
                    {
                        saw_spawn_error = true;
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        if let Some(output) = last_output {
            return Ok(output);
        }

        if saw_spawn_error {
            Err("No archive extractor found (7-Zip/WinRAR). Install 7-Zip or add it to PATH.".to_string())
        } else {
            Err("No working archive extractor found.".to_string())
        }
    }

    let run_expand_archive = || {
        background_command("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    source_archive.display(),
                    extract_dir.display()
                ),
            ])
            .output()
            .map_err(|err| format!("powershell not available: {err}"))
    };

    let run_tar_extract = || {
        background_command("tar")
            .args([
                "-xf",
                source_archive.to_str().unwrap_or_default(),
                "-C",
                extract_dir.to_str().unwrap_or_default(),
            ])
            .output()
            .map_err(|err| format!("tar not available: {err}"))
    };

    let extract_output = if ext == "zip" {
        match run_expand_archive() {
            Ok(output) if output.status.success() => output,
            Ok(output) if extraction_result_is_usable(&output, &extract_dir) => output,
            _ => match run_tar_extract() {
                Ok(output) if output.status.success() => output,
                Ok(output) if extraction_result_is_usable(&output, &extract_dir) => output,
                _ => extract_with_7z_or_winrar(&source_archive, &extract_dir)
                    .map_err(|err| format!("Extractor unavailable for zip archive: {err}"))?,
            },
        }
    } else {
        match run_tar_extract() {
            Ok(output) if output.status.success() => output,
            Ok(output) if extraction_result_is_usable(&output, &extract_dir) => output,
            _ => match extract_with_7z_or_winrar(&source_archive, &extract_dir) {
                Ok(output) => output,
                Err(extract_err) => match run_expand_archive() {
                    Ok(zip_output) => zip_output,
                    Err(_) => {
                        let _ = fs::remove_dir_all(&temp_root);
                        return Err(format!(
                            "Unsupported or unreadable archive '{}': {}. Bundle a 7za.exe at <install>/tools/7za.exe for maximum compatibility.",
                            ext, extract_err
                        ));
                    }
                },
            },
        }
    };

    if !extract_output.status.success() && !extraction_result_is_usable(&extract_output, &extract_dir) {
        let _ = fs::remove_dir_all(&temp_root);
        return Err(format!(
            "Extraction failed: {}",
            String::from_utf8_lossy(&extract_output.stderr)
        ));
    }

    fn has_any_files_recursive(dir: &Path) -> bool {
        let entries = match fs::read_dir(dir) {
            Ok(value) => value,
            Err(_) => return false,
        };

        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_file() {
                return true;
            }
            if path.is_dir() && has_any_files_recursive(&path) {
                return true;
            }
        }

        false
    }

    fn resolve_best_extract_source(root: &Path) -> PathBuf {
        let mut current = root.to_path_buf();

        loop {
            let entries = match fs::read_dir(&current) {
                Ok(value) => value.filter_map(Result::ok).map(|e| e.path()).collect::<Vec<_>>(),
                Err(_) => break,
            };

            let mut file_count = 0usize;
            let mut only_child_dir: Option<PathBuf> = None;
            let mut dir_count = 0usize;

            for path in &entries {
                if path.is_file() {
                    file_count += 1;
                } else if path.is_dir() {
                    dir_count += 1;
                    if only_child_dir.is_none() {
                        only_child_dir = Some(path.clone());
                    }
                }
            }

            if file_count > 0 {
                break;
            }

            if dir_count == 1 {
                if let Some(next) = only_child_dir {
                    current = next;
                    continue;
                }
            }

            break;
        }

        current
    }

    let source_path = resolve_best_extract_source(&extract_dir);
    if !has_any_files_recursive(&source_path) {
        let _ = fs::remove_dir_all(&temp_root);
        return Err(
            "Archive extracted but contained no installable files. The source link may not be a direct archive download."
                .to_string(),
        );
    }

    let entries: Vec<PathBuf> = fs::read_dir(&extract_dir)
        .map_err(|err| err.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    if entries.is_empty() {
        let _ = fs::remove_dir_all(&temp_root);
        return Err("Archive extraction did not produce files.".to_string());
    }

    let dest_base = PathBuf::from(&dest_item_path);
    fs::create_dir_all(&dest_base).map_err(|err| err.to_string())?;

    let mut dest = dest_base.join(&safe_name);
    let mut idx: u32 = 1;
    while dest.exists() {
        dest = dest_base.join(format!("{safe_name}_copy{idx}"));
        idx += 1;
    }

    copy_dir_recursive(&source_path, &dest)?;
    let result = normalize_path(&dest);

    let mut preview_path = if let Some(preview) = preview_url {
        let trimmed = preview.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let ext = Path::new(trimmed.split('?').next().unwrap_or(trimmed))
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .filter(|e| ["png", "jpg", "jpeg", "webp", "bmp", "gif"].contains(&e.as_str()))
                .unwrap_or_else(|| "jpg".to_string());

            let preview_file = dest.join(format!("preview.{ext}"));
            let status = background_command("curl")
                .args([
                    "-L",
                    "--fail",
                    "-o",
                    preview_file.to_str().unwrap_or("preview.jpg"),
                    trimmed,
                ])
                .status();

            match status {
                Ok(s) if s.success() => Some(normalize_path(&preview_file)),
                _ => None,
            }
        } else {
            let source_preview = PathBuf::from(trimmed);
            if source_preview.is_file() {
                let ext = source_preview
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .filter(|e| ["png", "jpg", "jpeg", "webp", "bmp", "gif"].contains(&e.as_str()))
                    .unwrap_or_else(|| "jpg".to_string());
                let preview_file = dest.join(format!("preview.{ext}"));
                match fs::copy(&source_preview, &preview_file) {
                    Ok(_) => Some(normalize_path(&preview_file)),
                    Err(_) => None,
                }
            } else {
                None
            }
        }
    } else {
        None
    };

    if preview_path.is_none() {
        preview_path = find_mod_preview_images(result.clone()).into_iter().next();
    }

    let _ = fs::remove_dir_all(&temp_root);
    Ok(DownloadInstallResult {
        installed_path: result,
        destination_path: normalize_path(&dest_base),
        preview_path,
    })
}

#[tauri::command]
async fn download_and_install_mod(
    url: String,
    dest_item_path: String,
    mod_name: String,
    preview_url: Option<String>,
) -> Result<DownloadInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_and_install_mod_blocking(url, dest_item_path, mod_name, preview_url)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn install_local_archive_mod(
    archive_path: String,
    dest_item_path: String,
    mod_name: String,
    preview_url: Option<String>,
) -> Result<DownloadInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source_archive = archive_path.clone();
        let installed = install_archive_mod_blocking(
            archive_path,
            dest_item_path,
            mod_name,
            preview_url,
        )?;
        let _ = fs::remove_file(source_archive);
        Ok(installed)
    })
    .await
    .map_err(|err| err.to_string())?
}


#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let native = path.replace('/', "\\");
    Command::new("explorer")
        .arg(&native)
        .spawn()
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn import_mod_folder(dest_item_path: String, source_path: String) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_dir() {
        return Err(format!("Source path is not a folder: {source_path}"));
    }

    let folder_name = source
        .file_name()
        .ok_or_else(|| "Cannot determine source folder name".to_string())?
        .to_string_lossy()
        .to_string();

    let dest = PathBuf::from(&dest_item_path).join(&folder_name);
    if dest.exists() {
        return Err(format!(
            "A folder named '{folder_name}' already exists at the destination."
        ));
    }

    copy_dir_recursive(&source, &dest)?;
    Ok(normalize_path(&dest))
}

#[tauri::command]
fn add_custom_character(game: String, id: String, name: String) -> Result<(), String> {
    let resources_dir = resolve_resources_dir()?;
    let file_path = resources_dir.join(format!("addedCharacters_{game}.json"));
    let normalized_id = id.trim().to_string();
    let normalized_name = name.trim().to_string();

    if normalized_id.is_empty() {
        return Err("Character id cannot be empty.".to_string());
    }

    if normalized_name.is_empty() {
        return Err("Character name cannot be empty.".to_string());
    }

    let mut entries = read_json_array(&file_path);
    let already_exists = entries
        .iter()
        .any(|entry| entry.get("id").and_then(Value::as_str) == Some(normalized_id.as_str()));
    if already_exists {
        return Err(format!("Character '{normalized_id}' already exists."));
    }

    entries.push(json!({ "id": normalized_id, "name": normalized_name }));
    let body = serde_json::to_string_pretty(&entries).map_err(|err| err.to_string())?;
    fs::create_dir_all(&resources_dir).map_err(|err| err.to_string())?;
    fs::write(&file_path, body).map_err(|err| err.to_string())?;

    if let Ok(settings) = load_settings_snapshot() {
        if let Some(mod_root) = settings
            .get("mod_paths")
            .and_then(Value::as_object)
            .and_then(|paths| paths.get(&game))
            .and_then(Value::as_str)
        {
            let target = build_item_folder_path(
                &PathBuf::from(mod_root),
                "characters",
                Some(id.trim()),
            );
            let _ = fs::create_dir_all(target);
        }
    }

    Ok(())
}

#[tauri::command]
fn remove_custom_character(game: String, id: String) -> Result<(), String> {
    let resources_dir = resolve_resources_dir()?;
    let file_path = resources_dir.join(format!("addedCharacters_{game}.json"));

    let entries = read_json_array(&file_path);
    let filtered: Vec<Value> = entries
        .into_iter()
        .filter(|entry| entry.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .collect();

    let body = serde_json::to_string_pretty(&filtered).map_err(|err| err.to_string())?;
    fs::write(&file_path, body).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn check_for_updates(force: bool) -> Result<Value, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let resources_dir = resolve_resources_dir()?;
    let settings = load_settings_snapshot().ok();

    const CACHE_TTL_SECS: u64 = 3600;
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Return cached result unless caller forced a fresh check.
    if !force {
        if let Some(ref s) = settings {
            if let (Some(ts), Some(cached)) = (
                s.get("update_check_ts").and_then(Value::as_u64),
                s.get("update_check_result"),
            ) {
                if now_secs.saturating_sub(ts) < CACHE_TTL_SECS {
                    return Ok(cached.clone());
                }
            }
        }
    }

    let current_resources_version = settings
        .as_ref()
        .and_then(|s| s.get("version").and_then(Value::as_str).map(ToOwned::to_owned))
        .unwrap_or_else(|| detect_resource_version(&resources_dir));
    // Prefer persisted installed release tag written by installer/updater.
    let current_app_version = settings
        .as_ref()
        .and_then(|s| s.get("last_app_release_tag").or_else(|| s.get("last_release_tag")))
        .and_then(Value::as_str)
        .map(normalize_release_tag)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    // Treat "no releases yet" as not-available rather than a hard error.
    // Propagate rate-limit errors so we can handle them below.
    fn fetch_or_empty(api_url: &str) -> Result<Value, String> {
        match fetch_latest_release_json(api_url) {
            Ok(v) => Ok(v),
            Err(e) if e.contains("No releases published") => Ok(json!({})),
            Err(e) => Err(e),
        }
    }
    let app_release = match fetch_or_empty(APP_RELEASES_API) {
        Ok(v) => v,
        Err(e) if e == "rate_limit_exceeded" => {
            return Err("Rate limit reached — update check will retry automatically in 1 hour.".to_string());
        }
        Err(e) => return Err(e),
    };
    let resources_release = match fetch_or_empty(RESOURCES_RELEASES_API) {
        Ok(v) => v,
        Err(e) if e == "rate_limit_exceeded" => {
            return Err("Rate limit reached — update check will retry automatically in 1 hour.".to_string());
        }
        Err(e) => return Err(e),
    };

    let latest_app_tag = app_release["tag_name"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let latest_resources_tag = resources_release["tag_name"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let latest_app_norm = normalize_release_tag(&latest_app_tag);
    let latest_resources_norm = normalize_release_tag(&latest_resources_tag);
    let current_app_norm = normalize_release_tag(&current_app_version);
    let current_resources_norm = normalize_release_tag(&current_resources_version);

    let last_resources_release_norm = settings
        .as_ref()
        .and_then(|s| s.get("last_resources_release_tag"))
        .and_then(Value::as_str)
        .map(normalize_release_tag)
        .unwrap_or_default();

    let app_update_available = if latest_app_norm.is_empty() {
        false
    } else if latest_app_norm == current_app_norm {
        false
    } else {
        match (
            parse_version_tuple(&latest_app_norm),
            parse_version_tuple(&current_app_norm),
        ) {
            (Some(latest_parts), Some(current_parts)) => latest_parts > current_parts,
            _ => latest_app_norm != current_app_norm,
        }
    };

    let resources_update_available = if latest_resources_norm.is_empty() {
        false
    } else if latest_resources_norm == current_resources_norm {
        false
    } else if !last_resources_release_norm.is_empty()
        && last_resources_release_norm == latest_resources_norm
    {
        false
    } else {
        match (
            parse_version_tuple(&latest_resources_norm),
            parse_version_tuple(&current_resources_norm),
        ) {
            (Some(latest_parts), Some(current_parts)) => latest_parts > current_parts,
            _ => latest_resources_norm != current_resources_norm,
        }
    };

    let resources_url = extract_asset_url(&resources_release, "resources_m_m.zip");
    let exe_url = extract_app_exe_url(&app_release);
    let updater_url = extract_updater_exe_url(&app_release);

    let any_update_available = app_update_available || resources_update_available;

    let result = json!({
        "available": any_update_available,
        "current_version": current_app_version,
        "latest_tag": latest_app_tag,
        "app_update_available": app_update_available,
        "app_current_version": current_app_version,
        "app_latest_tag": latest_app_tag,
        "resources_url": resources_url,
        "resources_update_available": resources_update_available,
        "resources_current_version": current_resources_version,
        "resources_latest_tag": latest_resources_tag,
        "exe_url": exe_url,
        "updater_url": updater_url,
    });

    // Persist cache back into settings.json under tidy key names.
    let cached = result.clone();
    save_settings_metadata(move |map| {
        map.insert("update_check_ts".to_string(), json!(now_secs));
        map.insert("update_check_result".to_string(), cached);
    });

    Ok(result)
}

#[tauri::command]
fn download_and_launch_updater(
    url: String,
    app_url: Option<String>,
    app_tag: Option<String>,
    updater_url: Option<String>,
    manager_pid: Option<u32>,
) -> Result<String, String> {
    let current_exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let exe_dir = current_exe
        .parent()
        .ok_or_else(|| "Unable to determine executable directory".to_string())?
        .to_path_buf();
    let updater_path = exe_dir.join("updater.exe");
    let updater_temp = exe_dir.join("updater.exe.tmp");

    let status = background_command("curl")
        .args([
            "-L",
            "--fail",
            "-o",
            updater_temp.to_str().unwrap_or("updater.exe.tmp"),
            &url,
        ])
        .status()
        .map_err(|err| err.to_string())?;

    if !status.success() {
        return Err("Failed to download updater executable".to_string());
    }

    let _ = fs::remove_file(&updater_path);
    fs::rename(&updater_temp, &updater_path).map_err(|err| {
        let _ = fs::remove_file(&updater_temp);
        err.to_string()
    })?;
    let _ = fs::remove_file(exe_dir.join("update.exe"));
    let _ = fs::remove_file(exe_dir.join("update_new.exe"));

    let install_dir_str = exe_dir.to_str().unwrap_or("").to_string();
    let pid_str = manager_pid
        .unwrap_or_else(|| std::process::id())
        .to_string();

    let mut cmd_args: Vec<String> = vec![
        "--install-dir".to_string(),
        install_dir_str,
        "--manager-pid".to_string(),
        pid_str,
    ];
    if let Some(ref au) = app_url {
        cmd_args.push("--app-url".to_string());
        cmd_args.push(au.clone());
    }
    if let Some(ref at) = app_tag {
        cmd_args.push("--app-tag".to_string());
        cmd_args.push(at.clone());
    }
    if let Some(ref uu) = updater_url {
        cmd_args.push("--updater-url".to_string());
        cmd_args.push(uu.clone());
    }

    spawn_possibly_elevated(&updater_path, &exe_dir, &cmd_args)?;

    Ok(normalize_path(&updater_path))
}

#[tauri::command]
fn launch_local_updater(
    app_url: Option<String>,
    app_tag: Option<String>,
    updater_url: Option<String>,
    manager_pid: Option<u32>,
) -> Result<String, String> {
    let current_exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let exe_dir = current_exe
        .parent()
        .ok_or_else(|| "Unable to determine executable directory".to_string())?
        .to_path_buf();

    // Prefer canonical updater name; keep legacy fallback for older installs.
    let candidates = [exe_dir.join("updater.exe"), exe_dir.join("update.exe")];
    let updater_path = candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "No local updater found (updater.exe)".to_string())?;

    let install_dir_str = exe_dir.to_str().unwrap_or("").to_string();
    let pid_str = manager_pid
        .unwrap_or_else(|| std::process::id())
        .to_string();

    let mut cmd_args: Vec<String> = vec![
        "--install-dir".to_string(),
        install_dir_str,
        "--manager-pid".to_string(),
        pid_str,
    ];
    if let Some(ref au) = app_url {
        cmd_args.push("--app-url".to_string());
        cmd_args.push(au.clone());
    }
    if let Some(ref at) = app_tag {
        cmd_args.push("--app-tag".to_string());
        cmd_args.push(at.clone());
    }
    if let Some(ref uu) = updater_url {
        cmd_args.push("--updater-url".to_string());
        cmd_args.push(uu.clone());
    }

    spawn_possibly_elevated(&updater_path, &exe_dir, &cmd_args)?;

    Ok(normalize_path(&updater_path))
}

/// Save the latest app release tag to settings so the update prompt is not shown
/// again after the manager relaunches following an update.
#[tauri::command]
fn mark_app_update_seen(latest_tag: String) -> Result<(), String> {
    save_settings_metadata(|map| {
        let normalized = normalize_release_tag(&latest_tag);
        if !normalized.is_empty() {
            map.insert(
                "last_app_release_tag".to_string(),
                serde_json::Value::String(normalized),
            );
            map.remove("update_check_ts");
            map.remove("update_check_result");
            map.remove("last_update_check_ts");
            map.remove("last_update_check_result");
        }
    });
    Ok(())
}

#[tauri::command]
fn exit_for_update() {
    std::process::exit(0);
}

/// Download a fresh update.exe (updater binary) and replace the local copy.
#[tauri::command]
fn download_and_replace_updater(url: String) -> Result<String, String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = current_exe
        .parent()
        .ok_or_else(|| "Cannot determine exe dir".to_string())?
        .to_path_buf();

    let target = exe_dir.join("updater.exe");
    let temp = exe_dir.join("updater.exe.tmp");

    let ok = background_command("curl")
        .args([
            "-L",
            "--fail",
            "-o",
            temp.to_str().unwrap_or("updater.exe.tmp"),
            &url,
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !ok {
        return Err("Failed to download updater".to_string());
    }

    let _ = fs::remove_file(&target);
    fs::rename(&temp, &target).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })?;

    // Cleanup stale names from older flows so one canonical updater remains.
    let _ = fs::remove_file(exe_dir.join("update_new.exe"));
    let _ = fs::remove_file(exe_dir.join("update.exe"));

    Ok(normalize_path(&target))
}

#[tauri::command]
fn bootstrap_installation(
    install_dir: String,
    updater_url: String,
    resources_url: String,
    app_tag: Option<String>,
    resources_tag: Option<String>,
    create_desktop_shortcut_flag: Option<Value>,
    game_mod_paths: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let install_dir = install_dir.trim();
    if install_dir.is_empty() {
        return Err("Install directory is empty".to_string());
    }

    let install_base = PathBuf::from(install_dir);
    fs::create_dir_all(&install_base).map_err(|err| err.to_string())?;
    ensure_dev_app_scaffold(&install_base)?;
    ensure_runtime_tools_scaffold(&install_base)?;

    let resources_dir = install_base.join("resources");
    fs::create_dir_all(&resources_dir).map_err(|err| err.to_string())?;

    // Find the app exe next to us (MSI already installed it).
    let app_target = std::env::current_exe()
        .ok()
        .unwrap_or_else(|| install_base.join("mod-manager-v2.exe"));

    let updater_temp = install_base.join("updater.exe.tmp");
    let updater_target = install_base.join("updater.exe");
    download_to_path(&updater_url, &updater_temp)?;
    let _ = fs::remove_file(&updater_target);
    fs::rename(&updater_temp, &updater_target).map_err(|err| err.to_string())?;
    let _ = fs::remove_file(install_base.join("update_new.exe"));
    let _ = fs::remove_file(install_base.join("update.exe"));

    // Be tolerant if old frontend payloads accidentally pass gameModPaths into
    // createDesktopShortcutFlag as an object.
    let mut merged_game_mod_paths = game_mod_paths;
    let create_shortcut = match create_desktop_shortcut_flag {
        Some(Value::Bool(flag)) => flag,
        Some(Value::Object(map)) => {
            if merged_game_mod_paths.is_none() {
                let recovered = map
                    .into_iter()
                    .filter_map(|(key, value)| value.as_str().map(|path| (key, path.to_string())))
                    .collect::<HashMap<_, _>>();
                if !recovered.is_empty() {
                    merged_game_mod_paths = Some(recovered);
                }
            }
            false
        }
        _ => false,
    };

    let zip_path = install_base.join("resources_update.zip");
    let extract_path = install_base.join("resources_update_tmp");
    download_to_path(&resources_url, &zip_path)?;

    if extract_path.exists() {
        let _ = fs::remove_dir_all(&extract_path);
    }

    let ps_cmd = format!(
        "Expand-Archive -Force -Path '{}' -DestinationPath '{}'",
        zip_path.display(),
        extract_path.display()
    );
    let status = background_command("powershell")
        .args(["-NoProfile", "-Command", &ps_cmd])
        .status()
        .map_err(|err| err.to_string())?;
    if !status.success() {
        let fallback = background_command("tar")
            .args([
                "-xf",
                zip_path.to_str().unwrap_or("resources_update.zip"),
                "-C",
                extract_path.to_str().unwrap_or("resources_update_tmp"),
            ])
            .status();
        if !matches!(fallback, Ok(s) if s.success()) {
            return Err("Failed to extract resources archive".to_string());
        }
    }

    let source = {
        let entries: Vec<PathBuf> = fs::read_dir(&extract_path)
            .map_err(|err| err.to_string())?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        if entries.len() == 1 && entries[0].is_dir() {
            entries[0].clone()
        } else {
            extract_path.clone()
        }
    };
    sync_resources_with_cleanup(&source, &resources_dir)?;

    let mut settings = default_settings(&install_base);
    if let Value::Object(map) = &mut settings {
        if let Some(tag) = app_tag.as_ref() {
            let normalized = normalize_release_tag(tag);
            if !normalized.is_empty() {
                map.insert(
                    "last_app_release_tag".to_string(),
                    Value::String(normalized.clone()),
                );
                map.insert("last_release_tag".to_string(), Value::String(normalized));
            }
        }

        if let Some(tag) = resources_tag.as_ref() {
            let normalized = normalize_release_tag(tag);
            if !normalized.is_empty() {
                map.insert("version".to_string(), Value::String(normalized.clone()));
                map.insert(
                    "last_resources_release_tag".to_string(),
                    Value::String(normalized),
                );
            }
        }

        map.insert(
            "resources_last_download_url".to_string(),
            Value::String(resources_url.clone()),
        );
        let downloaded_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string());
        map.insert("resources_last_downloaded_at".to_string(), Value::String(downloaded_at));

        map.remove("update_check_ts");
        map.remove("update_check_result");
        map.remove("last_update_check_ts");
        map.remove("last_update_check_result");

        // Merge in user-chosen mod paths from the wizard.
        if let Some(ref paths) = merged_game_mod_paths {
            let mod_paths_value = map
                .entry("mod_paths".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(mod_paths_map) = mod_paths_value {
                for (game, path) in paths {
                    if !path.is_empty() {
                        mod_paths_map.insert(game.clone(), Value::String(path.clone()));
                    }
                }
            }
        }
    }

    let settings_path = resources_dir.join("settings.json");
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;

    write_install_path_file(&install_base)?;

    if create_shortcut {
        let _ = create_desktop_shortcut(&app_target, &install_base);
    }

    let _ = fs::remove_file(&zip_path);
    let _ = fs::remove_dir_all(&extract_path);

    Ok(normalize_path(&install_base))
}

#[tauri::command]
fn create_shortcut_from_settings(base_dir: Option<String>) -> Result<String, String> {
    let install_base = base_dir
        .map(PathBuf::from)
        .or_else(|| detect_legacy_install().map(|install| PathBuf::from(install.base_dir)))
        .or_else(resolve_install_base)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|value| value.to_path_buf()))
        })
        .ok_or_else(|| "No install location found".to_string())?;

    let app_exe = {
        let bundled = install_base.join("mod-manager-v2.exe");
        if bundled.is_file() {
            bundled
        } else {
            std::env::current_exe().map_err(|err| err.to_string())?
        }
    };

    create_desktop_shortcut(&app_exe, &install_base)?;
    let shortcut_path = desktop_shortcut_path()?;
    Ok(normalize_path(&shortcut_path))
}

#[tauri::command]
fn download_and_update_resources(
    url: String,
    latest_tag: Option<String>,
    _updater_url: Option<String>,
) -> Result<String, String> {
    let resources_dir = resolve_resources_dir()?;
    fs::create_dir_all(&resources_dir).map_err(|err| err.to_string())?;

    let parent = resources_dir
        .parent()
        .unwrap_or(&resources_dir)
        .to_path_buf();
    ensure_dev_app_scaffold(&parent)?;
    ensure_runtime_tools_scaffold(&parent)?;

    let remove_stock_fixes_after_update = load_settings_snapshot()
        .ok()
        .and_then(|settings| {
            settings
                .get("remove_downloaded_stock_fixes_after_update")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);

    let temp_zip = parent.join("resources_update.zip");
    let temp_extract = parent.join("resources_update_tmp");

    // Download
    let status = background_command("curl")
        .args([
            "-L",
            "--fail",
            "-o",
            temp_zip.to_str().unwrap_or("resources_update.zip"),
            &url,
        ])
        .status()
        .map_err(|err| err.to_string())?;

    if !status.success() {
        return Err("Download failed".to_string());
    }

    // Clean temp extract dir
    if temp_extract.exists() {
        let _ = fs::remove_dir_all(&temp_extract);
    }

    // Extract
    let ps_cmd = format!(
        "Expand-Archive -Force -Path '{}' -DestinationPath '{}'",
        temp_zip.display(),
        temp_extract.display()
    );
    let status = background_command("powershell")
        .args(["-NoProfile", "-Command", &ps_cmd])
        .status()
        .map_err(|err| err.to_string())?;

    if !status.success() {
        let fallback = background_command("tar")
            .args([
                "-xf",
                temp_zip.to_str().unwrap_or("resources_update.zip"),
                "-C",
                temp_extract.to_str().unwrap_or("resources_update_tmp"),
            ])
            .status();

        if !matches!(fallback, Ok(s) if s.success()) {
            return Err("Extraction failed".to_string());
        }
    }

    // Find actual content (may be inside a 'resources' subfolder)
    let source = {
        let entries: Vec<PathBuf> = fs::read_dir(&temp_extract)
            .map_err(|err| err.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        if entries.len() == 1 && entries[0].is_dir() {
            entries[0].clone()
        } else {
            temp_extract.clone()
        }
    };

    // Replace stock resources with cleaned set while preserving user custom fixes.
    sync_resources_with_cleanup(&source, &resources_dir)?;

    if remove_stock_fixes_after_update {
        let _ = purge_downloaded_stock_fixes(&resources_dir)?;
    }

    // Record installed resources update metadata in settings.json.
    save_settings_metadata(|map| {
        if let Some(tag) = latest_tag.as_ref() {
            let normalized = normalize_release_tag(tag);
            if !normalized.is_empty() {
                map.insert("version".to_string(), Value::String(normalized.clone()));
                map.insert(
                    "last_resources_release_tag".to_string(),
                    Value::String(normalized),
                );
            }
        }

        map.insert(
            "resources_last_download_url".to_string(),
            Value::String(url.clone()),
        );
        let downloaded_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string());
        map.insert("resources_last_downloaded_at".to_string(), Value::String(downloaded_at));
    });

    // Cleanup
    let _ = fs::remove_file(&temp_zip);
    let _ = fs::remove_dir_all(&temp_extract);

    Ok(normalize_path(&resources_dir))
}

#[tauri::command]
fn resolve_dev_background_path(game: String, use_all_folder: bool) -> Result<Option<String>, String> {
    let install_base = resolve_best_dev_app_base()
        .or_else(resolve_install_base)
        .ok_or_else(|| "Unable to determine install directory".to_string())?;

    ensure_dev_app_scaffold(&install_base)?;
    Ok(resolve_dev_background_candidate(&install_base, &game, use_all_folder)
        .map(|path| normalize_path(&path)))
}

#[tauri::command]
fn resolve_dev_background_data_url(game: String, use_all_folder: bool) -> Result<Option<String>, String> {
    let install_base = resolve_best_dev_app_base()
        .or_else(resolve_install_base)
        .ok_or_else(|| "Unable to determine install directory".to_string())?;

    ensure_dev_app_scaffold(&install_base)?;

    let Some(path) = resolve_dev_background_candidate(&install_base, &game, use_all_folder) else {
        return Ok(None);
    };

    let data_url = load_image_data_url(normalize_path(&path))?;
    Ok(Some(data_url))
}

#[tauri::command]
fn apply_dev_window_icon(app: tauri::AppHandle) -> Result<Option<String>, String> {
    apply_dev_icon_to_main_window(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.ico")) {
                    let _ = window.set_icon(icon);
                }

                if let Ok(settings) = load_settings_snapshot() {
                    let dev_mode_enabled = settings
                        .get("dev_mode")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if dev_mode_enabled {
                        let _ = apply_dev_icon_to_main_window(app.handle());
                    }

                    let width = settings
                        .get("window_width")
                        .and_then(Value::as_f64)
                        .unwrap_or(1200.0)
                        .max(800.0);
                    let height = settings
                        .get("window_height")
                        .and_then(Value::as_f64)
                        .unwrap_or(800.0)
                        .max(600.0);
                    let pos_x = settings
                        .get("window_x")
                        .and_then(Value::as_f64)
                        .unwrap_or(100.0);
                    let pos_y = settings
                        .get("window_y")
                        .and_then(Value::as_f64)
                        .unwrap_or(100.0);

                    let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
                    if is_valid_window_position(pos_x, pos_y) {
                        let _ = window
                            .set_position(Position::Logical(LogicalPosition::new(pos_x, pos_y)));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_bootstrap_state,
            save_legacy_settings,
            scan_game_mods,
            load_game_inventory,
            load_item_mods,
            toggle_mod_folder,
            rename_mod_folder,
            webview_eval,
            create_managed_browser_webview,
            emit_web_download_request,
            gamebanana_relay_response,
            gamebanana_api_request_via_webview,
            load_download_log,
            append_download_log_entry,
            clear_download_log,
            toggle_item_favorite,
            load_fixes_panel,
            run_fix_script,
            launch_fix_script_source,
            load_mod_details,
            open_in_explorer,
            import_mod_folder,
            add_custom_character,
            remove_custom_character,
            copy_mod_preview_image,
            find_mod_preview_images,
            load_image_data_url,
            load_file_data_url,
            load_texture_data_url,
            load_images_data_urls,
            resolve_dev_background_data_url,
            apply_dev_window_icon,
            get_default_downloads_folder,
            default_downloads_dir,
            download_file_to_folder,
            ensure_buffer_values_folders,
            create_mod_folder_scaffold,
            create_missing_folders_all_paths,
            download_and_install_mod,
            install_local_archive_mod,
            save_ini_value,
            batch_toggle_mods,
            sync_global_persist_for_mod,
            check_for_updates,
            download_and_update_resources,
            resolve_dev_background_path,
            download_and_launch_updater,
            launch_local_updater,
            mark_app_update_seen,
            exit_for_update,
            download_and_replace_updater,
            bootstrap_installation
            ,
            create_shortcut_from_settings,
            build_preview_glb_from_dump,
            resolve_preview_texture_bindings,
            resolve_preview_active_first_indices
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
