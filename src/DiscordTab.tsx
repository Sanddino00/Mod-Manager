import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import type { DownloadEventPayload } from "./BrowseTab";

const DISCORD_WEBVIEW_LABEL = "discord-browser-view";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = {
  rememberWebSessions?: boolean;
  gameModRoot: string;
  onDownloadEvent?: (payload: DownloadEventPayload) => void;
};

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

// Discord is embedded like a real browser tab (via Rust, not the JS Webview API) so its own
// `on_download` hook can capture attachment downloads into the managed folder. Any second-tab
// link Discord tries to open is handed off to the user's real default browser instead.
export function DiscordTab({ rememberWebSessions = true, gameModRoot, onDownloadEvent }: Props) {
  const [browserUrl, setBrowserUrl] = useState("https://discord.com/app");
  const [addressInput, setAddressInput] = useState("https://discord.com/app");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [webviewReady, setWebviewReady] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [localInstallStatus, setLocalInstallStatus] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [installingLocalArchive, setInstallingLocalArchive] = useState(false);
  const [downloadsFolder, setDownloadsFolder] = useState<string>("C:/Users/Public/Downloads");
  const [profileId] = useState(() => `discord-profile-temp-${Date.now()}-${Math.floor(Math.random() * 10000)}`);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<Webview | null>(null);
  const canUseNativeWebview = isTauriRuntime();

  useEffect(() => {
    void invoke<string>("get_default_downloads_folder")
      .then((path) => {
        if (path.trim()) {
          setDownloadsFolder(path);
        }
      })
      .catch(() => {});
  }, []);

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

  const pickDownloadFolder = useCallback(async (): Promise<string | null> => {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: downloadsFolder || undefined,
      title: "Select Discord download folder",
    });

    if (!picked) {
      return null;
    }

    return Array.isArray(picked) ? picked[0] ?? null : picked;
  }, [downloadsFolder]);

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
      source: "discord",
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
        source: "discord",
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
        source: "discord",
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

  const runWebviewScript = useCallback(async (script: string) => {
    if (!canUseNativeWebview) {
      return;
    }

    await invoke("webview_eval", {
      label: DISCORD_WEBVIEW_LABEL,
      script,
    });
  }, [canUseNativeWebview]);

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

      const existing = await Webview.getByLabel(DISCORD_WEBVIEW_LABEL).catch(() => null);

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
            label: DISCORD_WEBVIEW_LABEL,
            url: browserUrl,
            source: "discord",
            downloadsFolder,
            dataDirectory: rememberWebSessions ? "discord-profile" : profileId,
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

        webview = await Webview.getByLabel(DISCORD_WEBVIEW_LABEL).catch(() => null);
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

      const oldCleanup = (webview as unknown as { __discordCleanup?: () => void }).__discordCleanup;
      if (oldCleanup) {
        oldCleanup();
      }
      (webview as unknown as { __discordCleanup?: () => void }).__discordCleanup = cleanup;
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
        const cleanup = (current as unknown as { __discordCleanup?: () => void }).__discordCleanup;
        if (cleanup) {
          cleanup();
        }
        // Always close on unmount instead of hiding off-screen: leaving it "hidden" could
        // still bleed through as a stray strip when switching tabs. The persistent profile
        // folder (dataDirectory) keeps the login session even after the webview is closed.
        void current.close().catch(() => {});
      }

      void Webview.getByLabel(DISCORD_WEBVIEW_LABEL)
        .then((view) => view?.close().catch(() => {}))
        .catch(() => {});
    };
  }, [browserUrl, canUseNativeWebview, downloadsFolder, profileId, rememberWebSessions, syncWebviewBounds]);

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
      if (disposed || event.payload.source !== "discord") {
        return;
      }
      const fileName = event.payload.fileName || deriveNameFromUrl(event.payload.url, "download");
      setDownloading(true);
      setDownloadError(null);
      setLocalInstallStatus(null);
      onDownloadEvent?.({
        kind: "start",
        source: "discord",
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
      if (disposed || event.payload.source !== "discord") {
        return;
      }
      const fileName = event.payload.fileName || deriveNameFromUrl(event.payload.url, "download");
      const requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      setDownloading(false);

      if (event.payload.success && event.payload.path) {
        setLocalInstallStatus(`Downloaded ${fileName} to ${downloadsFolder}.`);
        onDownloadEvent?.({
          kind: "success",
          source: "discord",
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
          source: "discord",
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

  return (
    <section className="mt-4 rounded-[28px] border border-white/10 bg-slate-950/40 p-6 shadow-[0_20px_80px_rgba(2,6,23,0.35)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Discord</p>
          <h2 className="mt-2 text-xl font-semibold text-white">Native In-App Browser</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
              void (async () => {
                const picked = await pickDownloadFolder();
                if (picked) {
                  setDownloadsFolder(picked);
                }
              })();
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
          >
            Download Folder
          </button>
          <button
            type="button"
            onClick={() => {
              setBrowserUrl("https://discord.com/app");
              setAddressInput("https://discord.com/app");
            }}
            className="inline-flex items-center gap-2 rounded-full border border-cyan-300/35 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25"
          >
            Load Discord
          </button>
          <button
            type="button"
            onClick={() => {
              void openUrl(addressInput || browserUrl);
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
          >
            <ExternalLink className="h-4 w-4" />
            Open in browser
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={addressInput}
          onChange={(event) => {
            setAddressInput(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              setBrowserUrl(addressInput.trim() || "https://discord.com/app");
            }
          }}
          placeholder="https://discord.com/app"
          className="min-w-[220px] flex-1 rounded-full border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-100"
        />
        <button
          type="button"
          onClick={() => {
            if (webviewRef.current) {
              void runWebviewScript("history.back();").catch(() => {});
            }
          }}
          className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            if (webviewRef.current) {
              void runWebviewScript("history.forward();").catch(() => {});
            }
          }}
          className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
        >
          Forward
        </button>
        <button
          type="button"
          onClick={() => {
            setBrowserUrl(addressInput.trim() || "https://discord.com/app");
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
        <div ref={panelRef} className="relative h-[72dvh] overflow-hidden rounded-xl border border-white/10 bg-slate-950/80">
          {!canUseNativeWebview ? (
            <iframe
              key={`${browserUrl}-${refreshNonce}`}
              src={browserUrl}
              title="Discord Browser Fallback"
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

      {nativeError ? <p className="mt-2 text-xs text-amber-200/90">Native webview error: {nativeError}</p> : null}
      {downloading ? <p className="mt-2 text-xs text-cyan-100/90">Downloading...</p> : null}
      {downloadError ? <p className="mt-2 text-xs text-rose-200/90">Download failed: {downloadError}</p> : null}
      {localInstallStatus ? <p className="mt-2 text-xs text-emerald-200/90">{localInstallStatus}</p> : null}
      <p className="mt-2 text-xs text-slate-300/85">
        Downloads inside Discord land in your download folder automatically. Any link Discord tries to
        open in a new tab opens in your real browser instead (needed for logins/CDN sessions).
      </p>
    </section>
  );
}

