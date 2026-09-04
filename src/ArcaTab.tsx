import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import { ChevronDown, Download, ExternalLink, KeyRound, Link2, RefreshCw } from "lucide-react";
import { ARCA_GAMES, ARCA_URLS, GAMES, type ArcaGameKey } from "./config/games";
import type { DownloadEventPayload } from "./BrowseTab";

type ChannelMode = "normal" | "r18";

const ARCA_WEBVIEW_LABEL = "arca-browser-view";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type DownloadInstallResult = {
  installed_path: string;
  destination_path: string;
  preview_path: string | null;
};

type NativeDownloadEventPayload = {
  source: "discord" | "arca";
  url: string;
  fileName?: string | null;
  path?: string | null;
  success?: boolean;
};

interface Props {
  gameModRoot: string;
  rememberWebSessions?: boolean;
  enableLoginHelperHints?: boolean;
  enableAdBlocker?: boolean;
  savedUsername?: string;
  savedPassword?: string;
  onDownloadEvent?: (payload: DownloadEventPayload) => void;
}

function decodeMaybeBase64(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const compact = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    return trimmed;
  }

  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    const decoded = atob(withPadding);
    const cleaned = decoded.trim();
    return cleaned || trimmed;
  } catch {
    return trimmed;
  }
}

function buildPasswordHints(game: ArcaGameKey): string[] {
  if (game === "wuwa") {
    return ["Eldwh"];
  }

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dateCompact = `${yyyy}${mm}${dd}`;
  const dateDashed = `${yyyy}-${mm}-${dd}`;

  return [
    "gayshin",
    "gayshin!",
    "gayshin@",
    "@gayshin",
    "gayshingayshin",
    "ㅎ묘노ㅑㅜ",
    `ㅎ묘노ㅑㅜ${dateCompact}`,
    `ㅎ묘노ㅑㅜ${dateDashed}`,
    "Gayshin",
    "gayshin카카바샤",
    "gayshin힐끔",
  ];
}

function deriveNameFromUrl(url: string, fallback = "download"): string {
  try {
    const parsed = new URL(url);
    const file = decodeURIComponent(parsed.pathname.split("/").pop() || "").trim();
    return file || fallback;
  } catch {
    return fallback;
  }
}

function deriveModName(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]{1,8}$/u, "").trim() || "Imported Mod";
}

