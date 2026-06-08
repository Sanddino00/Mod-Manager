import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, RefreshCw } from "lucide-react";
import { GAME_ORDER, GAMEBANANA_URLS, GAMES } from "./config/games";
import type { DownloadEventPayload } from "./BrowseTab";
import type { GameKey } from "./types";

const GB_WEBVIEW_LABEL = "gb-browser-view";
const GB_DOWNLOAD_EVENT = "mod-manager-web-download-request";

type DownloadInstallResult = {
  installed_path: string;
  destination_path: string;
  preview_path: string | null;
};

type WebDownloadRequestPayload = {
  source: "gb" | "arca";
  url: string;
  fileName?: string;
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = {
  game: GameKey;
  gameModRoot: string;
  onDownloadEvent?: (payload: DownloadEventPayload) => void;
  onGameSelect?: (game: GameKey) => void;
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
  return /\/dl\/|download|attachment/i.test(url) || /\.(zip|7z|rar|pak|exe|dll|txt)(?:$|[?#])/i.test(url);
}

export function GameBananaWebTab({ game, gameModRoot, onDownloadEvent, onGameSelect }: Props) {
  const [selectedGame, setSelectedGame] = useState<GameKey>(game);
  const [browserUrl, setBrowserUrl] = useState(GAMEBANANA_URLS[game]);
  const [addressInput, setAddressInput] = useState(GAMEBANANA_URLS[game]);
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

  const handleManagedDownload = useCallback(
    async (url: string, preferredName?: string) => {
      if (!url || !isLikelyDownloadUrl(url)) {
        return;
      }

      const fileName = (preferredName?.trim() || deriveNameFromUrl(url, "download")).trim();
      const modName = deriveModName(fileName);
      const destination = await pickInstallDestination();
      if (!destination) {
        return;
      }

      const requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      onDownloadEvent?.({
        kind: "start",
        source: "gamebanana",
        id: requestId,
        modName,
        fileName,
        destinationPath: destination,
      });

      setDownloading(true);
      setDownloadError(null);

      try {
        const result = await invoke<DownloadInstallResult>("download_and_install_mod", {
          url,
          destItemPath: destination,
          modName,
          previewUrl: null,
        });

        onDownloadEvent?.({
          kind: "success",
          source: "gamebanana",
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
          source: "gamebanana",
          id: requestId,
          modName,
          fileName,
          destinationPath: destination,
          message,
        });
      } finally {
        setDownloading(false);
      }
    },
    [onDownloadEvent, pickInstallDestination],
  );

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

    const fileName = archivePath.split(/[\\/]/).pop()?.trim() || "download.zip";
    const modName = deriveModName(fileName);
    const requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    onDownloadEvent?.({
      kind: "start",
      source: "gamebanana",
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
      });

      onDownloadEvent?.({
        kind: "success",
        source: "gamebanana",
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
        source: "gamebanana",
        id: requestId,
        modName,
        fileName,
        destinationPath: destination,
        message,
      });
    } finally {
      setInstallingLocalArchive(false);
    }
  }, [downloadsFolder, onDownloadEvent, pickInstallDestination]);

  useEffect(() => {
    setSelectedGame(game);
  }, [game]);

  useEffect(() => {
    void invoke<string>("get_default_downloads_folder")
      .then((path) => {
        if (path.trim()) {
          setDownloadsFolder(path);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const nextUrl = GAMEBANANA_URLS[selectedGame];
    setAddressInput(nextUrl);
    setBrowserUrl(nextUrl);
    setNativeError(null);
  }, [selectedGame]);

  const runWebviewScript = useCallback(
    async (script: string) => {
      if (!canUseNativeWebview) {
        return;
      }
      await invoke("webview_eval", {
        label: GB_WEBVIEW_LABEL,
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

      const existing = await Webview.getByLabel(GB_WEBVIEW_LABEL).catch(() => null);
      if (disposed) {
        return;
      }

      if (existing) {
        webviewRef.current = existing;
        setWebviewReady(true);
      }

      const rect = host.getBoundingClientRect();
      const width = Math.max(320, Math.round(rect.width));
      const height = Math.max(260, Math.round(rect.height));
      const x = Math.max(0, Math.round(rect.left));
      const y = Math.max(0, Math.round(rect.top));

      const webview = existing
        ?? new Webview(getCurrentWindow(), GB_WEBVIEW_LABEL, {
          url: browserUrl,
          x,
          y,
          width,
          height,
          focus: false,
          dataDirectory: "gb-profile",
        });

      webviewRef.current = webview;

      if (!existing) {
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
      }

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

      const oldCleanup = (webview as unknown as { __gbCleanup?: () => void }).__gbCleanup;
      if (oldCleanup) {
        oldCleanup();
      }
      (webview as unknown as { __gbCleanup?: () => void }).__gbCleanup = cleanup;
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
        const cleanup = (current as unknown as { __gbCleanup?: () => void }).__gbCleanup;
        if (cleanup) {
          cleanup();
        }
        void Promise.all([
          current.setPosition(new LogicalPosition(-10000, -10000)).catch(() => {}),
          current.setSize(new LogicalSize(1, 1)).catch(() => {}),
        ]).catch(() => {});
      }
    };
  }, [canUseNativeWebview, syncWebviewBounds]);

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
    let unlisten: (() => void) | null = null;

    void listen<WebDownloadRequestPayload>(GB_DOWNLOAD_EVENT, (event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      if (!payload || payload.source !== "gb") {
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
    if (!canUseNativeWebview || !webviewRef.current) {
      return;
    }

    const installHookScript = `(() => {
      try {
        if ((window).__modManagerGbDownloadHookInstalled) {
          return;
        }
        (window).__modManagerGbDownloadHookInstalled = true;

        const isDownloadUrl = (url) => /\\/dl\\/|\\bdownloads?\\b|attachment|\\/files\\//i.test(url) || /\\.(zip|7z|rar|pak|exe|dll|txt|msi)(?:$|[?#])/i.test(url);

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
              source: 'gb',
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

        const pickAttr = (el, names) => {
          if (!el || typeof el.getAttribute !== 'function') {
            return '';
          }
          for (const name of names) {
            const value = el.getAttribute(name);
            if (value && String(value).trim()) {
              return String(value).trim();
            }
          }
          return '';
        };

        const urlFromNode = (node) => {
          if (!node || typeof node !== 'object') {
            return '';
          }

          let current = node;
          for (let depth = 0; depth < 6 && current; depth += 1) {
            const raw =
              pickAttr(current, ['data-mm-download-url', 'data-download-url', 'data-href', 'href', 'action', 'formaction']) ||
              (typeof current.href === 'string' ? current.href : '') ||
              (typeof current.action === 'string' ? current.action : '') ||
              (typeof current.formAction === 'string' ? current.formAction : '');

            if (raw) {
              const absolute = toAbsoluteUrl(raw);
              if (isDownloadUrl(absolute)) {
                return absolute;
              }
            }

            const onclickRaw = pickAttr(current, ['onclick']);
            if (onclickRaw) {
              const match = onclickRaw.match(/https?:\\/\\/[^'"\\s]+|\\/dl\\/[^'"\\s]+|\\/downloads?\\/[^'"\\s]+/i);
              if (match && match[0]) {
                const absolute = toAbsoluteUrl(match[0]);
                if (isDownloadUrl(absolute)) {
                  return absolute;
                }
              }
            }

            current = current.parentElement || null;
          }
          return '';
        };

        const nearbyDownloadUrl = (node) => {
          let current = node;
          for (let depth = 0; depth < 4 && current; depth += 1) {
            if (current && typeof current.querySelectorAll === 'function') {
              const candidates = current.querySelectorAll('a[href], area[href], [data-download-url], [data-href], button, input[type="submit"], input[type="button"]');
              for (const candidate of candidates) {
                const found = urlFromNode(candidate);
                if (found) {
                  return found;
                }
              }
            }
            current = current.parentElement || null;
          }
          return '';
        };

        const hasDownloadIntent = (node) => {
          if (!node) {
            return false;
          }
          const text = String(node.textContent || node.value || '').trim().toLowerCase();
          return /\\b(download|get file|install)\\b/.test(text);
        };

        const handleIntent = (event) => {
          const target = event.target;
          if (!target || !target.closest) {
            return;
          }

          const clickable = target.closest('a, area, button, [role="button"], input[type="submit"], input[type="button"]');
          if (!clickable) {
            return;
          }

          const found = urlFromNode(clickable) || nearbyDownloadUrl(clickable);
          if (found) {
            stopEvent(event);
            emitDownload(found, (pickAttr(clickable, ['download']) || clickable.textContent || document.title || 'download'));
            return;
          }

          if (hasDownloadIntent(clickable)) {
            const fallback = nearbyDownloadUrl(clickable);
            if (fallback) {
              stopEvent(event);
              emitDownload(fallback, clickable.textContent || document.title || 'download');
            }
          }
        };

        document.addEventListener('click', handleIntent, true);
        document.addEventListener('auxclick', handleIntent, true);
        document.addEventListener('mousedown', handleIntent, true);
        document.addEventListener('pointerdown', handleIntent, true);

        document.addEventListener('submit', (event) => {
          const form = event.target;
          if (!form) {
            return;
          }
          const action = toAbsoluteUrl(form.action || (form.getAttribute && form.getAttribute('action')) || '');
          if (action && emitDownload(action, document.title || 'download')) {
            stopEvent(event);
          }
        }, true);

        try {
          const originalFormSubmit = HTMLFormElement.prototype.submit;
          HTMLFormElement.prototype.submit = function(...args) {
            const action = toAbsoluteUrl(this.action || this.getAttribute('action') || '');
            if (action && emitDownload(action, document.title || 'download')) {
              return;
            }
            return originalFormSubmit.apply(this, args);
          };
        } catch {
          // Ignore prototype patch failures.
        }

        try {
          const originalAnchorClick = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function(...args) {
            const href = this.getAttribute('data-mm-download-url') || this.href || '';
            const fileName = (this.getAttribute('download') || this.textContent || '').trim();
            if (emitDownload(href, fileName)) {
              return;
            }
            return originalAnchorClick.apply(this, args);
          };
        } catch {
          // Ignore prototype patch failures.
        }

        const originalFetch = window.fetch ? window.fetch.bind(window) : null;
        if (originalFetch) {
          window.fetch = function(input, init) {
            const rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
            if (emitDownload(rawUrl, document.title || 'download')) {
              return Promise.reject(new Error('Managed download intercepted'));
            }
            return originalFetch(input, init);
          };
        }

        const originalXhrOpen = XMLHttpRequest.prototype.open;
        const originalXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__mmDownloadUrl = toAbsoluteUrl(url);
          return originalXhrOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(...args) {
          const href = this.__mmDownloadUrl || '';
          if (emitDownload(href, document.title || 'download')) {
            return;
          }
          return originalXhrSend.apply(this, args);
        };

        try {
          const originalOpen = window.open.bind(window);
          window.open = function(url, target, features) {
            if (typeof url === 'string' && emitDownload(url, document.title || 'download')) {
              return null;
            }
            return originalOpen(url, target, features);
          };
        } catch {
          // Ignore patch failures.
        }

        (window).__modManagerGbPollDownloadUrl = () => {
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
        if (typeof (window).__modManagerGbPollDownloadUrl === 'function') {
          (window).__modManagerGbPollDownloadUrl();
        }
      } catch {
        // Ignore transient polling errors.
      }
    })();`;

    const intervalId = window.setInterval(() => {
      void runWebviewScript(installHookScript).catch(() => {
        // Ignore transient script errors during navigation.
      });
      void runWebviewScript(pollScript).catch(() => {
        // Ignore transient script errors during navigation.
      });
    }, 1200);

    void runWebviewScript(installHookScript).catch(() => {
      // Ignore transient script errors during navigation.
    });
    void runWebviewScript(pollScript).catch(() => {
      // Ignore transient script errors during navigation.
    });

    return () => {
      window.clearInterval(intervalId);
    };
  }, [canUseNativeWebview, runWebviewScript]);

  async function handleOpenExternal(url: string) {
    await openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  function normalizeUrl(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      return GAMEBANANA_URLS[selectedGame];
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

  return (
    <section className="mt-4">
      <article className="rounded-[28px] border border-white/10 bg-slate-950/40 p-6 shadow-[0_20px_80px_rgba(2,6,23,0.35)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">GameBanana Website</p>
            <h2 className="mt-2 text-xl font-semibold text-white">Native In-App Browser</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                loadInPanel(GAMEBANANA_URLS[selectedGame]);
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
              disabled={installingLocalArchive || downloading}
              className="inline-flex items-center gap-2 rounded-full border border-amber-300/35 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-70"
            >
              {installingLocalArchive ? "Installing..." : "Install Downloaded File"}
            </button>
            <button
              type="button"
              onClick={() => {
                void handleOpenExternal(addressInput || GAMEBANANA_URLS[selectedGame]);
              }}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
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
            placeholder="https://gamebanana.com/..."
            className="min-w-[220px] flex-1 rounded-full border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-100"
          />
          <button
            type="button"
            onClick={() => {
              void runWebviewScript("history.back();");
            }}
            className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white transition hover:bg-white/15"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              void runWebviewScript("history.forward();");
            }}
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
          <div ref={panelRef} className="relative h-[70dvh] overflow-hidden rounded-xl border border-white/10 bg-slate-950/80">
            {!canUseNativeWebview ? (
              <iframe
                key={`${browserUrl}-${refreshNonce}`}
                src={browserUrl}
                title="GameBanana Browser Fallback"
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
          <p className="mt-2 text-xs text-cyan-100/90">Installing selected download...</p>
        ) : null}
        {installingLocalArchive ? (
          <p className="mt-2 text-xs text-amber-100/90">Installing archive from local download...</p>
        ) : null}
        {localInstallStatus ? (
          <p className="mt-2 text-xs text-emerald-200/90">{localInstallStatus}</p>
        ) : null}
        {downloadError ? (
          <p className="mt-2 text-xs text-rose-200/90">Download install failed: {downloadError}</p>
        ) : null}
      </article>
    </section>
  );
}
