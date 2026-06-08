export type GameKey = "gi" | "hsr" | "wuwa" | "zzz" | "end";

export type CategoryKey =
  | "characters"
  | "weapons"
  | "ui"
  | "objects"
  | "npcs"
  | "buffervalues";

export interface BrowseType {
  name: string;
  id: number;
}

export interface BrowseGameData {
  gameId: string;
  types: BrowseType[];
}

export interface GameDefinition {
  id: GameKey;
  name: string;
  shortLabel: string;
  accent: string;
  description: string;
  categories: CategoryKey[];
}

export interface Settings {
  mod_paths: Record<GameKey, string>;
  nextcloud_links: Record<GameKey, string>;
  theme: string;
  script_targets: Record<string, string>;
  version: string;
  auto_check_updates: boolean;
  last_release_tag: string | null;
  install_path_info: string | null;
  last_selected_game: GameKey;
  window_width: number;
  window_height: number;
  window_x: number;
  window_y: number;
  favorites: Record<string, string[]>;
  right_click_toggle_mods: boolean;
}

export interface LegacyInstall {
  base_dir: string;
  resources_dir: string;
  settings_path: string;
}

export interface BootstrapState {
  legacy_install: LegacyInstall | null;
  settings: Settings;
  settings_found: boolean;
  detected_paths: string[];
  app_version: string;
  needs_setup: boolean;
  exe_dir: string;
}

export interface ModEntrySummary {
  name: string;
  display_name: string;
  path: string;
  disabled: boolean;
}

export interface ItemScanSummary {
  item_id: string;
  path: string;
  total_mods: number;
  enabled_mods: number;
  disabled_mods: number;
  mods: ModEntrySummary[];
}

export interface CategoryScanSummary {
  category: string;
  folder_path: string;
  exists: boolean;
  total_items: number;
  total_mods: number;
  enabled_mods: number;
  disabled_mods: number;
  items: ItemScanSummary[];
}

export interface GameScanSummary {
  game: string;
  mod_root: string;
  exists: boolean;
  total_items: number;
  total_mods: number;
  enabled_mods: number;
  disabled_mods: number;
  categories: CategoryScanSummary[];
}

export interface ItemCatalogEntry {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  favorite: boolean;
  is_custom: boolean;
  total_mods: number;
  enabled_mods: number;
  disabled_mods: number;
  icon_path?: string | null;
}

export interface CategoryInventorySummary {
  category: string;
  folder_path: string;
  exists: boolean;
  items: ItemCatalogEntry[];
}

export interface GameInventorySummary {
  game: string;
  mod_root: string;
  categories: CategoryInventorySummary[];
}

export interface ItemModsSummary {
  game: string;
  category: string;
  item_id: string;
  item_name: string;
  path: string;
  exists: boolean;
  total_mods: number;
  enabled_mods: number;
  disabled_mods: number;
  mods: ModEntrySummary[];
}

export interface FixScriptSummary {
  name: string;
  kind: string;
}

export interface FixesPanelData {
  game: string;
  info_text: string;
  scripts: FixScriptSummary[];
}

export interface IniToggleEntry {
  name: string;
  key: string;
  back: string | null;
}

export interface ModDetailSummary {
  mod_path: string;
  ini_path: string | null;
  toggles: IniToggleEntry[];
}