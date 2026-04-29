import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FolderTree,
  Gamepad2,
  Globe,
  HardDriveDownload,
  Layers3,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Star,
} from "lucide-react";
import clsx from "clsx";
import { CATEGORY_ORDER, GAME_ORDER, GAMES, GAMEBANANA_URLS, RABBITFX_URLS } from "./config/games";
import { SetupWizard } from "./SetupWizard";
import { BrowseTab } from "./BrowseTab";
import type { DownloadEventPayload } from "./BrowseTab";
import type {
  BootstrapState,
  CategoryKey,
  FixesPanelData,
  GameInventorySummary,
  GameKey,
  GameScanSummary,
  ItemCatalogEntry,
  ItemModsSummary,
  ModDetailSummary,
  Settings,
} from "./types";

type ThemeMode = "dark" | "light" | "game";

type DownloadRecord = {
  id: string;
  status: "downloading" | "done" | "error";
  modName: string;
  fileName: string;
  destinationPath: string;
  installedPath?: string;
  previewPath?: string | null;
  message?: string;
  startedAt: number;
  finishedAt?: number;
};

type GameThemeSkin = {
  shell: string;
  shellPanel: string;
  panel: string;
};

const GAME_THEME_SKINS: Record<GameKey, GameThemeSkin> = {
  gi: {
    shell: "min-h-screen bg-[radial-gradient(circle_at_14%_10%,_rgba(56,189,248,0.24),_transparent_26%),radial-gradient(circle_at_84%_16%,_rgba(147,197,253,0.18),_transparent_28%),radial-gradient(circle_at_30%_88%,_rgba(110,231,183,0.16),_transparent_30%),linear-gradient(180deg,_#071023_0%,_#0f1e3a_52%,_#090f1f_100%)] text-slate-100",
    shellPanel: "border border-cyan-300/20 bg-slate-950/38 shadow-[0_28px_120px_rgba(3,8,22,0.52)] backdrop-blur-md",
    panel: "border border-cyan-300/15 bg-slate-950/48 shadow-[0_22px_80px_rgba(4,7,22,0.34)]",
  },
  hsr: {
    shell: "min-h-screen bg-[radial-gradient(circle_at_12%_12%,_rgba(250,204,21,0.24),_transparent_24%),radial-gradient(circle_at_84%_14%,_rgba(251,191,36,0.2),_transparent_28%),radial-gradient(circle_at_24%_84%,_rgba(96,165,250,0.14),_transparent_30%),linear-gradient(180deg,_#141125_0%,_#2b1d47_52%,_#151126_100%)] text-slate-100",
    shellPanel: "border border-amber-300/20 bg-indigo-950/34 shadow-[0_30px_120px_rgba(16,11,32,0.54)] backdrop-blur-md",
    panel: "border border-amber-300/15 bg-indigo-950/44 shadow-[0_22px_80px_rgba(12,8,26,0.36)]",
  },
  wuwa: {
    shell: "min-h-screen bg-[radial-gradient(circle_at_10%_12%,_rgba(16,185,129,0.24),_transparent_25%),radial-gradient(circle_at_86%_14%,_rgba(34,197,94,0.2),_transparent_28%),radial-gradient(circle_at_22%_86%,_rgba(45,212,191,0.14),_transparent_30%),linear-gradient(180deg,_#04130f_0%,_#0c2a22_52%,_#071610_100%)] text-slate-100",
    shellPanel: "border border-emerald-300/20 bg-emerald-950/34 shadow-[0_28px_110px_rgba(2,20,16,0.54)] backdrop-blur-md",
    panel: "border border-emerald-300/16 bg-emerald-950/44 shadow-[0_22px_80px_rgba(3,16,12,0.36)]",
  },
  zzz: {
    shell: "min-h-screen bg-[radial-gradient(circle_at_12%_10%,_rgba(251,146,60,0.22),_transparent_24%),radial-gradient(circle_at_84%_12%,_rgba(248,113,113,0.2),_transparent_28%),radial-gradient(circle_at_30%_88%,_rgba(125,211,252,0.14),_transparent_30%),linear-gradient(180deg,_#190f11_0%,_#31161a_52%,_#170d0f_100%)] text-slate-100",
    shellPanel: "border border-orange-300/20 bg-rose-950/32 shadow-[0_28px_110px_rgba(24,9,12,0.52)] backdrop-blur-md",
    panel: "border border-orange-300/16 bg-rose-950/42 shadow-[0_22px_80px_rgba(20,8,10,0.34)]",
  },
  end: {
    shell: "min-h-screen bg-[radial-gradient(circle_at_10%_10%,_rgba(192,132,252,0.22),_transparent_24%),radial-gradient(circle_at_84%_12%,_rgba(129,140,248,0.2),_transparent_28%),radial-gradient(circle_at_22%_84%,_rgba(103,232,249,0.14),_transparent_30%),linear-gradient(180deg,_#120f1f_0%,_#241a3c_52%,_#130f22_100%)] text-slate-100",
    shellPanel: "border border-violet-300/20 bg-violet-950/34 shadow-[0_28px_110px_rgba(14,10,26,0.52)] backdrop-blur-md",
    panel: "border border-violet-300/16 bg-violet-950/44 shadow-[0_22px_80px_rgba(12,8,22,0.34)]",
  },
};

function normalizeTheme(value: string | null | undefined): ThemeMode {
  if (value === "light" || value === "game") {
    return value;
  }
  return "dark";
}

function hexToRgb(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("#")) {
    return null;
  }

  let hex = trimmed.slice(1);
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }

  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }

  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return [r, g, b];
}