// Arca is embedded like a real browser tab (like the GameBanana tab), so normal in-site
// navigation and links work. Downloads are captured natively into the managed folder; any
// second-tab/cloud-storage link is handed off to the user's real default browser (needed for
// its own login/session).
export function ArcaTab({
  gameModRoot,
  rememberWebSessions = true,
  enableLoginHelperHints = true,
  savedUsername = "",
  savedPassword = "",
  onDownloadEvent,
}: Props) {
  const [selectedGame, setSelectedGame] = useState<ArcaGameKey>("gi");
  const [channel, setChannel] = useState<ChannelMode>("normal");
  const [encodedLink, setEncodedLink] = useState("");
  const [decodedLink, setDecodedLink] = useState("");
  const [browserUrl, setBrowserUrl] = useState(ARCA_URLS.gi.normal);
  const [addressInput, setAddressInput] = useState(ARCA_URLS.gi.normal);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [webviewReady, setWebviewReady] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [localInstallStatus, setLocalInstallStatus] = useState<string | null>(null);
  const [autofillStatus, setAutofillStatus] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [installingLocalArchive, setInstallingLocalArchive] = useState(false);
  const [downloadsFolder, setDownloadsFolder] = useState<string>("C:/Users/Public/Downloads");
  const [sessionProfileId] = useState(() => `arca-profile-temp-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<Webview | null>(null);

  const activeArcaUrl = ARCA_URLS[selectedGame][channel];
  const passwordHints = useMemo(() => buildPasswordHints(selectedGame), [selectedGame]);
  const canUseNativeWebview = isTauriRuntime();

  const pickInstallDestination = useCallback(async (): Promise<string | null> => {
    let picked: string | string[] | null = null;

    try {
      picked = await open({
        directory: true,
        multiple: false,
        defaultPath: gameModRoot || undefined,
        title: "Select install destination folder",
      });
    } catch {
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
  }, [gameModRoot]);

  const pickOptionalPreviewImage = useCallback(async (): Promise<string | null> => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Optional: Select preview image (Cancel to skip)",
      defaultPath: downloadsFolder,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
    });

    if (!picked) {
      return null;
    }

    return Array.isArray(picked) ? picked[0] ?? null : picked;
  }, [downloadsFolder]);

  useEffect(() => {
    setAddressInput(activeArcaUrl);
    setBrowserUrl(activeArcaUrl);
    setNativeError(null);
  }, [activeArcaUrl]);

  useEffect(() => {
    void invoke<string>("get_default_downloads_folder")
      .then((path) => {
        if (path.trim()) {
          setDownloadsFolder(path);
        }
      })
      .catch(() => {});
  }, []);

  const handleInstallDownloadedArchive = useCallback(async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Select downloaded archive",
      defaultPath: downloadsFolder,
      filters: [{ name: "Archives", extensions: ["zip", "7z", "rar"] }],
    });

    if (!picked) {
      return;
    }

    const archivePath = Array.isArray(picked) ? (picked[0] ?? "") : picked;
    if (!archivePath) {
      return;
    }

    const destination = await pickInstallDestination();
    if (!destination) {
      return;
    }
    const previewImage = await pickOptionalPreviewImage();

    const fileName = archivePath.split(/[\\/]/).pop()?.trim() || "download.zip";
    const modName = deriveModName(fileName);
    const requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    onDownloadEvent?.({
      kind: "start",
      source: "arca",
      id: requestId,
      modName,
      fileName,
      destinationPath: destination,
    });

    setInstallingLocalArchive(true);
    setDownloadError(null);
    setLocalInstallStatus(null);

    try {
      const result = await invoke<DownloadInstallResult>("install_local_archive_mod", {
        archivePath,
        destItemPath: destination,
        modName,
        previewUrl: previewImage,
      });

      onDownloadEvent?.({
        kind: "success",
        source: "arca",
        id: requestId,
        modName,
        fileName,
        destinationPath: result.destination_path,
        installedPath: result.installed_path,
        previewPath: result.preview_path,
      });

      setLocalInstallStatus(`Installed ${fileName} from local download.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDownloadError(message);
      onDownloadEvent?.({
        kind: "error",
        source: "arca",
        id: requestId,
        modName,
        fileName,
        destinationPath: destination,
        message,
      });
    } finally {
      setInstallingLocalArchive(false);
    }
  }, [downloadsFolder, onDownloadEvent, pickInstallDestination, pickOptionalPreviewImage]);

  const runWebviewScript = useCallback(
    async (script: string) => {
      if (!canUseNativeWebview) {
        return;
      }

      await invoke("webview_eval", {
        label: ARCA_WEBVIEW_LABEL,
        script,
      });
    },
    [canUseNativeWebview],
  );

  const syncWebviewBounds = useCallback(async (webview: Webview) => {
    const host = panelRef.current;
    if (!host) {
      return;
    }

    const rect = host.getBoundingClientRect();
    const x = Math.max(0, Math.round(rect.left));
    const y = Math.max(0, Math.round(rect.top));
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(260, Math.round(rect.height));

    await Promise.all([
      webview.setPosition(new LogicalPosition(x, y)),
      webview.setSize(new LogicalSize(width, height)),
    ]);
  }, []);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    async function mountNativeWebview() {
      if (!canUseNativeWebview) {
        setWebviewReady(false);
        return;
      }

      const host = panelRef.current;
      if (!host) {
        return;
      }

      setWebviewReady(false);
      setNativeError(null);

      const existing = await Webview.getByLabel(ARCA_WEBVIEW_LABEL).catch(() => null);
      if (disposed) {
        return;
      }

      const rect = host.getBoundingClientRect();
      const width = Math.max(320, Math.round(rect.width));
      const height = Math.max(260, Math.round(rect.height));
      const x = Math.max(0, Math.round(rect.left));
      const y = Math.max(0, Math.round(rect.top));

      let webview = existing;

      if (!webview) {
        try {
          await invoke("create_managed_browser_webview", {
            windowLabel: "main",
            label: ARCA_WEBVIEW_LABEL,
            url: browserUrl,
            source: "arca",
            downloadsFolder,
            dataDirectory: rememberWebSessions ? "arca-profile" : sessionProfileId,
            x,
            y,
            width,
            height,
          });
        } catch (err) {
          if (!disposed) {
            setWebviewReady(false);
            setNativeError(err instanceof Error ? err.message : String(err));
          }
          return;
        }

        if (disposed) {
          return;
        }

        webview = await Webview.getByLabel(ARCA_WEBVIEW_LABEL).catch(() => null);
      }

      if (disposed || !webview) {
        return;
      }

      webviewRef.current = webview;
      setWebviewReady(true);
      void syncWebviewBounds(webview).catch(() => {});

      const sync = () => {
        if (!disposed && webviewRef.current) {
          void syncWebviewBounds(webviewRef.current).catch(() => {});
        }
      };

      const onWindowMove = () => {
        sync();
      };

      window.addEventListener("resize", onWindowMove);
      window.addEventListener("scroll", onWindowMove, { passive: true });

      resizeObserver = new ResizeObserver(() => {
        sync();
      });
      resizeObserver.observe(host);

      void syncWebviewBounds(webview).catch(() => {});

      const cleanup = () => {
        window.removeEventListener("resize", onWindowMove);
        window.removeEventListener("scroll", onWindowMove);
      };

      const oldCleanup = (webview as unknown as { __arcaCleanup?: () => void }).__arcaCleanup;
      if (oldCleanup) {
        oldCleanup();
      }
      (webview as unknown as { __arcaCleanup?: () => void }).__arcaCleanup = cleanup;
    }

    void mountNativeWebview();

    return () => {
      disposed = true;
      setWebviewReady(false);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }

      const current = webviewRef.current;
      webviewRef.current = null;
      if (current) {
        const cleanup = (current as unknown as { __arcaCleanup?: () => void }).__arcaCleanup;
        if (cleanup) {
          cleanup();
        }
        // Always close on unmount instead of hiding off-screen: leaving it "hidden" could
        // still bleed through as a stray strip when switching tabs. The persistent profile
        // folder (dataDirectory) keeps the login session even after the webview is closed.
        void current.close().catch(() => {});
      }

      void Webview.getByLabel(ARCA_WEBVIEW_LABEL)
        .then((view) => view?.close().catch(() => {}))
        .catch(() => {});
    };
  }, [browserUrl, canUseNativeWebview, downloadsFolder, rememberWebSessions, sessionProfileId, syncWebviewBounds]);

  useEffect(() => {
    if (!canUseNativeWebview || !webviewRef.current) {
      return;
    }

    const escaped = JSON.stringify(browserUrl);
    void runWebviewScript(`window.location.href = ${escaped};`).catch((err) => {
      setNativeError(err instanceof Error ? err.message : String(err));
    });
  }, [browserUrl, canUseNativeWebview, runWebviewScript]);

  useEffect(() => {
    if (!canUseNativeWebview || !webviewRef.current || refreshNonce === 0) {
      return;
    }

    void runWebviewScript("window.location.reload();").catch((err) => {
      setNativeError(err instanceof Error ? err.message : String(err));
    });
  }, [refreshNonce, canUseNativeWebview, runWebviewScript]);

  useEffect(() => {
    let disposed = false;
    let unlistenStarted: (() => void) | null = null;
    let unlistenFinished: (() => void) | null = null;

    void listen<NativeDownloadEventPayload>("mod-manager-web-download-started", (event) => {
      if (disposed || event.payload.source !== "arca") {
        return;
      }
      const fileName = event.payload.fileName || deriveNameFromUrl(event.payload.url, "download");
      setDownloading(true);
      setDownloadError(null);
      setLocalInstallStatus(null);
      onDownloadEvent?.({
        kind: "start",
        source: "arca",
        id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        modName: deriveModName(fileName),
        fileName,
        destinationPath: downloadsFolder,
      });
    }).then((fn) => {
      if (disposed) {
        void fn();
        return;
      }
      unlistenStarted = fn;
    });

    void listen<NativeDownloadEventPayload>("mod-manager-web-download-finished", (event) => {
      if (disposed || event.payload.source !== "arca") {
        return;
      }
      const fileName = event.payload.fileName || deriveNameFromUrl(event.payload.url, "download");
      const requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      setDownloading(false);

      if (event.payload.success && event.payload.path) {
        setLocalInstallStatus(`Downloaded ${fileName} to ${downloadsFolder}.`);
        onDownloadEvent?.({
          kind: "success",
          source: "arca",
          id: requestId,
          modName: deriveModName(fileName),
          fileName,
          destinationPath: downloadsFolder,
          installedPath: event.payload.path,
          previewPath: null,
        });
      } else {
        setDownloadError(`Download failed for ${fileName}.`);
        onDownloadEvent?.({
          kind: "error",
          source: "arca",
          id: requestId,
          modName: deriveModName(fileName),
          fileName,
          destinationPath: downloadsFolder,
          message: "Download failed.",
        });
      }
    }).then((fn) => {
      if (disposed) {
        void fn();
        return;
      }
      unlistenFinished = fn;
    });

    return () => {
      disposed = true;
      if (unlistenStarted) {
        void unlistenStarted();
      }
      if (unlistenFinished) {
        void unlistenFinished();
      }
    };
  }, [downloadsFolder, onDownloadEvent]);

  function normalizeUrl(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      return activeArcaUrl;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    return `https://${trimmed}`;
  }

  function loadInPanel(url: string) {
    const normalized = normalizeUrl(url);
    setBrowserUrl(normalized);
    setAddressInput(normalized);
    setNativeError(null);
  }

  function handleBack() {
    if (canUseNativeWebview && webviewRef.current) {
      void runWebviewScript("history.back();").catch((err) => {
        setNativeError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    setRefreshNonce((current) => current + 1);
  }

  function handleForward() {
    if (canUseNativeWebview && webviewRef.current) {
      void runWebviewScript("history.forward();").catch((err) => {
        setNativeError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    setRefreshNonce((current) => current + 1);
  }

  function handleDecode() {
    const next = decodeMaybeBase64(encodedLink);
    setDecodedLink(next);
  }

  async function handleAutofillSavedLogin() {
    const username = savedUsername.trim();
    const password = savedPassword;

    if (!username || !password) {
      setAutofillStatus("Set saved username + password in Settings first.");
      return;
    }

    if (!canUseNativeWebview || !webviewRef.current) {
      setAutofillStatus("Autofill works only in native in-app webview mode.");
      return;
    }

    const script = `(() => {
      const username = ${JSON.stringify(username)};
      const password = ${JSON.stringify(password)};

      const fill = (el, value) => {
        if (!el || typeof el.value === 'undefined') {
          return false;
        }
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };

      const passField = document.querySelector('input[type="password"]');
      const userField = document.querySelector('input[type="email"],input[name*="user" i],input[name*="login" i],input[name*="mail" i],input[id*="user" i],input[id*="login" i],input[id*="mail" i],input[autocomplete="username"],input[type="text"]');

      if (userField) {
        fill(userField, username);
      }
      if (passField) {
        fill(passField, password);
      }
    })();`;

    try {
      await runWebviewScript(script);
      setAutofillStatus("Saved login autofill applied. Submit on the page to sign in.");
    } catch (err) {
      setAutofillStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="mt-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_310px] xl:items-start">
        <article className="rounded-[28px] border border-white/10 bg-slate-950/40 p-6 shadow-[0_20px_80px_rgba(2,6,23,0.35)]">
          <div className="sticky top-24 z-20 rounded-2xl border border-white/10 bg-slate-950/80 p-3 backdrop-blur-md">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Arca Browser</p>
              <h2 className="mt-2 text-xl font-semibold text-white">Native In-App View</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  loadInPanel(activeArcaUrl);
                }}
                className="inline-flex items-center gap-2 rounded-full border border-cyan-300/35 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25"
              >
                Load Selected
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleInstallDownloadedArchive();
                }}
                disabled={installingLocalArchive}
                className="inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-amber-500/18 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/28 disabled:cursor-wait disabled:opacity-70"
              >
                <Download className="h-4 w-4" />
                {installingLocalArchive ? "Installing..." : "Install Downloaded File"}
              </button>
              <button
                type="button"
                onClick={() => {
                  void openUrl(addressInput || activeArcaUrl);
                }}
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
              >
                <ExternalLink className="h-4 w-4" />
                Open External
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleAutofillSavedLogin();
                }}
                className="inline-flex items-center gap-2 rounded-full border border-indigo-300/35 bg-indigo-500/20 px-4 py-2 text-sm font-medium text-indigo-100 transition hover:bg-indigo-500/30"
              >
                <KeyRound className="h-4 w-4" />
                Autofill Saved Login
              </button>
            </div>
          </div>

          <p className="mt-2 text-xs text-slate-300/85">
            Saved account: {savedUsername.trim() || "none"}
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Game</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {ARCA_GAMES.map((game) => {
                  const selected = selectedGame === game;
                  return (
                    <button
                      key={game}
                      type="button"
                      onClick={() => {
                        setSelectedGame(game);
                      }}
                      className={clsx(
                        "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                        selected
                          ? "border-cyan-300/45 bg-cyan-400/20 text-cyan-100"
                          : "border-white/10 bg-white/4 text-slate-300 hover:bg-white/8",
                      )}
                    >
                      {GAMES[game].shortLabel}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Channel</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(["normal", "r18"] as const).map((mode) => {
                  const selected = channel === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setChannel(mode);
                      }}
                      className={clsx(
                        "rounded-full border px-3 py-1.5 text-xs font-medium uppercase transition",
                        selected
                          ? "border-amber-300/45 bg-amber-400/20 text-amber-100"
                          : "border-white/10 bg-white/4 text-slate-300 hover:bg-white/8",
                      )}
                    >
                      {mode}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="sticky top-[7.4rem] z-20 mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/80 p-2 backdrop-blur-md">
            <input
              value={addressInput}
              onChange={(event) => {
                setAddressInput(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  loadInPanel(addressInput);
                }
              }}
              placeholder="https://arca.live/..."
              className="min-w-[220px] flex-1 rounded-full border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-100"
            />
            <button
              type="button"
              onClick={handleBack}
              className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
            >
              Back
            </button>
            <button
              type="button"
              onClick={handleForward}
              className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
            >
              Forward
            </button>
            <button
              type="button"
              onClick={() => {
                loadInPanel(addressInput);
              }}
              className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
            >
              Go
            </button>
            <button
              type="button"
              onClick={() => {
                setRefreshNonce((current) => current + 1);
              }}
              className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </button>
          </div>

          <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950 p-2">
            <div
              ref={panelRef}
              className="relative h-[68dvh] overflow-hidden rounded-xl border border-white/10 bg-slate-950/80"
            >
              {!canUseNativeWebview ? (
                <iframe
                  key={`${browserUrl}-${refreshNonce}`}
                  src={browserUrl}
                  title="Arca Browser Fallback"
                  className="h-full w-full"
                  referrerPolicy="no-referrer"
                />
              ) : null}
              {canUseNativeWebview && !webviewReady ? (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/85 text-xs text-slate-300">
                  Loading in-app webview...
                </div>
              ) : null}
            </div>
          </div>

          {nativeError ? (
            <p className="mt-2 text-xs text-amber-200/90">
              Native webview error: {nativeError}
            </p>
          ) : null}
          {downloading ? (
            <p className="mt-2 text-xs text-cyan-100/90">Downloading...</p>
          ) : null}
          {downloadError ? (
            <p className="mt-2 text-xs text-rose-200/90">Download failed: {downloadError}</p>
          ) : null}
          {autofillStatus ? (
            <p className="mt-2 text-xs text-indigo-100/90">{autofillStatus}</p>
          ) : null}
          {localInstallStatus ? (
            <p className="mt-2 text-xs text-emerald-200/90">{localInstallStatus}</p>
          ) : null}
        </article>

        <aside className="space-y-4 xl:sticky xl:top-4">
          <article className="rounded-[20px] border border-white/10 bg-slate-950/35 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Selected URL</p>
            <p className="mt-2 break-all font-mono text-xs text-slate-200">{activeArcaUrl}</p>
          </article>

          <details className="rounded-[20px] border border-white/10 bg-slate-950/35 p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs uppercase tracking-[0.2em] text-slate-300">
              <span className="inline-flex items-center gap-2">
                <Link2 className="h-4 w-4" />
                Base64 Decoder
              </span>
              <ChevronDown className="h-4 w-4" />
            </summary>
            <p className="mt-3 text-sm text-slate-300/85">
              Paste an encoded link, decode it, then open it in the panel.
            </p>

            <textarea
              value={encodedLink}
              onChange={(event) => {
                setEncodedLink(event.currentTarget.value);
              }}
              placeholder="aHR0cHM6Ly9uYWhpZGEubGl2ZS9ha2FzaGEvbW9kL3Q3eUxtU2VhMjhtaDNaTWtMaTVxdQ=="
              className="mt-4 min-h-24 w-full rounded-2xl border border-white/10 bg-slate-950/60 p-3 font-mono text-xs text-slate-100"
            />

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleDecode}
                className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm text-white transition hover:bg-white/15"
              >
                Decode
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!decodedLink) {
                    return;
                  }
                  loadInPanel(decodedLink);
                }}
                disabled={!decodedLink}
                className="rounded-full border border-cyan-300/35 bg-cyan-500/15 px-4 py-2 text-sm text-cyan-100 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Open In Panel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!decodedLink) {
                    return;
                  }
                  void openUrl(normalizeUrl(decodedLink));
                }}
                disabled={!decodedLink}
                className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Open in Browser
              </button>
            </div>
          </details>

          {enableLoginHelperHints ? (
          <details className="rounded-[20px] border border-white/10 bg-slate-950/35 p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs uppercase tracking-[0.2em] text-slate-300">
              <span className="inline-flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                Password Hints
              </span>
              <ChevronDown className="h-4 w-4" />
            </summary>
            <div className="mt-4 flex flex-wrap gap-2">
              {passwordHints.map((hint) => (
                <span
                  key={hint}
                  className="rounded-full border border-white/15 bg-white/6 px-3 py-1.5 font-mono text-xs text-slate-200"
                >
                  {hint}
                </span>
              ))}
            </div>
          </details>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

