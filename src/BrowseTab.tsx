import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import { BROWSE_GAME_DATA, GAME_ORDER, GAMEBANANA_URLS, GAMES, RABBITFX_URLS } from "./config/games";
import type { GameKey } from "./types";

interface GbCategory {
  id: number;
  name: string;
}

interface GbMod {
  id: number;
  name: string;
  profile: string;
  preview: string | null;
  submitter: string;
  summary: string;
}

interface GbFile {
  id: number;
  name: string;
  size: number;
  url: string;
}

interface GbDetail {
  description: string;
  files: GbFile[];
}

interface DownloadInstallResult {
  installed_path: string;
  destination_path: string;
  preview_path: string | null;
}

export interface DownloadEventPayload {
  kind: "start" | "success" | "error";
  id: string;
  modName: string;
  fileName: string;
  destinationPath: string;
  installedPath?: string;
  previewPath?: string | null;
  message?: string;
}

const GB_BASE = "https://gamebanana.com/apiv11";

async function gbFetch(endpoint: string): Promise<unknown> {
  const resp = await fetch(`${GB_BASE}/${endpoint}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`GB API ${resp.status}: ${resp.statusText}`);
  return resp.json() as Promise<unknown>;
}

function extractPreviewUrl(rec: Record<string, unknown>): string | null {
  const media = rec._aPreviewMedia as Record<string, unknown> | null | undefined;
  if (media && typeof media === "object") {
    const rawImages = media._aImages ?? Object.values(media)[0];
    const images = Array.isArray(rawImages) ? (rawImages as Record<string, unknown>[]) : null;
    if (images) {
      for (const img of images) {
        const base = img._sBaseUrl as string | undefined;
        for (const key of ["_sFile530", "_sFile220", "_sFile100", "_sFile"]) {
          if (base && img[key]) return `${base}/${img[key] as string}`;
        }
        if (img._sUrl) return img._sUrl as string;
        if (img.url) return img.url as string;
      }
    }
  }
  return (rec._sPreviewUrl as string | null) ?? null;
}

function normalizeRecords(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["_aRecords", "records", "_aData", "data", "_aItems"]) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
  }
  return [];
}

function htmlToText(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

interface Props {
  game: GameKey;
  gameModRoot: string;
  onDownloadEvent?: (payload: DownloadEventPayload) => void;
  onGameSelect?: (game: GameKey) => void;
}

export function BrowseTab({ game, gameModRoot, onDownloadEvent, onGameSelect }: Props) {
  const gameConfig = BROWSE_GAME_DATA[game];

  const [activeTypeIdx, setActiveTypeIdx] = useState(0);
  const [categories, setCategories] = useState<GbCategory[]>([]);
  const [catsLoading, setCatsLoading] = useState(false);
  const [activeCatId, setActiveCatId] = useState<number | null>(null);
  const [mods, setMods] = useState<GbMod[]>([]);
  const [modsLoading, setModsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingSearch, setPendingSearch] = useState("");
  const [selectedMod, setSelectedMod] = useState<GbMod | null>(null);
  const [detail, setDetail] = useState<GbDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sort, setSort] = useState("default");
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<GbFile | null>(null);

  const modsTokenRef = useRef(0);
  const catsTokenRef = useRef(0);

  const activeType = gameConfig.types[activeTypeIdx] ?? null;

  // Reset when game changes
  useEffect(() => {
    setActiveTypeIdx(0);
    setSearchQuery("");
    setPendingSearch("");
    setMods([]);
    setSelectedMod(null);
    setDetail(null);
    setActiveCatId(null);
  }, [game]);

  // Load categories when type changes
  useEffect(() => {
    if (!activeType) return;
    const token = ++catsTokenRef.current;
    setCatsLoading(true);
    setCategories([]);

    gbFetch(`Mod/Categories?_idCategoryRow=${activeType.id}&_sSort=a_to_z&_bShowEmpty=true`)
      .then((data) => {
        if (token !== catsTokenRef.current) return;
        const records = normalizeRecords(data);
        const cats = records
          .filter((r) => r._idRow && r._sName)
          .map((r) => ({ id: r._idRow as number, name: r._sName as string }));
        setCategories(cats);
        setActiveCatId(activeType.id);
      })
      .catch(() => {
        if (token !== catsTokenRef.current) return;
        setActiveCatId(activeType.id);
      })
      .finally(() => {
        if (token === catsTokenRef.current) setCatsLoading(false);
      });
  }, [activeType?.id]);

  const loadMods = useCallback(
    async (catId: number | null, pageNum: number, append: boolean, query: string) => {
      if (!activeType) return;
      const token = ++modsTokenRef.current;
      if (!append) setModsLoading(true);
      setBrowseError(null);

      try {
        const sortMap: Record<string, string> = { new: "new", updated: "updated", popular: "hot" };
        const sortParam = sortMap[sort];
        const catToUse = catId ?? activeType.id;

        let endpoint: string;
        if (query.trim()) {
          const encoded = encodeURIComponent(query.trim());
          endpoint = `Util/Search/Results?_sModelName=Mod&_sOrder=best_match&_idGameRow=${gameConfig.gameId}&_sSearchString=${encoded}&_nPage=${pageNum}`;
        } else {
          endpoint = `Mod/Index?_nPerpage=15&_aFilters[Generic_Category]=${catToUse}&_nPage=${pageNum}${sortParam ? `&_sSort=${sortParam}` : ""}`;
        }

        const data = await gbFetch(endpoint);
        if (token !== modsTokenRef.current) return;

        const records = normalizeRecords(data);
        const items = records
          .filter((r) => r._idRow)
          .map((r) => {
            const submitterRaw = r._aSubmitter as Record<string, unknown> | string | undefined;
            const submitter =
              typeof submitterRaw === "object" && submitterRaw
                ? ((submitterRaw._sName as string) ?? "Unknown")
                : ((submitterRaw as string) ?? "Unknown");
            return {
              id: r._idRow as number,
              name: (r._sName as string) || "Unnamed Mod",
              profile: (r._sProfileUrl as string) || `https://gamebanana.com/mods/${r._idRow as number}`,
              preview: extractPreviewUrl(r),
              submitter,
              summary: htmlToText(r._sText as string | undefined),
            };
          });

        if (append) {
          setMods((prev) => [...prev, ...items]);
        } else {
          setMods(items);
        }
        setHasMore(items.length >= 15);
        setPage(pageNum + 1);
      } catch (e) {
        if (token !== modsTokenRef.current) return;
        setBrowseError(String(e));
      } finally {
        if (token === modsTokenRef.current) setModsLoading(false);
      }
    },
    [activeType?.id, gameConfig.gameId, sort],
  );

  // Reload on category/sort/type change
  useEffect(() => {
    if (activeCatId === null) return;
    setMods([]);
    setSelectedMod(null);
    setDetail(null);
    setPage(1);
    void loadMods(activeCatId, 1, false, searchQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCatId, sort, activeType?.id, game]);

  // Load mod detail when selection changes
  useEffect(() => {
    if (!selectedMod) {
      setDetail(null);
      setSelectedFile(null);
      return;
    }
    setDetailLoading(true);
    setDetail(null);
    setSelectedFile(null);
    setDownloadError(null);

    gbFetch(`Mod/${selectedMod.id}/ProfilePage`)
      .then((data) => {
        const rec = data as Record<string, unknown>;
        const filesRaw = rec._aFiles as
          | Record<string, unknown>[]
          | Record<string, Record<string, unknown>>
          | undefined;
        const rawList = Array.isArray(filesRaw) ? filesRaw : filesRaw ? Object.values(filesRaw) : [];
        const files: GbFile[] = (rawList as Record<string, unknown>[])
          .filter((f) => f._sDownloadUrl ?? f._sUrl)
          .map((f) => {
            let url = ((f._sDownloadUrl as string) || (f._sUrl as string) || "").trim();
            if (url.startsWith("/")) url = `https://gamebanana.com${url}`;
            return {
              id: (f._idRow as number) || 0,
              name: (f._sFile as string) || (f._sName as string) || "download",
              size: (f._nFilesize as number) || 0,
              url,
            };
          });
        setDetail({ description: htmlToText(rec._sText as string | undefined), files });
      })
      .catch(() => {
        setDetail({ description: selectedMod.summary, files: [] });
      })
      .finally(() => setDetailLoading(false));
  }, [selectedMod?.id]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeCatId]);

  async function handleOpenUrl(url: string) {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  }

  function handleSearch() {
    setSearchQuery(pendingSearch);
    setMods([]);
    setSelectedMod(null);
    void loadMods(activeCatId, 1, false, pendingSearch);
  }

  async function pickInstallDestination(): Promise<string | null> {
    let picked: string | string[] | null = null;

    try {
      picked = await open({
        directory: true,
        multiple: false,
        defaultPath: gameModRoot || undefined,
        title: "Select install destination folder",
      });
    } catch {
      // Retry without default path if the configured root is invalid for the dialog provider.
      picked = await open({
        directory: true,
        multiple: false,
        title: "Select install destination folder",
      });
    }

    if (!picked) {
      return null;
    }

    return Array.isArray(picked) ? picked[0] ?? null : picked;
  }

  async function handleDirectInstall(file: GbFile) {
    if (!selectedMod) return;

    let destination: string | null = null;
    try {
      destination = await pickInstallDestination();
    } catch (err) {
      setDownloadError(`Folder picker failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!destination) return;

    const requestId = `${Date.now()}-${file.id}`;
    onDownloadEvent?.({
      kind: "start",
      id: requestId,
      modName: selectedMod.name,
      fileName: file.name,
      destinationPath: destination,
    });

    setDownloading(true);
    setDownloadError(null);
    setSelectedFile(file);
    try {
      const result = await invoke<DownloadInstallResult>("download_and_install_mod", {
        url: file.url,
        destItemPath: destination,
        modName: selectedMod.name,
        previewUrl: selectedMod.preview,
      });

      onDownloadEvent?.({
        kind: "success",
        id: requestId,
        modName: selectedMod.name,
        fileName: file.name,
        destinationPath: result.destination_path,
        installedPath: result.installed_path,
        previewPath: result.preview_path,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDownloadError(message);
      onDownloadEvent?.({
        kind: "error",
        id: requestId,
        modName: selectedMod.name,
        fileName: file.name,
        destinationPath: destination,
        message,
      });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_400px] lg:items-start">
      {/* Left: type + category */}
      <aside className="self-start rounded-[28px] border border-white/10 bg-slate-950/50 p-5 lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)] lg:overflow-y-auto">
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.28em] text-slate-400">Active Game</span>
          <select
            value={game}
            onChange={(event) => {
              onGameSelect?.(event.currentTarget.value as GameKey);
            }}
            className="mt-3 w-full rounded-xl border border-white/10 bg-white px-3 py-2 text-sm text-slate-900"
          >
            {GAME_ORDER.map((gameId) => (
              <option key={gameId} value={gameId}>{GAMES[gameId].name}</option>
            ))}
          </select>
        </label>

        <p className="mt-5 text-[10px] uppercase tracking-[0.28em] text-slate-400">Type</p>
        <div className="mt-3 space-y-1">
          {gameConfig.types.map((t, idx) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setActiveTypeIdx(idx);
                setPendingSearch("");
                setSearchQuery("");
                setMods([]);
                setSelectedMod(null);
                setActiveCatId(null);
              }}
              className={clsx(
                "w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/8",
                activeTypeIdx === idx ? "bg-white/10 text-white" : "text-slate-300",
              )}
            >
              {t.name}
            </button>
          ))}
        </div>

        <p className="mt-5 text-[10px] uppercase tracking-[0.28em] text-slate-400">Categories</p>
        <div className="mt-3 max-h-[38vh] space-y-1 overflow-y-auto pr-1">
          {catsLoading ? (
            <p className="text-xs text-slate-400">Loading…</p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setActiveCatId(activeType?.id ?? null);
                }}
                className={clsx(
                  "w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/8",
                  activeCatId === activeType?.id ? "bg-white/10 text-white" : "text-slate-300",
                )}
              >
                All {activeType?.name}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                    setActiveCatId(cat.id);
                  }}
                  className={clsx(
                    "w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/8",
                    activeCatId === cat.id ? "bg-white/10 text-white" : "text-slate-300",
                  )}
                >
                  {cat.name}
                </button>
              ))}
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            void handleOpenUrl(GAMEBANANA_URLS[game]);
          }}
          className="mt-5 w-full rounded-xl border border-white/10 py-2 text-xs text-slate-300 transition hover:bg-white/8"
        >
          Open GB Website ↗
        </button>
        {RABBITFX_URLS[game] ? (
          <button
            type="button"
            onClick={() => {
              void handleOpenUrl(RABBITFX_URLS[game]!);
            }}
            className="mt-2 w-full rounded-xl border border-white/10 py-2 text-xs text-slate-300 transition hover:bg-white/8"
          >
            RabbitFX ↗
          </button>
        ) : null}
      </aside>

      {/* Center: mod cards */}
      <section className="rounded-[28px] border border-white/10 bg-slate-950/50 p-5">
        <div className="mb-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-slate-300">
          GameBanana API view: some logged-in-only or age-gated website results may not appear here.
        </div>
        <div className="flex items-center gap-3">
          <input
            value={pendingSearch}
            onChange={(e) => {
              setPendingSearch(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            placeholder="Search GameBanana mods…"
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white"
          />
          <button
            type="button"
            onClick={handleSearch}
            className="shrink-0 rounded-full border border-white/10 bg-white px-3 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-100"
          >
            Search
          </button>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.currentTarget.value);
            }}
            className="shrink-0 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white"
          >
            <option value="default">Default</option>
            <option value="new">Newest</option>
            <option value="updated">Updated</option>
            <option value="popular">Popular</option>
          </select>
        </div>

        {browseError ? (
          <p className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-400/10 p-3 text-sm text-rose-100">
            {browseError}
          </p>
        ) : null}

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3">
          {modsLoading && mods.length === 0 ? (
            <p className="col-span-full text-sm text-slate-400">Loading mods…</p>
          ) : mods.length === 0 ? (
            <p className="col-span-full text-sm text-slate-400">No mods found for this category.</p>
          ) : (
            mods.map((mod) => (
              <button
                key={mod.id}
                type="button"
                onClick={() => {
                  setSelectedMod(mod);
                }}
                className={clsx(
                  "rounded-2xl border p-3 text-left transition hover:border-white/25",
                  selectedMod?.id === mod.id ? "border-white/25 bg-white/10" : "border-white/8 bg-white/4",
                )}
              >
                {mod.preview ? (
                  <img
                    src={mod.preview}
                    alt={mod.name}
                    className="mb-3 aspect-[4/3] w-full rounded-xl object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="mb-3 aspect-[4/3] w-full rounded-xl bg-slate-800/50" />
                )}
                <p className="truncate text-sm font-medium text-white">{mod.name}</p>
                <p className="mt-1 text-xs text-slate-400">by {mod.submitter}</p>
              </button>
            ))
          )}
        </div>

        {hasMore ? (
          <button
            type="button"
            onClick={() => {
              void loadMods(activeCatId, page, true, searchQuery);
            }}
            disabled={modsLoading}
            className="mt-4 w-full rounded-full border border-white/10 py-2 text-sm text-slate-300 transition hover:bg-white/8 disabled:cursor-wait disabled:opacity-70"
          >
            {modsLoading ? "Loading…" : "Load More"}
          </button>
        ) : null}
      </section>

      {/* Right: detail + install */}
      <aside className="self-start rounded-[28px] border border-white/10 bg-slate-950/50 p-5 lg:sticky lg:top-4 lg:h-[78vh] lg:overflow-hidden">
        {selectedMod ? (
          <div className="h-full lg:flex lg:flex-col">
            {selectedMod.preview ? (
              <img
                src={selectedMod.preview}
                alt={selectedMod.name}
                className="mb-4 aspect-[16/10] w-full rounded-2xl object-cover"
              />
            ) : (
              <div className="mb-4 aspect-[16/10] w-full rounded-2xl bg-slate-800/50" />
            )}

            <p className="text-base font-semibold text-white">{selectedMod.name}</p>
            <p className="mt-1 text-xs text-slate-400">by {selectedMod.submitter}</p>

            <button
              type="button"
              onClick={() => {
                void handleOpenUrl(selectedMod.profile);
              }}
              className="mt-3 w-full rounded-full border border-white/10 py-2 text-sm text-slate-200 transition hover:bg-white/8"
            >
              Open Mod Page ↗
            </button>

            <div className="mt-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
              <div className="rounded-2xl border border-white/8 bg-white/4 p-3 text-sm leading-6 text-slate-300/85">
                {detailLoading ? "Loading…" : (detail?.description || selectedMod.summary || "No description.")}
              </div>

              <p className="mt-4 text-[10px] uppercase tracking-[0.2em] text-slate-400">Download Files</p>
              <div className="mt-2 max-h-44 space-y-2 overflow-y-auto">
                {detailLoading ? (
                  <p className="text-xs text-slate-400">Loading files…</p>
                ) : detail?.files.length ? (
                  detail.files.map((file) => (
                    <div
                      key={file.id}
                      className={clsx(
                        "rounded-2xl border p-3 transition",
                        selectedFile?.id === file.id ? "border-white/25 bg-white/10" : "border-white/8 bg-white/4",
                      )}
                    >
                      <p className="truncate text-xs font-medium text-white">{file.name}</p>
                      {file.size > 0 ? (
                        <p className="mt-0.5 text-[10px] text-slate-400">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                      ) : null}
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            void handleOpenUrl(file.url);
                          }}
                          className="flex-1 rounded-full border border-white/10 py-1 text-xs text-slate-200 transition hover:bg-white/8"
                        >
                          Download ↗
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void handleDirectInstall(file);
                          }}
                          disabled={downloading}
                          className="flex-1 rounded-full border border-white/10 bg-white py-1 text-xs font-medium text-slate-950 transition hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-60"
                        >
                          {downloading && selectedFile?.id === file.id ? "Installing…" : "Install"}
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-400">No direct files. Open the mod page to download.</p>
                )}
              </div>
            </div>

            {downloadError ? (
              <p className="mt-2 rounded-2xl border border-rose-300/20 bg-rose-400/10 p-2 text-[11px] leading-5 text-rose-100">
                {downloadError}
              </p>
            ) : null}

            {/* Install actions are handled directly per file above. */}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-slate-400">Select a mod to see details.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