function alphaColor(value: string, alpha: number, fallback: string): string {
  const rgb = hexToRgb(value);
  if (!rgb) {
    return fallback;
  }
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function iconFallbackLabel(category: CategoryKey, itemName: string, itemId: string): string {
  if (category === "ui") {
    return "UI";
  }

  const source = (itemName || itemId || "??").trim();
  const compact = source.replace(/\s+/g, " ");
  return compact.slice(0, 2).toUpperCase();
}

function categoryIconAccent(category: CategoryKey): string {
  if (category === "ui") {
    return "border-cyan-300/45 bg-cyan-400/10";
  }
  if (category === "weapons") {
    return "border-amber-300/45 bg-amber-400/10";
  }
  if (category === "buffervalues") {
    return "border-emerald-300/45 bg-emerald-400/10";
  }
  return "border-violet-300/35 bg-violet-400/10";
}

function leafFolderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/g, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

function normalizeMatchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreItemNameAgainstDrops(itemName: string, droppedFolders: string[]): number {
  const normalizedItem = normalizeMatchText(itemName);
  if (!normalizedItem) {
    return 0;
  }

  const itemTokens = new Set(normalizedItem.split(/\s+/).filter(Boolean));
  let best = 0;

  for (const folder of droppedFolders) {
    const normalizedFolder = normalizeMatchText(folder);
    if (!normalizedFolder) {
      continue;
    }

    if (normalizedFolder === normalizedItem) {
      best = Math.max(best, 100);
      continue;
    }
    if (normalizedFolder.includes(normalizedItem) || normalizedItem.includes(normalizedFolder)) {
      best = Math.max(best, 80);
      continue;
    }

    const folderTokens = normalizedFolder.split(/\s+/).filter(Boolean);
    let overlap = 0;
    for (const token of folderTokens) {
      if (itemTokens.has(token)) {
        overlap++;
      }
    }

    if (overlap > 0) {
      const tokenScore = Math.min(75, Math.floor((overlap / Math.max(1, itemTokens.size)) * 75));
      best = Math.max(best, tokenScore);
    }
  }

  return best;
}

function findBestDropTargetItem(
  inventory: GameInventorySummary | null,
  category: CategoryKey,
  droppedPaths: string[],
): ItemCatalogEntry | null {
  if (!inventory || droppedPaths.length === 0) {
    return null;
  }

  const categoryItems = inventory.categories.find((entry) => entry.category === category)?.items ?? [];
  if (categoryItems.length === 0) {
    return null;
  }

  const folderNames = droppedPaths.map(leafFolderName);
  let bestItem: ItemCatalogEntry | null = null;
  let bestScore = 0;

  for (const item of categoryItems) {
    const scoreFromName = scoreItemNameAgainstDrops(item.name, folderNames);
    const scoreFromId = scoreItemNameAgainstDrops(item.id, folderNames);
    const score = Math.max(scoreFromName, scoreFromId);
    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  // Require a reasonable confidence threshold so we do not pick random items.
  return bestScore >= 45 ? bestItem : null;
}

function App() {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [activeGame, setActiveGame] = useState<GameKey | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("characters");
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [scan, setScan] = useState<GameScanSummary | null>(null);
  const [inventory, setInventory] = useState<GameInventorySummary | null>(null);
  const [itemMods, setItemMods] = useState<ItemModsSummary | null>(null);
  const [modDetails, setModDetails] = useState<ModDetailSummary | null>(null);
  const [modPreviewImages, setModPreviewImages] = useState<string[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewLoadError, setPreviewLoadError] = useState(false);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [iconDataUrls, setIconDataUrls] = useState<Record<string, string>>({});
  const [fixesPanel, setFixesPanel] = useState<FixesPanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanLoading, setScanLoading] = useState(false);
  const [itemLoading, setItemLoading] = useState(false);
  const [modDetailsLoading, setModDetailsLoading] = useState(false);
  const [fixesLoading, setFixesLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [togglePath, setTogglePath] = useState<string | null>(null);
  const [favoriteItemId, setFavoriteItemId] = useState<string | null>(null);
  const [runningFix, setRunningFix] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"manager" | "browse" | "settings" | "fixes" | "downloads">("manager");
  const [importSource, setImportSource] = useState("");
  const [importingMod, setImportingMod] = useState(false);
  const [addCharId, setAddCharId] = useState("");
  const [addCharName, setAddCharName] = useState("");
  const [addingChar, setAddingChar] = useState(false);
  const [addCharFormOpen, setAddCharFormOpen] = useState(false);
  const [removingCharId, setRemovingCharId] = useState<string | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [iniSection, setIniSection] = useState<string | null>(null);
  const [iniEditKey, setIniEditKey] = useState("");
  const [iniEditBack, setIniEditBack] = useState("");
  const [iniSaving, setIniSaving] = useState(false);
  const [iniSaveMsg, setIniSaveMsg] = useState<string | null>(null);
  const [batchToggling, setBatchToggling] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    available: boolean;
    current_version: string;
    latest_tag: string;
    app_update_available?: boolean;
    app_current_version?: string;
    app_latest_tag?: string;
    resources_update_available?: boolean;
    resources_current_version?: string;
    resources_latest_tag?: string;
    resources_url: string | null;
    exe_url: string | null;
    updater_url: string | null;
  } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [autoUpdateChecked, setAutoUpdateChecked] = useState(false);
  const [managerCharacterView, setManagerCharacterView] = useState<"grid" | "workspace">("grid");
  const [downloadRecords, setDownloadRecords] = useState<DownloadRecord[]>([]);
  const [lastDownloadFolder, setLastDownloadFolder] = useState<string | null>(null);

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [dragDropMsg, setDragDropMsg] = useState<string | null>(null);

  // Keep a ref so the async drag-drop handler always sees the latest itemMods.
  const itemModsRef = useRef(itemMods);
  useEffect(() => { itemModsRef.current = itemMods; }, [itemMods]);
  // Keep refs for matching dropped folders against the latest UI selection/data.
  const inventoryRef = useRef(inventory);
  useEffect(() => { inventoryRef.current = inventory; }, [inventory]);
  const activeCategoryRef = useRef(activeCategory);
  useEffect(() => { activeCategoryRef.current = activeCategory; }, [activeCategory]);

  const persistedSettings = state?.settings ?? null;
  const highlightedGame = activeGame ?? persistedSettings?.last_selected_game ?? "gi";
  const highlightedGameConfig = GAMES[highlightedGame];
  const activeGameTheme = GAME_THEME_SKINS[highlightedGame];
  const currentModRoot = persistedSettings?.mod_paths[highlightedGame] ?? "";
  const activeScriptTarget = draftSettings?.script_targets[highlightedGame] ?? currentModRoot;
  // Ref so the async drag-drop handler always sees the latest highlighted game.
  const highlightedGameRef = useRef(highlightedGame);
  useEffect(() => { highlightedGameRef.current = highlightedGame; }, [highlightedGame]);
  const persistedSettingsRef = useRef(persistedSettings);
  useEffect(() => { persistedSettingsRef.current = persistedSettings; }, [persistedSettings]);
  const configuredGames = persistedSettings
    ? GAME_ORDER.filter((gameId) => Boolean(persistedSettings.mod_paths[gameId]))
    : [];
  const configuredCount = configuredGames.length;
  const currentCategory = inventory?.categories.find((category) => category.category === activeCategory) ?? null;
  const filteredItems = (currentCategory?.items ?? []).filter((item) => {
    if (!itemSearch.trim()) return true;
    const q = itemSearch.trim().toLowerCase();
    return item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
  });
  const currentPreviewPath = modPreviewImages[previewIndex] ?? modPreviewImages[0] ?? null;
  const themeMode = normalizeTheme(draftSettings?.theme ?? persistedSettings?.theme);
  const isGameTheme = themeMode === "game";
  const gameAccent = highlightedGameConfig.accent;

  const shellClassName =
    themeMode === "light"
      ? "min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.11),_transparent_36%),radial-gradient(circle_at_88%_8%,_rgba(20,184,166,0.09),_transparent_30%),linear-gradient(180deg,_#e7edf6_0%,_#d7e0ec_48%,_#c3cfde_100%)] text-slate-900"
      : themeMode === "game"
        ? activeGameTheme.shell
        : "min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.12),_transparent_28%),radial-gradient(circle_at_84%_12%,_rgba(34,197,94,0.10),_transparent_24%),linear-gradient(180deg,_#020617_0%,_#0b1220_52%,_#030712_100%)] text-slate-100";

  const shellPanelClassName =
    themeMode === "light"
      ? "border border-slate-300/45 bg-slate-50/66 shadow-[0_18px_50px_rgba(15,23,42,0.10)] backdrop-blur-md"
      : themeMode === "game"
        ? activeGameTheme.shellPanel
        : "border border-slate-700/45 bg-slate-950/55 shadow-[0_24px_90px_rgba(0,0,0,0.52)] backdrop-blur-md";

  const panelClassName =
    themeMode === "light"
      ? "border border-slate-300/45 bg-slate-50/62 shadow-[0_14px_40px_rgba(15,23,42,0.08)]"
      : themeMode === "game"
        ? activeGameTheme.panel
        : "border border-slate-700/40 bg-slate-950/62 shadow-[0_22px_80px_rgba(2,6,20,0.40)]";

  const textMutedClassName = themeMode === "light" ? "text-slate-700" : "text-slate-400";
  const gameAccentStrong = alphaColor(gameAccent, 0.44, "rgba(56, 189, 248, 0.44)");
  const gameAccentMedium = alphaColor(gameAccent, 0.28, "rgba(56, 189, 248, 0.28)");
  const gameAccentSoft = alphaColor(gameAccent, 0.16, "rgba(56, 189, 248, 0.16)");
  const gameAccentFaint = alphaColor(gameAccent, 0.1, "rgba(56, 189, 248, 0.1)");

  const gameAccentPillStyle: CSSProperties | undefined = isGameTheme
    ? {
        borderColor: gameAccentMedium,
        backgroundColor: gameAccentSoft,
        color: "#eaf6ff",
      }
    : undefined;

  const navActiveClassName =
    themeMode === "light"
      ? "border-slate-400/65 bg-slate-900/8 text-slate-900"
      : themeMode === "game"
        ? "text-white"
        : "border-white/25 bg-white/15 text-white";
  const navActiveStyle: CSSProperties | undefined = isGameTheme
    ? {
        borderColor: gameAccentStrong,
        backgroundColor: gameAccentSoft,
      }
    : undefined;
  const navIdleClassName =
    themeMode === "light"
      ? "border-slate-300/65 text-slate-700 hover:bg-slate-900/6"
      : themeMode === "game"
        ? "text-slate-200/90 hover:bg-white/10"
        : "border-white/10 text-slate-300 hover:bg-white/8";
  const navIdleStyle: CSSProperties | undefined = isGameTheme
    ? {
        borderColor: gameAccentFaint,
      }
    : undefined;

  async function pickFolder(initial?: string) {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: initial?.trim() ? initial : undefined,
      title: "Select folder",
    });

    if (!picked) {
      return null;
    }

    return Array.isArray(picked) ? picked[0] ?? null : picked;
  }

  function updateDraftSettings(updater: (current: Settings) => Settings) {
    setDraftSettings((current) => (current ? updater(current) : current));
    setSaveMessage(null);
  }

  function toAssetSrc(path: string): string {
    const localPath = path.replace(/^file:\/+/i, "").replace(/^\/+([A-Za-z]:)/, "$1").replace(/\//g, "\\");
    try {
      const assetUrl = convertFileSrc(localPath);
      return assetUrl.replace(/#/g, "%23").replace(/\?/g, "%3F");
    } catch {
      return path;
    }
  }

  async function loadItemMods(
    gameId: GameKey,
    category: CategoryKey,
    item: ItemCatalogEntry,
    modRoot: string,
  ) {
    setItemLoading(true);

    try {
      const nextMods = await invoke<ItemModsSummary>("load_item_mods", {
        game: gameId,
        category,
        itemId: item.id,
        itemName: item.name,
        modRoot,
      });
      setItemMods(nextMods);
      setActiveItemId(item.id);
    } finally {
      setItemLoading(false);
    }
  }

  async function loadGameState(gameId: GameKey, preferredItemId?: string | null) {
    if (!persistedSettings) {
      return;
    }

    const modRoot = persistedSettings.mod_paths[gameId] ?? "";
    setScanLoading(true);
    setScanError(null);

    try {
      const [nextScan, nextInventory] = await Promise.all([
        invoke<GameScanSummary>("scan_game_mods", { game: gameId, modRoot }),
        invoke<GameInventorySummary>("load_game_inventory", { game: gameId, modRoot }),
      ]);

      setScan(nextScan);
      setInventory(nextInventory);

      const categoryData = nextInventory.categories.find((category) => category.category === activeCategory);
      const firstItem = categoryData?.items[0] ?? null;
      const nextItem = categoryData?.items.find((item) => item.id === preferredItemId)
        ?? (activeCategory === "characters" ? null : firstItem);

      if (nextItem) {
        await loadItemMods(gameId, activeCategory, nextItem, modRoot);
        if (activeCategory === "characters") {
          setManagerCharacterView("workspace");
        }
      } else {
        setItemMods(null);
        setModDetails(null);
        setActiveItemId(null);
        if (activeCategory === "characters") {
          setManagerCharacterView("grid");
        }
      }
    } catch (loadError) {
      setScanError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setScanLoading(false);
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);

    try {
      const nextState = await invoke<BootstrapState>("load_bootstrap_state");
      const nextGame = nextState.settings.last_selected_game;
      setState(nextState);
      setDraftSettings(nextState.settings);
      setActiveGame(nextGame);
      if (nextState.settings.mod_paths) {
        invoke("ensure_buffer_values_folders", { modPaths: nextState.settings.mod_paths }).catch(() => {});
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadFixes(gameId: GameKey) {
    setFixesLoading(true);

    try {
      const nextPanel = await invoke<FixesPanelData>("load_fixes_panel", { game: gameId });
      setFixesPanel(nextPanel);
    } finally {
      setFixesLoading(false);
    }
  }

  async function loadModDetails(path: string) {
    setModDetailsLoading(true);
    setModPreviewImages([]);
    setPreviewIndex(0);
    setPreviewLoadError(false);

    try {
      const [nextDetails, images] = await Promise.all([
        invoke<ModDetailSummary>("load_mod_details", { path }),
        invoke<string[]>("find_mod_preview_images", { path }),
      ]);
      setModDetails(nextDetails);
      setModPreviewImages(images);
      setPreviewIndex(0);

      if (images[0]) {
        void invoke<string>("load_image_data_url", { path: images[0] })
          .then((dataUrl) => {
            setPreviewDataUrl(dataUrl);
          })
          .catch(() => {
            // Fallback to convertFileSrc path if data-url prefetch fails.
          });
      }
    } finally {
      setModDetailsLoading(false);
    }
  }

  useEffect(() => {
    if (!modPreviewImages.length) {
      setPreviewIndex(0);
      setPreviewDataUrl(null);
      setPreviewLoadError(false);
      return;
    }
    if (previewIndex >= modPreviewImages.length) {
      setPreviewIndex(0);
    }
    setPreviewDataUrl(null);
    setPreviewLoadError(false);
  }, [modPreviewImages, previewIndex]);

  useEffect(() => {
    if (!filteredItems.length) {
      return;
    }

    const iconPaths = filteredItems
      .map((item) => item.icon_path)
      .filter((path): path is string => typeof path === "string" && path.length > 0)
      .filter((path) => !iconDataUrls[path]);

    if (!iconPaths.length) {
      return;
    }

    let cancelled = false;
    const chunkSize = 48;
    let cursor = 0;

    const runChunk = () => {
      if (cancelled || cursor >= iconPaths.length) {
        return;
      }

      const paths = iconPaths.slice(cursor, cursor + chunkSize);
      cursor += chunkSize;

      void invoke<Record<string, string>>("load_images_data_urls", { paths })
        .then((batch) => {
          if (cancelled || !batch || Object.keys(batch).length === 0) {
            return;
          }
          setIconDataUrls((current) => ({ ...current, ...batch }));
        })
        .finally(() => {
          if (!cancelled) {
            setTimeout(runChunk, 0);
          }
        });
    };

    runChunk();

    return () => {
      cancelled = true;
    };
  }, [filteredItems]);

  useEffect(() => {
    if (!persistedSettings) {
      return;
    }

    // Keep desktop behavior aligned with persisted settings values.
    const window = getCurrentWindow();
    void window.setSize(
      new LogicalSize(
        Math.max(800, Number(persistedSettings.window_width) || 1200),
        Math.max(600, Number(persistedSettings.window_height) || 800),
      ),
    );
    void window.setPosition(
      new LogicalPosition(
        Number(persistedSettings.window_x) || 100,
        Number(persistedSettings.window_y) || 100,
      ),
    );
  }, [persistedSettings?.window_width, persistedSettings?.window_height, persistedSettings?.window_x, persistedSettings?.window_y]);

  async function ensurePreviewFallback(path: string) {
    try {
      const dataUrl = await invoke<string>("load_image_data_url", { path });
      setPreviewDataUrl(dataUrl);
      setPreviewLoadError(false);
    } catch {
      setPreviewLoadError(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!persistedSettings) {
      return;
    }

    void loadGameState(highlightedGame, activeItemId);
    void loadFixes(highlightedGame);
  }, [persistedSettings, highlightedGame, activeCategory]);

  useEffect(() => {
    if (!persistedSettings?.auto_check_updates || autoUpdateChecked) {
      return;
    }

    setAutoUpdateChecked(true);
    // On startup: check silently only. Do not auto-launch update flows.
    void handleCheckForUpdates({ silentUpToDate: true, autoPrompt: false });
  }, [persistedSettings?.auto_check_updates, autoUpdateChecked]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onDragDropEvent((event) => {
      const { type } = event.payload;
      if (type === "enter" || type === "over") {
        setIsDraggingOver(true);
      } else if (type === "leave") {
        setIsDraggingOver(false);
      } else if (type === "drop") {
        setIsDraggingOver(false);
        const paths: string[] = (event.payload as { paths?: string[] }).paths ?? [];
        if (paths.length === 0) return;
        void (async () => {
          let targetMods = itemModsRef.current;
          let targetItemId = targetMods?.item_id ?? null;

          if (!targetMods) {
            const matchedItem = findBestDropTargetItem(
              inventoryRef.current,
              activeCategoryRef.current,
              paths,
            );
            const settings = persistedSettingsRef.current;
            const game = highlightedGameRef.current;
            const modRoot = settings?.mod_paths?.[game] ?? "";

            if (matchedItem && modRoot) {
              try {
                targetMods = await invoke<ItemModsSummary>("load_item_mods", {
                  game,
                  category: activeCategoryRef.current,
                  itemId: matchedItem.id,
                  itemName: matchedItem.name,
                  modRoot,
                });
                setItemMods(targetMods);
                setActiveItemId(matchedItem.id);
                setManagerCharacterView("workspace");
                targetItemId = matchedItem.id;
                setDragDropMsg(`Auto-selected ${matchedItem.name} from dropped folder name.`);
              } catch {
                setDragDropMsg("Could not auto-select an item. Select a character or item first, then drop mod folders.");
                return;
              }
            } else {
              setDragDropMsg("Select a character or item first, then drop mod folders onto the app.");
              return;
            }
          }

          let imported = 0;
          const errors: string[] = [];
          for (const p of paths) {
            try {
              await invoke<string>("import_mod_folder", {
                destItemPath: targetMods.path,
                sourcePath: p,
              });
              imported++;
            } catch (err) {
              errors.push(err instanceof Error ? err.message : String(err));
            }
          }
          if (errors.length > 0) {
            setDragDropMsg(errors.join(" | "));
          } else {
            setDragDropMsg(`Imported ${imported} mod folder${imported !== 1 ? "s" : ""}.`);
          }
          await loadGameState(highlightedGameRef.current, targetItemId ?? targetMods.item_id);
        })();
      }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  async function handleSaveIni() {
    if (!modDetails?.ini_path || !iniSection) return;
    setIniSaving(true);
    setIniSaveMsg(null);
    try {
      await invoke("save_ini_value", {
        iniPath: modDetails.ini_path,
        section: iniSection,
        newKey: iniEditKey,
        newBack: iniEditBack.trim() || null,
      });
      setIniSaveMsg("Saved.");
      // Reload to reflect the written values
      if (modDetails.mod_path) {
        await loadModDetails(modDetails.mod_path);
      }
    } catch (err) {
      setIniSaveMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIniSaving(false);
    }
  }

  async function handleBatchToggle(enable: boolean) {
    if (!itemMods?.path) return;
    setBatchToggling(true);
    setScanError(null);
    try {
      await invoke<number>("batch_toggle_mods", { itemPath: itemMods.path, enable });
      await loadGameState(highlightedGame, activeItemId);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchToggling(false);
    }
  }

  async function handleGameSelect(gameId: GameKey) {
    setActiveGame(gameId);
    setActiveItemId(null);
    setItemMods(null);
    setModDetails(null);
    updateDraftSettings((current) => ({ ...current, last_selected_game: gameId }));
  }

  async function handleCategorySelect(category: CategoryKey) {
    setActiveCategory(category);
    setActiveItemId(null);
    setItemMods(null);
    setModDetails(null);
    setItemSearch("");
    setManagerCharacterView(category === "characters" ? "grid" : "workspace");
  }

  async function handleToggleMod(path: string) {
    if (!itemMods) {
      return;
    }

    setTogglePath(path);

    try {
      await invoke<string>("toggle_mod_folder", { path });
      await loadGameState(highlightedGame, itemMods.item_id);
    } catch (toggleError) {
      setScanError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setTogglePath(null);
    }
  }

  async function handleToggleFavorite(itemId: string) {
    setFavoriteItemId(itemId);

    try {
      await invoke<boolean>("toggle_item_favorite", {
        game: highlightedGame,
        itemId,
      });
      await loadGameState(highlightedGame, itemId);
    } catch (favoriteError) {
      setScanError(favoriteError instanceof Error ? favoriteError.message : String(favoriteError));
    } finally {
      setFavoriteItemId(null);
    }
  }

  async function handleSaveSettings() {
    if (!draftSettings) {
      return;
    }

    const previousModPaths = persistedSettings?.mod_paths;
    const nextModPaths = draftSettings.mod_paths;

    setSavingSettings(true);
    setSaveMessage(null);

    try {
      await invoke<string>("save_legacy_settings", {
        baseDir: state?.legacy_install?.base_dir ?? null,
        settings: draftSettings,
      });

      const scaffoldNotes: string[] = [];

      if (previousModPaths) {
        for (const gameId of GAME_ORDER) {
          const oldPath = (previousModPaths[gameId] ?? "").trim();
          const newPath = (nextModPaths[gameId] ?? "").trim();
          if (!newPath || newPath === oldPath) {
            continue;
          }

          const approve = window.confirm(
            `Create ${GAMES[gameId].name} folder scaffold in this mod path now?\n\n${newPath}`,
          );
          if (!approve) {
            continue;
          }

          try {
            const created = await invoke<number>("create_mod_folder_scaffold", {
              game: gameId,
              modRoot: newPath,
            });
            scaffoldNotes.push(`${GAMES[gameId].name}: created ${created} folders`);
          } catch (err) {
            scaffoldNotes.push(
              `${GAMES[gameId].name}: scaffold failed (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
      }

      setSaveMessage(
        scaffoldNotes.length
          ? `Settings saved. ${scaffoldNotes.join(" | ")}`
          : "Settings saved.",
      );
      await refresh();
    } catch (saveError) {
      setSaveMessage(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleInstallerSetup() {
    setSavingSettings(true);
    setSaveMessage(null);

    try {
      const info = await invoke<{
        available: boolean;
        latest_tag: string;
        app_latest_tag?: string;
        resources_latest_tag?: string;
        resources_url: string | null;
        exe_url: string | null;
        updater_url: string | null;
      }>("check_for_updates");

      if (!info.updater_url || !info.resources_url) {
        setSaveMessage("Install setup failed: release assets for updater/resources are incomplete.");
        return;
      }

      const selectedDir = await pickFolder(state?.legacy_install?.base_dir ?? undefined);
      if (!selectedDir) {
        setSaveMessage("Install setup cancelled.");
        return;
      }

      const createDesktopShortcut = window.confirm("Create a desktop shortcut for Mod Manager v2?");

      const installedPath = await invoke<string>("bootstrap_installation", {
        installDir: selectedDir,
        updaterUrl: info.updater_url,
        resourcesUrl: info.resources_url,
        appTag: info.app_latest_tag ?? info.latest_tag,
        resourcesTag: info.resources_latest_tag ?? null,
        createDesktopShortcutFlag: createDesktopShortcut,
        gameModPaths: null,
      });

      setSaveMessage(`Installation bootstrap completed at ${installedPath}.`);
      await refresh();
    } catch (err) {
      setSaveMessage(`Install setup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleThemeChange(nextThemeValue: string) {
    const nextTheme = normalizeTheme(nextThemeValue);
    const baseSettings = draftSettings ?? persistedSettings;
    if (!baseSettings) {
      return;
    }

    const nextSettings: Settings = {
      ...baseSettings,
      theme: nextTheme,
    };

    setDraftSettings(nextSettings);
    setSaveMessage(null);
    setThemeSaving(true);

    try {
      await invoke<string>("save_legacy_settings", {
        baseDir: state?.legacy_install?.base_dir ?? null,
        settings: nextSettings,
      });

      setState((current) => (current ? { ...current, settings: nextSettings } : current));
      setSaveMessage(`Theme set to ${nextTheme}.`);
    } catch (saveError) {
      setSaveMessage(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setThemeSaving(false);
    }
  }

  async function handleRunFix(scriptName: string) {
    if (!activeScriptTarget) {
      setSaveMessage("Configure a script target before running fixes.");
      return;
    }

    setRunningFix(scriptName);

    try {
      await invoke("run_fix_script", {
        game: highlightedGame,
        scriptName,
        targetPath: activeScriptTarget,
      });
      setSaveMessage(`Started ${scriptName} in a separate console window.`);
    } catch (runError) {
      setSaveMessage(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunningFix(null);
    }
  }

  async function handleOpenInExplorer(path: string) {
    try {
      await invoke("open_in_explorer", { path });
    } catch {
      // best-effort
    }
  }

  async function handleImportMod() {
    if (!importSource.trim() || !itemMods) return;
    setImportingMod(true);
    setScanError(null);
    try {
      await invoke<string>("import_mod_folder", {
        destItemPath: itemMods.path,
        sourcePath: importSource.trim(),
      });
      setImportSource("");
      await loadGameState(highlightedGame, itemMods.item_id);
    } catch (importError) {
      setScanError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setImportingMod(false);
    }
  }

  async function handleAddCharacter() {
    if (!addCharId.trim() || !addCharName.trim()) return;
    setAddingChar(true);
    setScanError(null);
    try {
      await invoke("add_custom_character", {
        game: highlightedGame,
        id: addCharId.trim(),
        name: addCharName.trim(),
      });
      setAddCharId("");
      setAddCharName("");
      setAddCharFormOpen(false);
      await loadGameState(highlightedGame, addCharId.trim());
    } catch (addError) {
      setScanError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setAddingChar(false);
    }
  }

  async function handleRemoveCharacter(itemId: string) {
    setRemovingCharId(itemId);
    setScanError(null);
    try {
      await invoke("remove_custom_character", { game: highlightedGame, id: itemId });
      if (activeItemId === itemId) {
        setActiveItemId(null);
        setItemMods(null);
        setModDetails(null);
      }
      await loadGameState(highlightedGame, activeItemId ?? undefined);
    } catch (removeError) {
      setScanError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setRemovingCharId(null);
    }
  }

  async function handleCheckForUpdates(options?: { autoPrompt?: boolean; silentUpToDate?: boolean }) {
    setUpdateChecking(true);
    if (!options?.silentUpToDate) {
      setUpdateMsg(null);
    }
    try {
      const info = await invoke<{
        available: boolean;
        current_version: string;
        latest_tag: string;
        app_update_available?: boolean;
        app_current_version?: string;
        app_latest_tag?: string;
        resources_update_available?: boolean;
        resources_current_version?: string;
        resources_latest_tag?: string;
        resources_url: string | null;
        exe_url: string | null;
        updater_url: string | null;
      }>("check_for_updates");

      // Keep local updater binary in sync with the latest release payload.
      if (info.updater_url) {
        void invoke("download_and_replace_updater", { url: info.updater_url }).catch(() => {});
      }

      setUpdateInfo(info);
      if (!info.available && !options?.silentUpToDate) {
        setUpdateMsg(
          `Already up to date (App v${info.app_current_version ?? info.current_version}, Resources v${info.resources_current_version ?? "unknown"}).`,
        );
      } else if (info.available && !options?.autoPrompt) {
        setUpdateMsg(
          `Update available: App v${info.app_latest_tag ?? info.latest_tag} | Resources v${info.resources_latest_tag ?? "?"}.`,
        );
      }

      if (info.available && options?.autoPrompt) {
        if (info.resources_update_available) {
          const approveResources = window.confirm(
            `New resources version v${info.resources_latest_tag ?? "?"} is available. Download now?`,
          );
          if (approveResources) {
            await handleDownloadUpdate(info);
          }
        }
        if (info.app_update_available) {
          const approveApp = window.confirm(
            `New app version v${info.app_latest_tag ?? info.latest_tag} is available. Download and launch updater now?`,
          );
          if (approveApp) {
            await handleLaunchAppUpdater(info);
          }
        }
      }
    } catch (err) {
      setUpdateMsg(`Check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpdateChecking(false);
    }
  }

  async function handleDownloadUpdate(infoOverride?: { resources_url: string | null; latest_tag?: string; resources_latest_tag?: string; updater_url?: string | null }) {
    const info = infoOverride ?? updateInfo;
    if (!info?.resources_url) return;

    const resourceTag = info.resources_latest_tag ?? info.latest_tag ?? "latest";
    const approve = window.confirm(`Download resources update v${resourceTag} now?`);
    if (!approve) {
      return;
    }

    setUpdateDownloading(true);
    setUpdateMsg(null);
    try {
      const result = await invoke<string>("download_and_update_resources", {
        url: info.resources_url,
        latestTag: resourceTag,
        updaterUrl: info.updater_url ?? null,
      });
      setUpdateMsg(`Resources updated to v${resourceTag} at ${result}.`);
      setUpdateInfo(null);
      await refresh();
    } catch (err) {
      setUpdateMsg(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpdateDownloading(false);
    }
  }

  async function handleLaunchAppUpdater(infoOverride?: { updater_url: string | null; exe_url?: string | null; latest_tag?: string; app_latest_tag?: string }) {
    const info = infoOverride ?? updateInfo;
    const targetVersion = info?.app_latest_tag ?? info?.latest_tag ?? "?";
    const approve = window.confirm(`Launch updater to install app update v${targetVersion} now?`);
    if (!approve) {
      return;
    }

    setUpdateDownloading(true);
    setUpdateMsg(null);
    try {
      if (info?.updater_url) {
        try {
          const updaterPath = await invoke<string>("download_and_launch_updater", {
            url: info.updater_url,
            appUrl: info.exe_url ?? null,
            appTag: targetVersion,
            updaterUrl: info.updater_url,
            managerPid: null,
          });
          setUpdateMsg(`Updater launched from ${updaterPath}. Closing app for update...`);
          try {
            await invoke("exit_for_update");
          } catch {
            // Fallback if forced exit command is unavailable.
            setTimeout(() => { void getCurrentWindow().close(); }, 150);
            setTimeout(() => { void getCurrentWindow().destroy(); }, 650);
          }
          return;
        } catch {
          // Fall through to local updater launch.
        }
      }

      const localUpdaterPath = await invoke<string>("launch_local_updater", {
        appUrl: (info as { exe_url?: string | null } | null)?.exe_url ?? null,
        appTag: targetVersion,
        updaterUrl: info?.updater_url ?? null,
        managerPid: null,
      });
      setUpdateMsg(`Updater launched from ${localUpdaterPath}. Closing app for update...`);
      try {
        await invoke("exit_for_update");
      } catch {
        setTimeout(() => { void getCurrentWindow().close(); }, 150);
        setTimeout(() => { void getCurrentWindow().destroy(); }, 650);
      }
    } catch (err) {
      setUpdateMsg(`App update launch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpdateDownloading(false);
    }
  }

  function handleDownloadEvent(payload: DownloadEventPayload) {
    if (payload.kind === "start") {
      setLastDownloadFolder(payload.destinationPath);
      setDownloadRecords((current) => [
        {
          id: payload.id,
          status: "downloading",
          modName: payload.modName,
          fileName: payload.fileName,
          destinationPath: payload.destinationPath,
          startedAt: Date.now(),
        },
        ...current,
      ]);
      return;
    }

    setDownloadRecords((current) =>
      current.map((entry) => {
        if (entry.id !== payload.id) {
          return entry;
        }
        return {
          ...entry,
          status: payload.kind === "success" ? "done" : "error",
          destinationPath: payload.destinationPath,
          installedPath: payload.installedPath ?? entry.installedPath,
          previewPath: payload.previewPath ?? entry.previewPath,
          message: payload.message,
          finishedAt: Date.now(),
        };
      }),
    );
  }

  function renderGameCard(gameId: GameKey) {
    const game = GAMES[gameId];
    const modPath = persistedSettings?.mod_paths[gameId] ?? "";
    const isSelected = persistedSettings?.last_selected_game === gameId;
    const isActive = highlightedGame === gameId;
    const categorySummary = scan?.game === gameId ? scan : null;

    return (
      <button
        key={gameId}
        type="button"
        onClick={() => {
          void handleGameSelect(gameId);
        }}
        className={clsx(
          "text-left rounded-[22px] border border-white/12 bg-white/6 p-4 shadow-[0_16px_44px_rgba(4,7,22,0.24)] backdrop-blur-sm transition-transform duration-300 hover:-translate-y-0.5",
          isSelected && "ring-1 ring-white/30",
          isActive && "border-white/30 bg-white/10",
        )}
        style={{
          backgroundImage: `linear-gradient(135deg, ${game.accent}22, rgba(255,255,255,0.04) 55%)`,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-300/70">{game.shortLabel}</p>
            <h2 className="mt-1.5 text-lg font-semibold text-white">{game.name}</h2>
          </div>
          <span
            className="inline-flex h-8 min-w-8 items-center justify-center rounded-full px-2.5 text-[11px] font-semibold text-slate-950"
            style={{ backgroundColor: game.accent }}
          >
            {game.shortLabel}
          </span>
        </div>

        <p className="mt-3 text-xs leading-5 text-slate-300/78">{game.description}</p>

        <div className="mt-3 rounded-xl border border-white/10 bg-slate-950/35 p-3">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-slate-400">
            <FolderTree className="h-3.5 w-3.5" />
            Mod Root
          </div>
          <p className="mt-2 break-all font-mono text-xs text-slate-100/88">
            {modPath || "Not configured yet"}
          </p>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-slate-300/75">
          <span>{categorySummary?.enabled_mods ?? 0} enabled mods</span>
          <span>{isActive ? "Inspecting" : isSelected ? "Current game" : "Available"}</span>
        </div>
      </button>
    );
  }

  if (state?.needs_setup) {
    return <SetupWizard state={state} onComplete={() => { void refresh(); }} />;
  }

  return (
    <main className={clsx(shellClassName, "min-h-dvh")} onContextMenu={(event) => event.preventDefault()}>
      {isDraggingOver && (
        <div
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center rounded-2xl border-4 border-dashed border-cyan-400/70 bg-cyan-400/10 backdrop-blur-sm"
          style={
            isGameTheme
              ? {
                  borderColor: gameAccentStrong,
                  backgroundColor: gameAccentFaint,
                }
              : undefined
          }
        >
          <div
            className="rounded-2xl border border-cyan-300/30 bg-slate-950/80 px-8 py-6 text-center shadow-2xl"
            style={isGameTheme ? { borderColor: gameAccentMedium } : undefined}
          >
            <div className="text-4xl">📂</div>
            <p className="mt-3 text-lg font-semibold text-cyan-300" style={isGameTheme ? { color: gameAccent } : undefined}>
              {itemMods ? `Drop to import into ${itemMods.item_id}` : "Select a character first, then drop"}
            </p>
            <p className="mt-1 text-xs text-slate-400">Drop mod folders here</p>
          </div>
        </div>
      )}
      <div className="flex min-h-dvh w-full flex-col px-4 py-4 lg:px-6">
        {activeTab === "settings" ? (
        <>
        <header className={clsx("grid gap-6 rounded-[32px] p-7 lg:grid-cols-[1.6fr_1fr]", shellPanelClassName)}>
          <div>
            <div
              className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs uppercase tracking-[0.3em] text-cyan-100"
              style={gameAccentPillStyle}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Manager Shell
            </div>
            <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Legacy data, live folders, real toggles.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300/82 sm:text-lg">
              The app reads your resources catalog, merges added characters, sorts favorites, scans item
              folders, toggles mod state with the same DISABLED_ rename behavior, and keeps settings in the same
              compatible JSON workflow used by your existing setup.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <section className={clsx("rounded-[24px] p-4", panelClassName)}>
              <div className={clsx("flex items-center gap-2 text-xs uppercase tracking-[0.26em]", textMutedClassName)}>
                <Settings2 className="h-4 w-4" />
                Settings Source
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-200">
                {state?.settings_found
                  ? "Loaded from your existing resources/settings.json"
                  : "Using compatible defaults until your resources folder is detected."}
              </p>
            </section>
            <section className={clsx("rounded-[24px] p-4", panelClassName)}>
              <div className={clsx("flex items-center gap-2 text-xs uppercase tracking-[0.26em]", textMutedClassName)}>
                <HardDriveDownload className="h-4 w-4" />
                Detected Install
              </div>
              <p className="mt-3 break-all text-sm leading-6 text-slate-200">
                {state?.legacy_install?.base_dir ?? "No install path detected yet"}
              </p>
            </section>
          </div>
        </header>

        <section className="mt-6 grid gap-4 xl:grid-cols-[1.35fr_1fr]">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className={clsx("rounded-[24px] p-5", panelClassName)}>
              <p className={clsx("text-xs uppercase tracking-[0.24em]", textMutedClassName)}>Games</p>
              <p className="mt-3 text-3xl font-semibold text-white">{GAME_ORDER.length}</p>
            </div>
            <div className={clsx("rounded-[24px] p-5", panelClassName)}>
              <p className={clsx("text-xs uppercase tracking-[0.24em]", textMutedClassName)}>Configured Paths</p>
              <p className="mt-3 text-3xl font-semibold text-white">{configuredCount}</p>
            </div>
            <div className={clsx("rounded-[24px] p-5", panelClassName)}>
              <p className={clsx("text-xs uppercase tracking-[0.24em]", textMutedClassName)}>App Version</p>
              <p className="mt-3 text-3xl font-semibold text-white">{state?.app_version ?? "—"}</p>
            </div>
          </div>

          <div className={clsx("rounded-[24px] p-5", panelClassName)}>
            <div className={clsx("flex items-center gap-2 text-xs uppercase tracking-[0.26em]", textMutedClassName)}>
              <Settings2 className="h-4 w-4" />
              Theme Settings
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {(["dark", "light", "game"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    void handleThemeChange(mode);
                  }}
                  disabled={themeSaving}
                  className={clsx(
                    "rounded-full border px-4 py-2 text-sm font-medium transition capitalize disabled:cursor-wait disabled:opacity-70",
                    themeMode === mode
                      ? "border-cyan-300/40 bg-cyan-500/20 text-cyan-100"
                      : "border-white/10 text-slate-300 hover:bg-white/8",
                  )}
                  style={themeMode === mode && isGameTheme ? gameAccentPillStyle : undefined}
                >
                  {themeSaving && themeMode === mode ? "Saving…" : mode}
                </button>
              ))}
            </div>
          </div>
        </section>
        </>
        ) : null}

        <section className={clsx("mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[24px] p-4", panelClassName)}>
            <button
              type="button"
              onClick={() => {
                setActiveTab("manager");
              }}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
                activeTab === "manager"
                  ? navActiveClassName
                  : navIdleClassName,
              )}
              style={activeTab === "manager" ? navActiveStyle : navIdleStyle}
            >
              <Layers3 className="h-4 w-4" />
              Manager
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("browse");
              }}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
                activeTab === "browse"
                  ? navActiveClassName
                  : navIdleClassName,
              )}
              style={activeTab === "browse" ? navActiveStyle : navIdleStyle}
            >
              <Globe className="h-4 w-4" />
              Browse
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("downloads");
              }}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
                activeTab === "downloads"
                  ? navActiveClassName
                  : navIdleClassName,
              )}
              style={activeTab === "downloads" ? navActiveStyle : navIdleStyle}
            >
              <HardDriveDownload className="h-4 w-4" />
              Downloads
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("fixes");
              }}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
                activeTab === "fixes"
                  ? navActiveClassName
                  : navIdleClassName,
              )}
              style={activeTab === "fixes" ? navActiveStyle : navIdleStyle}
            >
              <Gamepad2 className="h-4 w-4" />
              Fix Manager
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("settings");
              }}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
                activeTab === "settings"
                  ? navActiveClassName
                  : navIdleClassName,
              )}
              style={activeTab === "settings" ? navActiveStyle : navIdleStyle}
            >
              <Settings2 className="h-4 w-4" />
              Settings
            </button>
            <button
              type="button"
              onClick={() => {
                void refresh();
              }}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition disabled:cursor-wait disabled:opacity-70",
                isGameTheme
                  ? "text-slate-100 hover:brightness-110"
                  : "border-white/10 bg-white text-slate-950 hover:bg-cyan-100",
              )}
              style={
                isGameTheme
                  ? {
                      borderColor: gameAccentMedium,
                      backgroundColor: gameAccentSoft,
                    }
                  : undefined
              }
              disabled={loading || scanLoading || itemLoading || savingSettings}
            >
              <RefreshCw
                className={clsx(
                  "h-4 w-4",
                  (loading || scanLoading || itemLoading || savingSettings) && "animate-spin",
                )}
              />
              Refresh state
            </button>
            <button
              type="button"
              onClick={() => void handleCheckForUpdates()}
              disabled={updateChecking || updateDownloading}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition disabled:cursor-wait disabled:opacity-70",
                updateInfo?.available
                  ? isGameTheme
                    ? "text-slate-100"
                    : "border-emerald-300/30 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25"
                  : isGameTheme
                    ? "text-slate-200/90 hover:bg-white/8"
                    : "border-white/10 text-slate-300 hover:bg-white/8",
              )}
              style={
                isGameTheme
                  ? {
                      borderColor: updateInfo?.available ? gameAccentStrong : gameAccentFaint,
                      backgroundColor: updateInfo?.available ? gameAccentSoft : "transparent",
                    }
                  : undefined
              }
            >
              <Download className="h-4 w-4" />
              {updateChecking
                ? "Checking…"
                : updateInfo?.available
                  ? `${updateInfo.app_update_available ? "App" : "Resources"} update available`
                  : "Check updates"}
            </button>
            <div
              className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-300"
              style={isGameTheme ? { borderColor: gameAccentFaint, color: "#dbeafe" } : undefined}
            >
              Active game: {highlightedGame}
            </div>
        </section>

        {error ? (
          <section className="mt-6 flex items-start gap-3 rounded-[24px] border border-rose-300/20 bg-rose-400/10 p-5 text-rose-100">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <h2 className="text-base font-semibold">Bootstrap failed</h2>
              <p className="mt-2 text-sm leading-6 text-rose-100/90">{error}</p>
            </div>
          </section>
        ) : null}

        {/* Update available banner */}
        {updateInfo?.available ? (
          <section
            className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-[24px] border border-emerald-300/20 bg-emerald-400/10 p-5 text-emerald-100"
            style={
              isGameTheme
                ? {
                    borderColor: gameAccentMedium,
                    backgroundColor: gameAccentFaint,
                    color: "#eaf6ff",
                  }
                : undefined
            }
          >
            <div className="flex items-start gap-3">
              <Download className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <h2 className="text-base font-semibold">Updates available</h2>
                <p className="mt-1 text-sm text-emerald-100/80" style={isGameTheme ? { color: "rgba(234, 246, 255, 0.82)" } : undefined}>
                  App: v{updateInfo.app_current_version ?? updateInfo.current_version} → v{updateInfo.app_latest_tag ?? updateInfo.latest_tag} {updateInfo.app_update_available ? "(update available)" : "(up to date)"}
                </p>
                <p className="mt-1 text-sm text-emerald-100/80" style={isGameTheme ? { color: "rgba(234, 246, 255, 0.82)" } : undefined}>
                  Resources: v{updateInfo.resources_current_version ?? "unknown"} → v{updateInfo.resources_latest_tag ?? "unknown"} {updateInfo.resources_update_available ? "(update available)" : "(up to date)"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleDownloadUpdate()}
              disabled={updateDownloading || !updateInfo.resources_update_available}
              className={clsx(
                "shrink-0 inline-flex items-center gap-2 rounded-full border px-5 py-2 text-sm font-medium transition disabled:cursor-wait disabled:opacity-70",
                isGameTheme
                  ? "text-slate-100 hover:brightness-110"
                  : "border-emerald-300/30 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30",
              )}
              style={
                isGameTheme
                  ? {
                      borderColor: gameAccentStrong,
                      backgroundColor: gameAccentSoft,
                    }
                  : undefined
              }
            >
              <Download className="h-4 w-4" />
              {updateDownloading ? "Downloading…" : "Update Resources"}
            </button>
            <button
              type="button"
              onClick={() => {
                const approve = window.confirm(
                  `Download and launch updater for v${updateInfo.app_latest_tag ?? updateInfo.latest_tag}? This updates the app executable.`,
                );
                if (approve) {
                  void handleLaunchAppUpdater();
                }
              }}
              disabled={updateDownloading || !updateInfo.app_update_available}
              className={clsx(
                "shrink-0 inline-flex items-center gap-2 rounded-full border px-5 py-2 text-sm font-medium transition disabled:cursor-wait disabled:opacity-70",
                isGameTheme
                  ? "text-slate-100 hover:brightness-110"
                  : "border-cyan-300/30 bg-cyan-500/20 text-cyan-100 hover:bg-cyan-500/30",
              )}
              style={
                isGameTheme
                  ? {
                      borderColor: gameAccentStrong,
                      backgroundColor: gameAccentSoft,
                    }
                  : undefined
              }
            >
              <Download className="h-4 w-4" />
              {updateDownloading ? "Preparing…" : "Update App"}
            </button>
          </section>
        ) : null}
        {updateMsg ? (
          <p className="mt-3 text-sm text-slate-300">{updateMsg}</p>
        ) : null}

        {activeTab === "browse" ? (
          <BrowseTab
            game={highlightedGame}
            gameModRoot={currentModRoot}
            onDownloadEvent={handleDownloadEvent}
          />
        ) : (
          <>

        {activeTab === "manager" ? (
        <>
        <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{GAME_ORDER.map(renderGameCard)}</section>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void openUrl(GAMEBANANA_URLS[highlightedGame]).catch(() => {
                window.open(GAMEBANANA_URLS[highlightedGame], "_blank");
              });
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-1.5 text-xs text-slate-300 transition hover:bg-white/8"
          >
            GameBanana ↗
          </button>
          {RABBITFX_URLS[highlightedGame] ? (
            <button
              type="button"
              onClick={() => {
                const url = RABBITFX_URLS[highlightedGame]!;
                void openUrl(url).catch(() => { window.open(url, "_blank"); });
              }}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-1.5 text-xs text-slate-300 transition hover:bg-white/8"
            >
              RabbitFX ↗
            </button>
          ) : null}
        </div>

        <section
          className={clsx(
            "mt-4 grid gap-4",
            activeCategory === "characters"
              ? "xl:grid-cols-[240px_minmax(0,1fr)]"
              : "xl:grid-cols-[240px_340px_minmax(0,1fr)]",
          )}
        >
          <aside className={clsx("rounded-[28px] p-6", panelClassName)}>
            <div className={clsx("flex items-center gap-2 text-xs uppercase tracking-[0.28em]", textMutedClassName)}>
              <Layers3 className="h-4 w-4" />
              Categories
            </div>
            <div className="mt-5 space-y-3 pr-1">
              {CATEGORY_ORDER.map((category) => {
                const summary = inventory?.categories.find((entry) => entry.category === category);
                const isActive = activeCategory === category;

                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() => {
                      void handleCategorySelect(category);
                    }}
                    className={clsx(
                      "w-full rounded-2xl border border-white/8 bg-white/4 p-4 text-left transition hover:bg-white/8",
                      isActive && "border-white/25 bg-white/10",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium capitalize text-white">{category}</p>
                        <p className="mt-1 text-xs text-slate-400">{summary?.items.length ?? 0} items</p>
                      </div>
                      <div className="text-right text-xs text-slate-300">
                        <p>{summary?.items.reduce((count, item) => count + item.enabled_mods, 0) ?? 0} enabled</p>
                        <p>{summary?.items.reduce((count, item) => count + item.disabled_mods, 0) ?? 0} disabled</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {activeCategory === "characters" && managerCharacterView === "workspace" ? null : (
          <aside className={clsx("rounded-[28px] p-6", panelClassName)}>
            <div className={clsx("flex items-center gap-2 text-xs uppercase tracking-[0.28em]", textMutedClassName)}>
              <Gamepad2 className="h-4 w-4" />
              {highlightedGameConfig.name} Items
            </div>
            <p className="mt-3 break-all text-sm leading-6 text-slate-300/82">{currentCategory?.folder_path ?? currentModRoot}</p>
            <input
              value={itemSearch}
              onChange={(e) => {
                setItemSearch(e.currentTarget.value);
              }}
              placeholder="Filter items…"
              className="mt-3 w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-white placeholder:text-slate-500"
            />
            <div
              className={clsx(
                "mt-4 overflow-x-hidden pr-1",
                activeCategory === "characters"
                  ? "grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
                  : "max-h-[58vh] space-y-3 overflow-y-auto",
              )}
            >
              {filteredItems.length ? (
                filteredItems.map((item) => {
                  const isActive = activeItemId === item.id;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        if (activeCategory === "characters") {
                          setManagerCharacterView("workspace");
                        }
                        void loadItemMods(highlightedGame, activeCategory, item, currentModRoot);
                      }}
                      className={clsx(
                        "w-full rounded-2xl border border-white/8 bg-white/4 p-4 text-left transition hover:bg-white/8",
                        activeCategory === "characters" && "min-h-[170px] p-3",
                        isActive && "border-white/25 bg-white/10",
                      )}
                    >
                      <div className={clsx("flex", activeCategory === "characters" ? "h-full flex-col" : "items-start justify-between gap-3") }>
                        <div className={clsx(activeCategory === "characters" ? "flex h-full flex-col" : "flex min-w-0 items-start gap-3") }>
                          <div
                            className={clsx(
                              "relative shrink-0 overflow-hidden rounded-xl border bg-slate-900/60",
                              categoryIconAccent(activeCategory),
                              activeCategory === "characters" ? "mx-auto h-16 w-16" : "h-16 w-16",
                            )}
                          >
                            <div className="absolute inset-0 flex h-full w-full items-center justify-center text-xs font-semibold uppercase text-slate-300">
                              {iconFallbackLabel(activeCategory, item.name, item.id)}
                            </div>
                            {item.icon_path ? (
                              <img
                                src={iconDataUrls[item.icon_path] ?? toAssetSrc(item.icon_path)}
                                alt={item.name}
                                className="relative z-10 h-full w-full object-cover"
                                onError={(e) => {
                                  if (!item.icon_path || iconDataUrls[item.icon_path]) {
                                    (e.currentTarget as HTMLImageElement).style.display = "none";
                                    return;
                                  }

                                  void invoke<string>("load_image_data_url", { path: item.icon_path })
                                    .then((dataUrl) => {
                                      setIconDataUrls((current) => ({ ...current, [item.icon_path!]: dataUrl }));
                                    })
                                    .catch(() => {
                                      (e.currentTarget as HTMLImageElement).style.display = "none";
                                    });
                                }}
                              />
                            ) : null}
                          </div>

                          {activeCategory === "characters" ? (
                            <>
                              <p className="mt-2 text-center text-[13px] font-semibold leading-4 text-white">{item.name}</p>
                              <p className="mt-1 text-center font-mono text-[10px] text-slate-400">{item.id}</p>
                              <div className="mt-auto pt-2 text-[11px] text-slate-300">
                                <div className="flex items-center justify-between">
                                  <span>{item.total_mods} mods</span>
                                  <span>{item.enabled_mods} enabled</span>
                                </div>
                              </div>
                            </>
                          ) : (
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-sm font-medium text-white">{item.name}</p>
                                {item.is_custom ? (
                                  <span className="shrink-0 rounded-full border border-violet-300/20 bg-violet-300/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.2em] text-violet-200">
                                    Custom
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 font-mono text-xs text-slate-400">{item.id}</p>
                            </div>
                          )}
                        </div>

                        <div className={clsx("flex shrink-0 items-center gap-1", activeCategory === "characters" ? "mt-2 justify-center" : "") }>
                          {item.is_custom ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleRemoveCharacter(item.id);
                              }}
                              disabled={removingCharId === item.id}
                              className="inline-flex items-center rounded-full border border-rose-300/20 bg-rose-300/10 px-2 py-1 text-[10px] text-rose-100 disabled:cursor-wait disabled:opacity-70"
                              title="Remove custom character"
                            >
                              {removingCharId === item.id ? "…" : "×"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleToggleFavorite(item.id);
                            }}
                            disabled={favoriteItemId === item.id}
                            className={clsx(
                              "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] disabled:cursor-wait disabled:opacity-70",
                              item.favorite
                                ? "border-amber-300/20 bg-amber-300/10 text-amber-100"
                                : "border-white/10 bg-slate-950/35 text-slate-300",
                            )}
                          >
                            <Star className={clsx("h-3 w-3", item.favorite && "fill-current")} />
                            {favoriteItemId === item.id ? "Saving" : item.favorite ? "Fav" : "Star"}
                          </button>
                        </div>
                      </div>
                    </button>
                  );
                })
              ) : (
                <p className="rounded-2xl border border-white/8 bg-white/4 p-4 text-sm text-slate-400">
                  {itemSearch.trim() ? "No items match your search." : "No item metadata loaded for this category yet."}
                </p>
              )}
            </div>

            {activeCategory === "characters" ? (
              <div className="mt-4 rounded-2xl border border-white/8 bg-white/4 p-4">
                {addCharFormOpen ? (
                  <div className="space-y-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Add Custom Character</p>
                    <input
                      value={addCharId}
                      onChange={(e) => { setAddCharId(e.currentTarget.value); }}
                      placeholder="ID (e.g. MyChar)"
                      className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-sm text-white"
                    />
                    <input
                      value={addCharName}
                      onChange={(e) => { setAddCharName(e.currentTarget.value); }}
                      placeholder="Display name"
                      className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => { void handleAddCharacter(); }}
                        disabled={addingChar || !addCharId.trim() || !addCharName.trim()}
                        className="flex-1 rounded-full border border-white/10 bg-white py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-70"
                      >
                        {addingChar ? "Adding..." : "Add"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAddCharFormOpen(false); setAddCharId(""); setAddCharName(""); }}
                        className="flex-1 rounded-full border border-white/10 py-2 text-sm text-slate-300 transition hover:bg-white/8"
                      >
                        Cancel
                      </button>
                    </div>
                    {scanError ? <p className="text-xs text-rose-300">{scanError}</p> : null}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setAddCharFormOpen(true); }}
                    className="w-full rounded-xl border border-dashed border-white/15 py-2 text-sm text-slate-400 transition hover:border-white/30 hover:text-white"
                  >
                    + Add Custom Character
                  </button>
                )}
              </div>
            ) : null}
          </aside>
          )}

          {activeCategory === "characters" && managerCharacterView === "grid" ? null : !itemMods && activeCategory === "characters" ? (
            <section className={clsx("rounded-[28px] p-6", panelClassName)}>
              <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-white/20 bg-white/4 px-6 text-center text-slate-300">
                Select a character from the grid to open its mod list and preview workspace.
              </div>
            </section>
          ) : (
          <section className={clsx("rounded-[28px] p-6", panelClassName)}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-slate-400">
                  <FolderTree className="h-4 w-4" />
                  Item Mods
                </div>
                {activeCategory === "characters" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setManagerCharacterView("grid");
                      setItemMods(null);
                      setModDetails(null);
                      setModPreviewImages([]);
                      setActiveItemId(null);
                    }}
                    className="mt-2 inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-slate-200 transition hover:bg-white/8"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to character grid
                  </button>
                ) : null}
                <h2 className="mt-3 text-2xl font-semibold text-white">{itemMods?.item_name ?? "Select an item"}</h2>
                <div className="mt-2 flex items-center gap-3">
                  <p className="break-all font-mono text-xs text-slate-400">{itemMods?.path ?? currentModRoot}</p>
                  {itemMods?.path ? (
                    <button
                      type="button"
                      onClick={() => { void handleOpenInExplorer(itemMods.path); }}
                      className="shrink-0 rounded-full border border-emerald-300/30 bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/30"
                      title="Open folder in Explorer"
                    >
                      Open
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="grid min-w-[220px] grid-cols-3 gap-3">
                <div className="rounded-2xl border border-white/8 bg-white/4 p-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Total</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{itemMods?.total_mods ?? 0}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/4 p-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Enabled</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{itemMods?.enabled_mods ?? 0}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/4 p-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Disabled</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{itemMods?.disabled_mods ?? 0}</p>
                </div>
              </div>
            </div>

            {scanError ? (
              <div className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-400/10 p-4 text-sm leading-6 text-rose-100">
                {scanError}
              </div>
            ) : null}

            {itemMods && itemMods.total_mods > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { void handleBatchToggle(true); }}
                  disabled={batchToggling}
                  className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-slate-200 transition hover:bg-white/8 disabled:cursor-wait disabled:opacity-60"
                >
                  {batchToggling ? "Working…" : "Enable All"}
                </button>
                <button
                  type="button"
                  onClick={() => { void handleBatchToggle(false); }}
                  disabled={batchToggling}
                  className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-slate-200 transition hover:bg-white/8 disabled:cursor-wait disabled:opacity-60"
                >
                  {batchToggling ? "Working…" : "Disable All"}
                </button>
              </div>
            ) : null}

            {itemMods ? (
              <div className="mt-4 space-y-2">
                {dragDropMsg && (
                  <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
                    <span>{dragDropMsg}</span>
                    <button onClick={() => setDragDropMsg(null)} className="ml-2 text-slate-500 hover:text-white">✕</button>
                  </div>
                )}
                <p className="text-[10px] text-slate-500">Drag &amp; drop mod folders onto the window, or paste a path below.</p>
                <div className="flex items-center gap-2">
                <input
                  value={importSource}
                  onChange={(e) => { setImportSource(e.currentTarget.value); }}
                  placeholder="Paste a mod folder path to import…"
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-xs text-white"
                />
                <button
                  type="button"
                  onClick={() => { void handleImportMod(); }}
                  disabled={importingMod || !importSource.trim()}
                  className="shrink-0 rounded-full border border-white/10 bg-white px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-70"
                >
                  {importingMod ? "Importing…" : "Import Folder"}
                </button>
              </div>
              </div>
            ) : null}

            <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
              <div className="max-h-[58vh] space-y-3 overflow-y-auto pr-1">
              {itemLoading ? (
                <div className="rounded-2xl border border-white/8 bg-white/4 p-5 text-sm text-slate-300">
                  Loading item mods...
                </div>
              ) : itemMods?.mods.length ? (
                itemMods.mods.map((mod) => (
                  <article
                    key={mod.path}
                    className={clsx(
                      "cursor-pointer rounded-[24px] border bg-white/4 p-5 transition",
                      modDetails?.mod_path === mod.path
                        ? "border-cyan-300/35 bg-cyan-300/10"
                        : "border-white/8 hover:border-white/25 hover:bg-white/8",
                    )}
                    onClick={() => {
                      void loadModDetails(mod.path);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (persistedSettings?.right_click_toggle_mods) {
                        void handleToggleMod(mod.path);
                      }
                    }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-base font-medium text-white">{mod.display_name}</p>
                        <p className="mt-2 break-all font-mono text-xs text-slate-400">{mod.path}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <span
                          className={clsx(
                            "rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em]",
                            mod.disabled
                              ? "border border-rose-300/20 bg-rose-300/10 text-rose-100"
                              : "border border-emerald-300/20 bg-emerald-300/10 text-emerald-100",
                          )}
                        >
                          {mod.disabled ? "Disabled" : "Enabled"}
                        </span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleOpenInExplorer(mod.path);
                          }}
                          className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/8"
                          title="Open in Explorer"
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleToggleMod(mod.path);
                          }}
                          disabled={togglePath === mod.path}
                          className="rounded-full border border-white/10 bg-white px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-70"
                        >
                          {togglePath === mod.path ? "Working..." : mod.disabled ? "Enable" : "Disable"}
                        </button>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <div className="rounded-[24px] border border-white/8 bg-white/4 p-6 text-sm leading-6 text-slate-300/82">
                  No mod folders found for this item yet.
                </div>
              )}
              </div>

              <div className="rounded-[24px] border border-white/8 bg-white/4 p-5">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">INI Inspector</p>
              <p className="mt-2 break-all font-mono text-xs text-slate-400">
                {modDetails?.ini_path ?? modDetails?.mod_path ?? "Select a mod and inspect it."}
              </p>

              {modPreviewImages.length > 0 ? (
                <div className="mt-4 rounded-2xl border border-amber-300/35 bg-white/95 p-2">
                  <div className="relative flex h-[340px] items-center justify-center overflow-hidden rounded-xl bg-[#e5e3e1]">
                    {!previewLoadError ? (
                      <img
                        src={previewDataUrl ?? toAssetSrc(currentPreviewPath ?? "")}
                        alt={`mod preview ${previewIndex + 1}`}
                        className="max-h-full w-auto max-w-full object-contain"
                        onError={() => {
                          if (!previewDataUrl && currentPreviewPath) {
                            void ensurePreviewFallback(currentPreviewPath);
                          } else {
                            setPreviewLoadError(true);
                          }
                        }}
                      />
                    ) : (
                      <div className="px-4 text-center text-sm text-slate-500">
                        Preview image failed to load. Path may contain special characters.
                      </div>
                    )}
                    {modPreviewImages.length > 1 ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewIndex((current) =>
                              (current - 1 + modPreviewImages.length) % modPreviewImages.length,
                            );
                          }}
                          className="absolute left-2 rounded-lg border border-amber-300/60 bg-amber-500/90 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-500"
                        >
                          ◀
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewIndex((current) => (current + 1) % modPreviewImages.length);
                          }}
                          className="absolute right-2 rounded-lg border border-amber-300/60 bg-amber-500/90 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-500"
                        >
                          ▶
                        </button>
                      </>
                    ) : null}
                  </div>
                  {modPreviewImages.length > 1 ? (
                    <p className="mt-2 text-center text-xs text-slate-500">
                      Preview {previewIndex + 1} / {modPreviewImages.length}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4 rounded-2xl border border-white/15 bg-slate-900/35 p-4">
                  <div className="flex h-[220px] items-center justify-center rounded-xl border border-dashed border-white/20 text-sm text-slate-400">
                    No preview image found for this mod.
                  </div>
                </div>
              )}
              <div className="mt-4 space-y-2">
                {modDetailsLoading ? (
                  <p className="text-sm text-slate-300">Loading INI data...</p>
                ) : modDetails?.toggles.length ? (
                  <>
                    {modDetails.toggles.map((toggle) => (
                      <button
                        key={toggle.name}
                        type="button"
                        onClick={() => {
                          setIniSection(toggle.name);
                          setIniEditKey(toggle.key);
                          setIniEditBack(toggle.back ?? "");
                          setIniSaveMsg(null);
                        }}
                        className={clsx(
                          "w-full rounded-2xl border p-4 text-left transition hover:border-white/25",
                          iniSection === toggle.name
                            ? "border-white/25 bg-white/10"
                            : "border-white/8 bg-slate-950/35",
                        )}
                      >
                        <p className="text-sm font-medium text-white">{toggle.name}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          key: {toggle.key}
                          {toggle.back ? ` / back: ${toggle.back}` : ""}
                        </p>
                      </button>
                    ))}

                    {iniSection ? (
                      <div className="mt-3 rounded-2xl border border-white/8 bg-slate-950/35 p-4 space-y-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                          Editing [{iniSection}]
                        </p>
                        <label className="block">
                          <span className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Forward key</span>
                          <input
                            value={iniEditKey}
                            onChange={(e) => { setIniEditKey(e.currentTarget.value); }}
                            className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-sm text-white"
                            placeholder="e.g. VK_UP"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Back key (optional)</span>
                          <input
                            value={iniEditBack}
                            onChange={(e) => { setIniEditBack(e.currentTarget.value); }}
                            className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-sm text-white"
                            placeholder="e.g. VK_DOWN"
                          />
                        </label>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => { void handleSaveIni(); }}
                            disabled={iniSaving || !iniEditKey.trim()}
                            className="rounded-full border border-white/10 bg-white px-4 py-1.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-70"
                          >
                            {iniSaving ? "Saving…" : "Save"}
                          </button>
                          {iniSaveMsg ? (
                            <p className={clsx("text-xs", iniSaveMsg === "Saved." ? "text-green-300" : "text-rose-300")}>
                              {iniSaveMsg}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-slate-400">No INI toggle entries loaded for the selected mod.</p>
                )}
              </div>
              </div>
            </div>
          </section>
          )}
        </section>
        </>
        ) : null}

        {activeTab === "settings" || activeTab === "fixes" || activeTab === "downloads" ? (
        <section className="mt-6 grid items-start gap-4">
          {activeTab === "settings" ? (
          <section className={clsx("rounded-[28px] p-6", panelClassName)}>
            <div className={clsx("flex items-center gap-2 text-xs uppercase tracking-[0.28em]", textMutedClassName)}>
              <Settings2 className="h-4 w-4" />
              Settings Editor
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/8 bg-white/4 p-4">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">App Version</span>
                <p className="mt-3 text-sm text-white">{state?.app_version ?? "—"}</p>
              </div>

              <div className="rounded-2xl border border-white/8 bg-white/4 p-4">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Resources Version</span>
                <p className="mt-3 text-sm text-white">{draftSettings?.version ?? "—"}</p>
              </div>

              <label className="rounded-2xl border border-white/8 bg-white/4 p-4">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Theme</span>
                <select
                  value={draftSettings?.theme ?? "dark"}
                  onChange={(event) => {
                    void handleThemeChange(event.currentTarget.value);
                  }}
                  disabled={themeSaving}
                  className="mt-3 w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white"
                >
                  <option value="dark">dark</option>
                  <option value="light">light</option>
                  <option value="game">game</option>
                </select>
              </label>

              <label className="rounded-2xl border border-white/8 bg-white/4 p-4">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Last Selected Game</span>
                <select
                  value={draftSettings?.last_selected_game ?? highlightedGame}
                  onChange={(event) => {
                    const nextGame = event.currentTarget.value as GameKey;
                    setActiveGame(nextGame);
                    updateDraftSettings((current) => ({ ...current, last_selected_game: nextGame }));
                  }}
                  className="mt-3 w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white"
                >
                  {GAME_ORDER.map((gameId) => (
                    <option key={gameId} value={gameId}>
                      {GAMES[gameId].name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="rounded-2xl border border-white/8 bg-white/4 p-4 sm:col-span-2">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Update & Interaction</span>
                <div className="mt-3 space-y-2 text-sm text-slate-200">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(draftSettings?.auto_check_updates)}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.checked;
                        updateDraftSettings((current) => ({ ...current, auto_check_updates: nextValue }));
                      }}
                    />
                    Auto-check updates on startup (with confirmation)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(draftSettings?.right_click_toggle_mods)}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.checked;
                        updateDraftSettings((current) => ({ ...current, right_click_toggle_mods: nextValue }));
                      }}
                    />
                    Right-click toggles mods
                  </label>
                </div>
              </label>
            </div>

            <div className="mt-4 grid gap-4">
              {GAME_ORDER.map((gameId) => (
                <label key={gameId} className="rounded-2xl border border-white/8 bg-white/4 p-4">
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-400">{GAMES[gameId].name} Mod Path</span>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={draftSettings?.mod_paths[gameId] ?? ""}
                      onChange={(event) => {
                        const nextPath = event.currentTarget.value;
                        updateDraftSettings((current) => ({
                          ...current,
                          mod_paths: {
                            ...current.mod_paths,
                            [gameId]: nextPath,
                          },
                        }));
                      }}
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-sm text-white"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void (async () => {
                          const selected = await pickFolder(draftSettings?.mod_paths[gameId]);
                          if (!selected) return;
                          updateDraftSettings((current) => ({
                            ...current,
                            mod_paths: {
                              ...current.mod_paths,
                              [gameId]: selected,
                            },
                          }));
                        })();
                      }}
                      className="shrink-0 rounded-full border border-white/10 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/8"
                    >
                      Browse
                    </button>
                  </div>
                </label>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  void handleSaveSettings();
                }}
                disabled={!draftSettings || savingSettings}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-70"
              >
                <Save className="h-4 w-4" />
                {savingSettings ? "Saving..." : "Save Settings"}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleInstallerSetup();
                }}
                disabled={savingSettings}
                className="inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-500/20 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/30 disabled:cursor-wait disabled:opacity-70"
              >
                <Download className="h-4 w-4" />
                {savingSettings ? "Running install setup..." : "Install/Repair Setup"}
              </button>
              {saveMessage ? <p className="text-sm text-slate-300">{saveMessage}</p> : null}
            </div>
          </section>
          ) : null}

          {activeTab === "downloads" ? (
          <section className={clsx("rounded-[28px] p-6", panelClassName)}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className={clsx("flex items-center gap-2 text-xs uppercase tracking-[0.28em]", textMutedClassName)}>
                <HardDriveDownload className="h-4 w-4" />
                Download Session
              </div>
              {lastDownloadFolder ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleOpenInExplorer(lastDownloadFolder);
                  }}
                  className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/8"
                >
                  Open Last Download Folder
                </button>
              ) : null}
            </div>

            <p className="mt-3 text-sm text-slate-300/80">
              Active and completed downloads for this app session. This list resets when the app is closed.
            </p>

            <div className="mt-4 space-y-3">
              {downloadRecords.length === 0 ? (
                <p className="rounded-2xl border border-white/8 bg-white/4 p-4 text-sm text-slate-400">
                  No downloads in this session yet.
                </p>
              ) : (
                downloadRecords.map((entry) => (
                  <article key={entry.id} className="rounded-2xl border border-white/8 bg-white/4 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white">{entry.modName}</p>
                        <p className="mt-1 text-xs text-slate-400">{entry.fileName}</p>
                        <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{entry.destinationPath}</p>
                      </div>
                      <span
                        className={clsx(
                          "rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.2em]",
                          entry.status === "done"
                            ? "border border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
                            : entry.status === "error"
                              ? "border border-rose-300/30 bg-rose-500/15 text-rose-100"
                              : "border border-cyan-300/30 bg-cyan-500/15 text-cyan-100",
                        )}
                      >
                        {entry.status === "downloading" ? "Downloading" : entry.status === "done" ? "Installed" : "Failed"}
                      </span>
                    </div>

                    {entry.message ? <p className="mt-2 text-xs text-rose-300">{entry.message}</p> : null}

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void handleOpenInExplorer(entry.destinationPath);
                        }}
                        className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/8"
                      >
                        Open Destination
                      </button>
                      {entry.installedPath ? (
                        <button
                          type="button"
                          onClick={() => {
                            void handleOpenInExplorer(entry.installedPath!);
                          }}
                          className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/8"
                        >
                          Open Mod Folder
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
          ) : null}

          {activeTab === "fixes" ? (
          <aside className={clsx("rounded-[28px] p-6", panelClassName)}>
            <div className={clsx("flex items-center gap-2 text-xs uppercase tracking-[0.28em]", textMutedClassName)}>
              <Gamepad2 className="h-4 w-4" />
              Fixes Panel
            </div>
            <label className="mt-5 block rounded-2xl border border-white/8 bg-white/4 p-4">
              <span className="text-xs uppercase tracking-[0.2em] text-slate-400">{highlightedGameConfig.name} Script Target</span>
              <div className="mt-3 flex gap-2">
                <input
                  value={draftSettings?.script_targets[highlightedGame] ?? ""}
                  onChange={(event) => {
                    const nextPath = event.currentTarget.value;
                    updateDraftSettings((current) => ({
                      ...current,
                      script_targets: {
                        ...current.script_targets,
                        [highlightedGame]: nextPath,
                      },
                    }));
                  }}
                  placeholder={currentModRoot || "Target path"}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-sm text-white"
                />
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      const selected = await pickFolder(draftSettings?.script_targets[highlightedGame]);
                      if (!selected) return;
                      updateDraftSettings((current) => ({
                        ...current,
                        script_targets: {
                          ...current.script_targets,
                          [highlightedGame]: selected,
                        },
                      }));
                    })();
                  }}
                  className="shrink-0 rounded-full border border-white/10 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/8"
                >
                  Browse
                </button>
              </div>
            </label>

            <div className="mt-4 rounded-2xl border border-white/8 bg-white/4 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Available Scripts</p>
                <button
                  type="button"
                  onClick={() => {
                    void loadFixes(highlightedGame);
                  }}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-200 transition hover:bg-white/8"
                >
                  Refresh
                </button>
              </div>
              <div className="mt-4 max-h-[42vh] space-y-3 overflow-y-auto pr-1">
                {fixesLoading ? (
                  <p className="text-sm text-slate-300">Loading fixes...</p>
                ) : fixesPanel?.scripts.length ? (
                  fixesPanel.scripts.map((script) => (
                    <div key={script.name} className="rounded-2xl border border-white/8 bg-slate-950/35 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-white" title={script.name}>{script.name}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">{script.kind}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void handleRunFix(script.name);
                          }}
                          disabled={runningFix === script.name || !activeScriptTarget}
                          className="shrink-0 rounded-full border border-white/10 bg-white px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-70"
                        >
                          {runningFix === script.name ? "Starting..." : "Run"}
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-400">No .py or .exe scripts found for this game.</p>
                )}
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-white/8 bg-white/4 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Shared Fixes Info</p>
              <pre className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-slate-300/82">
                {fixesPanel?.info_text ?? "No info loaded."}
              </pre>
            </div>

          </aside>
          ) : null}
        </section>
        ) : null}
          </>
        )}
      </div>
    </main>
  );
}

export default App;
