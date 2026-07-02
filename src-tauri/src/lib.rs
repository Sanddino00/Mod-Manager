use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{image::Image, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const DEFAULT_VERSION: &str = "1.2.3";
const APP_RELEASES_API: &str = "https://api.github.com/repos/Sanddino00/Mod-Manager/releases/latest";
const RESOURCES_RELEASES_API: &str =
    "https://api.github.com/repos/Sanddino00/Resources-for-Fixmanager-and-Modmanager/releases/latest";

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
struct IniToggleEntry {
    name: String,
    key: String,
    back: Option<String>,
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

    let flush = |toggles: &mut Vec<IniToggleEntry>,
                 current_name: &mut Option<String>,
                 current_key: &mut Option<String>,
                 current_back: &mut Option<String>| {
        if let (Some(name), Some(key)) = (current_name.take(), current_key.take()) {
            toggles.push(IniToggleEntry {
                name,
                key,
                back: current_back.take(),
            });
        } else {
            current_name.take();
            current_key.take();
            current_back.take();
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
            }
        }
    }

    flush(
        &mut toggles,
        &mut current_name,
        &mut current_key,
        &mut current_back,
    );
    toggles
}

fn scan_mod_entries(folder: &Path) -> Vec<ModEntrySummary> {
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
        "theme": "dark",
        "script_targets": {},
        "version": detect_resource_version(&resources_dir),
        "auto_check_updates": false,
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
    let scripts_dir = resources_dir.join(&game);
    let mut scripts = fs::read_dir(&scripts_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".py") {
                Some(FixScriptSummary {
                    name,
                    kind: "python".to_string(),
                })
            } else if name.ends_with(".exe") {
                Some(FixScriptSummary {
                    name,
                    kind: "exe".to_string(),
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
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
    let script_path = resources_dir.join(&game).join(&script_name);

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
                    if output.status.success() {
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

    let extract_output = if ext == "zip" {
        match run_expand_archive() {
            Ok(output) if output.status.success() => output,
            _ => extract_with_7z_or_winrar(&source_archive, &extract_dir)
                .map_err(|err| format!("Extractor unavailable for zip archive: {err}"))?,
        }
    } else {
        match extract_with_7z_or_winrar(&source_archive, &extract_dir) {
            Ok(output) => output,
            Err(extract_err) => match run_expand_archive() {
                Ok(zip_output) => zip_output,
                Err(_) => {
                    let _ = fs::remove_dir_all(&temp_root);
                    return Err(format!(
                        "Unsupported or unreadable archive '{}': {}",
                        ext, extract_err
                    ));
                }
            },
        }
    };

    if !extract_output.status.success() {
        let _ = fs::remove_dir_all(&temp_root);
        return Err(format!(
            "Extraction failed: {}",
            String::from_utf8_lossy(&extract_output.stderr)
        ));
    }

    let entries: Vec<PathBuf> = fs::read_dir(&extract_dir)
        .map_err(|err| err.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();

    let source_path = if entries.len() == 1 && entries[0].is_dir() {
        entries[0].clone()
    } else {
        extract_dir.clone()
    };

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
        return Err("Failed to extract resources archive".to_string());
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
    copy_dir_recursive(&source, &resources_dir)?;

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
        return Err("Extraction failed".to_string());
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

    // Merge into resources dir
    copy_dir_recursive(&source, &resources_dir)?;

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
            emit_web_download_request,
            toggle_item_favorite,
            load_fixes_panel,
            run_fix_script,
            load_mod_details,
            open_in_explorer,
            import_mod_folder,
            add_custom_character,
            remove_custom_character,
            copy_mod_preview_image,
            find_mod_preview_images,
            load_image_data_url,
            load_images_data_urls,
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
            download_and_launch_updater,
            launch_local_updater,
            mark_app_update_seen,
            exit_for_update,
            download_and_replace_updater,
            bootstrap_installation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
