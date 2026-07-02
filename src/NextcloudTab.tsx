import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { GAME_ORDER, GAMES } from "./config/games";
import type { DownloadEventPayload } from "./BrowseTab";
import type { GameKey } from "./types";

const NEXTCLOUD_WEBVIEW_LABEL = "nextcloud-browser-view";
const NEXTCLOUD_DOWNLOAD_EVENT = "mod-manager-web-download-request";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = {
  game: GameKey;
  gameModRoot: string;
  links: Record<GameKey, string>;
  onDownloadEvent?: (payload: DownloadEventPayload) => void;
  onGameSelect?: (game: GameKey) => void;
};

type DownloadInstallResult = {
  installed_path: string;
  destination_path: string;
  preview_path: string | null;
};

type WebDownloadRequestPayload = {
  source: "nextcloud";
  url: string;
  fileName?: string;
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

function isLikelyDownloadUrl(url: string): boolean {
  return /\bdownload\b|attachment|\/files\//i.test(url) || /\.(zip|7z|rar|pak|exe|dll|txt|msi)(?:$|[?#])/i.test(url);
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function NextcloudTab({ game, gameModRoot, links, onDownloadEvent, onGameSelect }: Props) {
  const [selectedGame, setSelectedGame] = useState<GameKey>(game);
  const [browserUrl, setBrowserUrl] = useState(normalizeUrl(links[game] ?? ""));
  const [addressInput, setAddressInput] = useState(normalizeUrl(links[game] ?? ""));
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [webviewReady, setWebviewReady] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [localInstallStatus, setLocalInstallStatus] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [installingLocalArchive, setInstallingLocalArchive] = useState(false);
  const [downloadsFolder, setDownloadsFolder] = useState<string>("C:/Users/Public/Downloads");

  const panelRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<Webview | null>(null);
  const canUseNativeWebview = isTauriRuntime();

  useEffect(() => {
    setSelectedGame(game);
  }, [game]);

  useEffect(() => {
    const next = normalizeUrl(links[selectedGame] ?? "");
    setAddressInput(next);
    setBrowserUrl(next);
    setNativeError(null);
  }, [links, selectedGame]);

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

  const handleManagedDownload = useCallback(async (url: string, preferredName?: string) => {
    if (!url || !isLikelyDownloadUrl(url)) {
      return;
    }

    const fileName = (preferredName?.trim() || deriveNameFromUrl(url, "download")).trim();
    const modName = deriveModName(fileName);
    const destination = await pickInstallDestination();
    if (!destination) {
      return;
    }
    const previewImage = await pickOptionalPreviewImage();

    const requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    onDownloadEvent?.({
      kind: "start",
      source: "nextcloud",
      id: requestId,
      modName,
      fileName,
      destinationPath: destination,
    });

    setDownloading(true);
    setDownloadError(null);
    setLocalInstallStatus(null);

    try {
      const result = await invoke<DownloadInstallResult>("download_and_install_mod", {
        url,
        destItemPath: destination,
        modName,
        previewUrl: previewImage,
      });

      onDownloadEvent?.({
        kind: "success",
        source: "nextcloud",
        id: requestId,
        modName,
        fileName,
        destinationPath: result.destination_path,
        installedPath: result.installed_path,
        previewPath: result.preview_path,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDownloadError(message);
      onDownloadEvent?.({
        kind: "error",
        source: "nextcloud",
        id: requestId,
        modName,
        fileName,
        destinationPath: destination,
        message,
      });
    } finally {
      setDownloading(false);
    }
  }, [onDownloadEvent, pickInstallDestination, pickOptionalPreviewImage]);

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
    const modName = fileName.replace(/\.[A-Za-z0-9]{1,8}$/u, "").trim() || "Imported Mod";
    const requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    onDownloadEvent?.({
      kind: "start",
      source: "nextcloud",
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
        source: "nextcloud",
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
        source: "nextcloud",
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
        label: NEXTCLOUD_WEBVIEW_LABEL,
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

      const current = webviewRef.current;
      if (current) {
        await current.close().catch(() => {});
        webviewRef.current = null;
      }

      const existing = await Webview.getByLabel(NEXTCLOUD_WEBVIEW_LABEL).catch(() => null);
      if (existing) {
        await existing.close().catch(() => {});
      }

      if (disposed || !browserUrl) {
        return;
      }

      const rect = host.getBoundingClientRect();
      const width = Math.max(320, Math.round(rect.width));
      const height = Math.max(260, Math.round(rect.height));
      const x = Math.max(0, Math.round(rect.left));
      const y = Math.max(0, Math.round(rect.top));

      const webview = new Webview(getCurrentWindow(), NEXTCLOUD_WEBVIEW_LABEL, {
        url: browserUrl,
        x,
        y,
        width,
        height,
        focus: false,
        dataDirectory: "nextcloud-profile",
      });

      webviewRef.current = webview;

      void webview.once("tauri://created", () => {
        if (disposed) {
          return;
        }
        setWebviewReady(true);
        void syncWebviewBounds(webview).catch(() => {});
      });

      void webview.once("tauri://error", (event) => {
        if (disposed) {
          return;
        }
        setWebviewReady(false);
        setNativeError(String(event.payload));
      });

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

      const oldCleanup = (webview as unknown as { __nextcloudCleanup?: () => void }).__nextcloudCleanup;
      if (oldCleanup) {
        oldCleanup();
      }
      (webview as unknown as { __nextcloudCleanup?: () => void }).__nextcloudCleanup = cleanup;
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
        const cleanup = (current as unknown as { __nextcloudCleanup?: () => void }).__nextcloudCleanup;
        if (cleanup) {
          cleanup();
        }
        void current.close().catch(() => {});
      }

      void Webview.getByLabel(NEXTCLOUD_WEBVIEW_LABEL)
        .then((view) => view?.close().catch(() => {}))
        .catch(() => {});
    };
  }, [browserUrl, canUseNativeWebview, syncWebviewBounds]);

  useEffect(() => {
    if (!canUseNativeWebview || !webviewRef.current || !browserUrl) {
      return;
    }

    const escaped = JSON.stringify(browserUrl);
    void runWebviewScript(`window.location.href = ${escaped};`).catch((err) => {
      setNativeError(err instanceof Error ? err.message : String(err));
    });
  }, [browserUrl, canUseNativeWebview, runWebviewScript]);

  useEffect(() => {
    if (!canUseNativeWebview || !webviewRef.current || refreshNonce === 0 || !browserUrl) {
      return;
    }

    void runWebviewScript("window.location.reload();").catch((err) => {
      setNativeError(err instanceof Error ? err.message : String(err));
    });
  }, [refreshNonce, browserUrl, canUseNativeWebview, runWebviewScript]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<WebDownloadRequestPayload>(NEXTCLOUD_DOWNLOAD_EVENT, (event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      if (!payload || payload.source !== "nextcloud") {
        return;
      }
      if (!payload.url) {
        return;
      }
      void handleManagedDownload(payload.url, payload.fileName);
    }).then((fn) => {
      if (disposed) {
        void fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      if (unlisten) {
        void unlisten();
      }
    };
  }, [handleManagedDownload]);

  useEffect(() => {
    if (!canUseNativeWebview || !webviewRef.current || !browserUrl) {
      return;
    }

    const installHookScript = `(() => {
      try {
        if ((window).__modManagerNextcloudDownloadHookInstalled) {
          return;
        }
        (window).__modManagerNextcloudDownloadHookInstalled = true;

        const isDownloadUrl = (url) => /\\bdownload\\b|attachment|\\/files\\//i.test(url) || /\\.(zip|7z|rar|pak|exe|dll|txt|msi)(?:$|[?#])/i.test(url);

        const toAbsoluteUrl = (value) => {
          try {
            return new URL(String(value || ''), window.location.href).href;
          } catch {
            return String(value || '');
          }
        };

        const emitDownload = (href, fileName) => {
          if (!href) {
            return false;
          }
          const absolute = toAbsoluteUrl(href);
          if (!absolute || !isDownloadUrl(absolute)) {
            return false;
          }
          if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
            void window.__TAURI_INTERNALS__.invoke('emit_web_download_request', {
              source: 'nextcloud',
              url: absolute,
              fileName: (fileName || '').trim(),
            }).catch(() => {});
            return true;
          }
          return false;
        };

        const stopEvent = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
          }
        };

        document.addEventListener('click', (event) => {
          const target = event.target;
          const anchor = target && target.closest ? target.closest('a[href], area[href]') : null;
          if (!anchor) {
            return;
          }

          const href = anchor.href || '';
          const explicitDownload = anchor.hasAttribute('download');
          if (!href || (!explicitDownload && !isDownloadUrl(href))) {
            return;
          }

          stopEvent(event);
          const fileName = (anchor.getAttribute('download') || anchor.textContent || '').trim();
          emitDownload(href, fileName || document.title || 'download');
        }, true);

        document.addEventListener('submit', (event) => {
          const form = event.target;
          if (!form || !form.action) {
            return;
          }
          if (emitDownload(form.action, document.title || 'download')) {
            stopEvent(event);
          }
        }, true);

        const originalOpen = window.open ? window.open.bind(window) : null;
        if (originalOpen) {
          window.open = function(url, target, features) {
            if (typeof url === 'string' && emitDownload(url, document.title || 'download')) {
              return null;
            }
            return originalOpen(url, target, features);
          };
        }

        (window).__modManagerNextcloudPollDownloadUrl = () => {
          const href = window.location.href || '';
          if (isDownloadUrl(href) && href !== (window).__modManagerLastDlUrl) {
            (window).__modManagerLastDlUrl = href;
            emitDownload(href, document.title || 'download');
          }
        };
      } catch {
        // Ignore script injection failures on restricted pages.
      }
    })();`;

    const pollScript = `(() => {
      try {
        if (typeof (window).__modManagerNextcloudPollDownloadUrl === 'function') {
          (window).__modManagerNextcloudPollDownloadUrl();
        }
      } catch {
        // Ignore transient polling errors.
      }
    })();`;

    const intervalId = window.setInterval(() => {
      void runWebviewScript(installHookScript).catch(() => {});
      void runWebviewScript(pollScript).catch(() => {});
    }, 1200);

    void runWebviewScript(installHookScript).catch(() => {});
    void runWebviewScript(pollScript).catch(() => {});

    return () => {
      window.clearInterval(intervalId);
    };
  }, [browserUrl, canUseNativeWebview, runWebviewScript]);

  async function handleOpenExternal(url: string) {
    if (!url) {
      return;
    }
    await openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  function loadInPanel(url: string) {
    const normalized = normalizeUrl(url);
    setBrowserUrl(normalized);
    setAddressInput(normalized);
    setNativeError(null);
  }

  const selectedLink = normalizeUrl(links[selectedGame] ?? "");

  return (
    <section className="mt-4">
      <article className="rounded-[28px] border border-white/10 bg-slate-950/40 p-6 shadow-[0_20px_80px_rgba(2,6,23,0.35)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Nextcloud Shared Links</p>
            <h2 className="mt-2 text-xl font-semibold text-white">Native In-App Browser</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                loadInPanel(selectedLink);
              }}
              className="inline-flex items-center gap-2 rounded-full border border-cyan-300/35 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25"
              disabled={!selectedLink}
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
                void handleOpenExternal(addressInput || selectedLink);
              }}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
              disabled={!addressInput && !selectedLink}
            >
              <ExternalLink className="h-4 w-4" />
              Open External
            </button>
          </div>
        </div>

        <div className="mt-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Game</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {GAME_ORDER.map((gameId) => {
              const selected = selectedGame === gameId;
              return (
                <button
                  key={gameId}
                  type="button"
                  onClick={() => {
                    setSelectedGame(gameId);
                    onGameSelect?.(gameId);
                  }}
                  className={selected
                    ? "rounded-full border border-cyan-300/45 bg-cyan-400/20 px-3 py-1.5 text-xs font-medium text-cyan-100 transition"
                    : "rounded-full border border-white/10 bg-white/4 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/8"}
                >
                  {GAMES[gameId].shortLabel}
                </button>
              );
            })}
          </div>
          {!selectedLink ? (
            <p className="mt-3 text-xs text-amber-200/90">
              No Nextcloud link configured for {GAMES[selectedGame].name}. Add it in Settings.
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
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
            placeholder="https://nextcloud.example.com/s/..."
            className="min-w-[220px] flex-1 rounded-full border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-100"
          />
          <button
            type="button"
            onClick={() => {
              void runWebviewScript("history.back();");
            }}
            className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
            disabled={!browserUrl}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              void runWebviewScript("history.forward();");
            }}
            className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
            disabled={!browserUrl}
          >
            Forward
          </button>
          <button
            type="button"
            onClick={() => {
              loadInPanel(addressInput);
            }}
            className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
            disabled={!addressInput}
          >
            Go
          </button>
          <button
            type="button"
            onClick={() => {
              setRefreshNonce((current) => current + 1);
            }}
            className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
            disabled={!browserUrl}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
        </div>

        <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950 p-2">
          <div ref={panelRef} className="relative h-[70dvh] overflow-hidden rounded-xl border border-white/10 bg-slate-950/80">
            {!browserUrl ? (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/85 text-xs text-slate-300">
                Add a Nextcloud link in Settings and click Load Selected.
              </div>
            ) : !canUseNativeWebview ? (
              <iframe
                key={`${browserUrl}-${refreshNonce}`}
                src={browserUrl}
                title="Nextcloud Browser Fallback"
                className="h-full w-full"
                referrerPolicy="no-referrer"
              />
            ) : null}
            {browserUrl && canUseNativeWebview && !webviewReady ? (
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
          <p className="mt-2 text-xs text-cyan-100/90">Installing selected download...</p>
        ) : null}
        {downloadError ? (
          <p className="mt-2 text-xs text-rose-200/90">Download install failed: {downloadError}</p>
        ) : null}
        {localInstallStatus ? (
          <p className="mt-2 text-xs text-emerald-200/90">{localInstallStatus}</p>
        ) : null}
      </article>
    </section>
  );
}
