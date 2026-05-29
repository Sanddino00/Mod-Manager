import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import { ChevronDown, ExternalLink, KeyRound, Link2, RefreshCw } from "lucide-react";
import { ARCA_GAMES, ARCA_URLS, GAMES, type ArcaGameKey } from "./config/games";
import type { DownloadEventPayload } from "./BrowseTab";

type ChannelMode = "normal" | "r18";

const ARCA_WEBVIEW_LABEL = "arca-browser-view";
const ARCA_DOWNLOAD_EVENT = "mod-manager-web-download-request";

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

interface Props {
  gameModRoot: string;
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

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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

function isLikelyDownloadUrl(url: string): boolean {
  return /\/dl\/|download|attachment/i.test(url) || /\.(zip|7z|rar|pak|exe|dll|txt)(?:$|[?#])/i.test(url);
}

export function ArcaTab({ gameModRoot, onDownloadEvent }: Props) {
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
  const [downloading, setDownloading] = useState(false);
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

  useEffect(() => {
    setAddressInput(activeArcaUrl);
    setBrowserUrl(activeArcaUrl);
    setNativeError(null);
  }, [activeArcaUrl]);

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

      const current = webviewRef.current;
      if (current) {
        await current.close().catch(() => {});
        webviewRef.current = null;
      }

      const existing = await Webview.getByLabel(ARCA_WEBVIEW_LABEL).catch(() => null);
      if (existing) {
        await existing.close().catch(() => {});
      }

      if (disposed) {
        return;
      }

      const rect = host.getBoundingClientRect();
      const width = Math.max(320, Math.round(rect.width));
      const height = Math.max(260, Math.round(rect.height));
      const x = Math.max(0, Math.round(rect.left));
      const y = Math.max(0, Math.round(rect.top));

      const webview = new Webview(getCurrentWindow(), ARCA_WEBVIEW_LABEL, {
        url: browserUrl,
        x,
        y,
        width,
        height,
        focus: false,
        dataDirectory: "arca-profile",
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
        void current.close().catch(() => {});
      }

      void Webview.getByLabel(ARCA_WEBVIEW_LABEL)
        .then((view) => view?.close().catch(() => {}))
        .catch(() => {});
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

    void listen<WebDownloadRequestPayload>(ARCA_DOWNLOAD_EVENT, (event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      if (!payload || payload.source !== "arca") {
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
        if ((window).__modManagerArcaDownloadHookInstalled) {
          return;
        }
        (window).__modManagerArcaDownloadHookInstalled = true;

        const isDownloadUrl = (url) => /\\/dl\\/|download|attachment/i.test(url) || /\\.(zip|7z|rar|pak|exe|dll|txt)(?:$|[?#])/i.test(url);

        const emitDownload = (href, fileName) => {
          if (!href || !isDownloadUrl(href)) {
            return false;
          }
          if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
            void window.__TAURI_INTERNALS__.invoke('emit_web_download_request', {
              source: 'arca',
              url: href,
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
            const button = target && target.closest ? target.closest('button, [role="button"]') : null;
            if (!button) {
              return;
            }
            const text = (button.textContent || '').trim();
            const explicitHref = (button.getAttribute && (button.getAttribute('data-href') || button.getAttribute('data-download-url'))) || '';
            if (emitDownload(explicitHref, text)) {
              stopEvent(event);
            }
            return;
          }
          const href = anchor.href || '';
          const explicitDownload = anchor.hasAttribute('download');
          if (!href || (!explicitDownload && !isDownloadUrl(href))) {
            return;
          }
          stopEvent(event);
          const fileName = (anchor.getAttribute('download') || anchor.textContent || '').trim();
          if (!emitDownload(href, fileName)) {
            window.location.href = href;
          }
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

        const originalOpen = window.open.bind(window);
        window.open = function(url, target, features) {
          if (typeof url === 'string' && emitDownload(url, document.title || 'download')) {
            return null;
          }
          return originalOpen(url, target, features);
        };

        const originalAssign = window.location.assign.bind(window.location);
        window.location.assign = function(url) {
          if (typeof url === 'string' && emitDownload(url, document.title || 'download')) {
            return;
          }
          originalAssign(url);
        };

        const originalReplace = window.location.replace.bind(window.location);
        window.location.replace = function(url) {
          if (typeof url === 'string' && emitDownload(url, document.title || 'download')) {
            return;
          }
          originalReplace(url);
        };

        (window).__modManagerArcaPollDownloadUrl = () => {
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
        if (typeof (window).__modManagerArcaPollDownloadUrl === 'function') {
          (window).__modManagerArcaPollDownloadUrl();
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

  function handleReload() {
    setRefreshNonce((current) => current + 1);
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

  return (
    <section className="mt-4 xl:overflow-hidden">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_310px] xl:items-start">
        <article className="rounded-[28px] border border-white/10 bg-slate-950/40 p-6 shadow-[0_20px_80px_rgba(2,6,23,0.35)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
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
                  void handleOpenExternal(addressInput || activeArcaUrl);
                }}
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
              >
                <ExternalLink className="h-4 w-4" />
                Open External
              </button>
            </div>
          </div>

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
              onClick={handleReload}
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
            <p className="mt-2 text-xs text-cyan-100/90">Installing selected download...</p>
          ) : null}
          {downloadError ? (
            <p className="mt-2 text-xs text-rose-200/90">Download install failed: {downloadError}</p>
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
            </div>
          </details>

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
        </aside>
      </div>
    </section>
  );
}
