import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import type { DownloadEventPayload } from "./BrowseTab";

const DISCORD_WEBVIEW_LABEL = "discord-browser-view";
const DISCORD_DOWNLOAD_EVENT = "mod-manager-web-download-request";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = {
  rememberWebSessions: boolean;
  gameModRoot: string;
  onDownloadEvent?: (payload: DownloadEventPayload) => void;
};

type DownloadInstallResult = {
  installed_path: string;
  destination_path: string;
  preview_path: string | null;
};

type WebDownloadRequestPayload = {
  source: "discord";
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

function normalizeDiscordDownloadFileName(preferredName: string, url: string): string {
  const trimmed = preferredName.trim();
  const lower = trimmed.toLowerCase();
  const lowQuality = !trimmed
    || lower === "download"
    || lower === "weiter zum download"
    || lower === "download now"
    || lower.length < 4;

  if (!lowQuality) {
    return trimmed;
  }

  const fromUrl = deriveNameFromUrl(url, "").trim();
  if (fromUrl && fromUrl.toLowerCase() !== "download") {
    return fromUrl;
  }

  return `discord_download_${Date.now()}.bin`;
}

export function DiscordTab({ rememberWebSessions, gameModRoot, onDownloadEvent }: Props) {
  const [browserUrl, setBrowserUrl] = useState("https://discord.com/app");
  const [addressInput, setAddressInput] = useState("https://discord.com/app");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [webviewReady, setWebviewReady] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [localInstallStatus, setLocalInstallStatus] = useState<string | null>(null);
  const [lastCapturedUrl, setLastCapturedUrl] = useState<string | null>(null);
  const [captureCount, setCaptureCount] = useState(0);
  const [lastCaptureAt, setLastCaptureAt] = useState<number | null>(null);
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

  const handleManagedDownload = useCallback(async (url: string, preferredName?: string) => {
    if (!url) {
      return;
    }

    const fileName = normalizeDiscordDownloadFileName(preferredName?.trim() || deriveNameFromUrl(url, "download"), url);
    const destinationFolder = downloadsFolder.trim() || (await invoke<string>("get_default_downloads_folder").catch(() => ""));
    if (!destinationFolder) {
      return;
    }

    const requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    onDownloadEvent?.({
      kind: "start",
      source: "discord",
      id: requestId,
      modName: deriveModName(fileName),
      fileName,
      destinationPath: destinationFolder,
    });

    setDownloading(true);
    setDownloadError(null);
    setLocalInstallStatus(null);

    try {
      const savedPath = await invoke<string>("download_file_to_folder", {
        url,
        destFolder: destinationFolder,
        fileName,
      });

      onDownloadEvent?.({
        kind: "success",
        source: "discord",
        id: requestId,
        modName: deriveModName(fileName),
        fileName,
        destinationPath: destinationFolder,
        installedPath: savedPath,
        previewPath: null,
      });

      setLocalInstallStatus(`Downloaded ${fileName} to ${destinationFolder}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDownloadError(message);
      onDownloadEvent?.({
        kind: "error",
        source: "discord",
        id: requestId,
        modName: deriveModName(fileName),
        fileName,
        destinationPath: destinationFolder,
        message,
      });
    } finally {
      setDownloading(false);
    }
  }, [downloadsFolder, onDownloadEvent]);

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

      let existing = await Webview.getByLabel(DISCORD_WEBVIEW_LABEL).catch(() => null);

      if (!rememberWebSessions && existing) {
        await existing.close().catch(() => {});
        existing = null;
      }

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

      const webview = existing ?? new Webview(getCurrentWindow(), DISCORD_WEBVIEW_LABEL, {
        url: browserUrl,
        x,
        y,
        width,
        height,
        focus: false,
        dataDirectory: rememberWebSessions ? "discord-profile" : profileId,
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

        if (rememberWebSessions) {
          void Promise.all([
            current.setPosition(new LogicalPosition(-10000, -10000)).catch(() => {}),
            current.setSize(new LogicalSize(1, 1)).catch(() => {}),
          ]).catch(() => {});
        } else {
          void current.close().catch(() => {});
        }
      }

      if (!rememberWebSessions) {
        void Webview.getByLabel(DISCORD_WEBVIEW_LABEL)
          .then((view) => view?.close().catch(() => {}))
          .catch(() => {});
      }
    };
  }, [browserUrl, canUseNativeWebview, profileId, rememberWebSessions, syncWebviewBounds]);

  useEffect(() => {
    if (!canUseNativeWebview || !webviewRef.current) {
      return;
    }

    const escaped = JSON.stringify(browserUrl);
    const script = `window.location.href = ${escaped};`;
    void runWebviewScript(script).catch((err) => {
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

    void listen<WebDownloadRequestPayload>(DISCORD_DOWNLOAD_EVENT, (event) => {
      if (disposed) {
        return;
      }

      const payload = event.payload;
      if (!payload || payload.source !== "discord" || !payload.url) {
        return;
      }

      setLastCapturedUrl(payload.url);
      setCaptureCount((current) => current + 1);
      setLastCaptureAt(Date.now());

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
        const HOOK_VERSION = 4;
        if ((window).__modManagerDiscordDownloadHookVersion === HOOK_VERSION) {
          return;
        }
        (window).__modManagerDiscordDownloadHookVersion = HOOK_VERSION;
        (window).__modManagerDiscordDownloadHookInstalled = true;

        const ARCHIVE_EXT_RE = /\\.(zip|7z|rar|pak|exe|dll|txt|msi)(?:$|[?#])/i;
        const isDownloadUrl = (url) => /discordapp\\.com\\/attachments|cdn\\.discordapp\\.com\\/attachments|media\\.discordapp\\.net\\/attachments|cdn\\.discordapp\\.net\\/attachments|discordsays\\.com|\\bdownload\\b|attachment|\\/files\\//i.test(url) || ARCHIVE_EXT_RE.test(url);
        const isLikelyAttachmentName = (value) => {
          const lower = String(value || '').toLowerCase();
          if (!lower) {
            return false;
          }
          return /(\\.zip|\\.7z|\\.rar|\\.pak|\\.exe|\\.dll|\\.txt|\\.msi)\\b/.test(lower)
            || /download|herunterladen|attachment|datei/i.test(lower);
        };
        const URL_RE = /https?:\\/\\/[^\\s"'<>]+/i;
        const getEventNode = (event) => {
          if (event && typeof event.composedPath === 'function') {
            const path = event.composedPath();
            for (const node of path) {
              if (node && typeof node.closest === 'function') {
                return node;
              }
            }
          }
          return event ? event.target : null;
        };
        const toAbsoluteUrl = (value) => {
          try {
            return new URL(String(value || ''), window.location.href).href;
          } catch {
            return String(value || '');
          }
        };

        const emitDownload = (href, fileName, allowAny = false) => {
          if (!href) {
            return false;
          }
          const absolute = toAbsoluteUrl(href);
          if (!absolute || (!allowAny && !isDownloadUrl(absolute))) {
            return false;
          }
          const invokeFn =
            (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function' && window.__TAURI_INTERNALS__.invoke)
            || (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function' && window.__TAURI__.core.invoke)
            || (window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.invoke)
            || null;
          if (invokeFn) {
            void invokeFn('emit_web_download_request', {
              source: 'discord',
              url: absolute,
              fileName: (fileName || '').trim(),
            }).catch(() => {});
            return true;
          }
          return false;
        };

        const findNearbyAttachmentUrl = (node) => {
          let current = node;
          for (let depth = 0; depth < 6 && current; depth += 1) {
            if (current && typeof current.querySelectorAll === 'function') {
              const anchors = current.querySelectorAll('a[href], area[href]');
              for (const anchor of anchors) {
                const href = anchor.getAttribute('href') || anchor.href || '';
                const text = String(anchor.textContent || '').trim();
                if (href && (isDownloadUrl(href) || isLikelyAttachmentName(text))) {
                  return href;
                }
              }
            }
            current = current.parentElement || null;
          }

          if (document && typeof document.querySelectorAll === 'function') {
            const globalAnchors = document.querySelectorAll('a[href], area[href]');
            for (const anchor of globalAnchors) {
              const href = anchor.getAttribute('href') || anchor.href || '';
              const text = String(anchor.textContent || '').trim();
              if (href && (isDownloadUrl(href) || isLikelyAttachmentName(text))) {
                return href;
              }
            }
          }

          return '';
        };

        const findUrlInNodeText = (node) => {
          let current = node;
          for (let depth = 0; depth < 5 && current; depth += 1) {
            const text = String(current.textContent || '').trim();
            const match = text.match(URL_RE);
            if (match && match[0]) {
              return match[0];
            }
            current = current.parentElement || null;
          }
          return '';
        };

        const probeDownloadUrl = () => {
          const fromLocation = window.location.href || '';
          if (fromLocation && isDownloadUrl(fromLocation)) {
            return fromLocation;
          }

          const selectors = [
            'a[href]',
            'area[href]',
            '[data-href]',
            '[data-url]',
          ];
          for (const selector of selectors) {
            const nodes = document.querySelectorAll(selector);
            for (const node of nodes) {
              const href =
                (node.getAttribute && (node.getAttribute('href') || node.getAttribute('data-href') || node.getAttribute('data-url'))) ||
                '';
              const text = String(node.textContent || '').trim();
              if (href && (isDownloadUrl(href) || isLikelyAttachmentName(text))) {
                return href;
              }
            }
          }

          return '';
        };

        const scheduleDownloadProbe = (label) => {
          let tries = 0;
          const timer = window.setInterval(() => {
            tries += 1;
            try {
              const candidate = probeDownloadUrl();
              if (candidate) {
                emitDownload(candidate, label || document.title || 'download', true);
                window.clearInterval(timer);
                return;
              }
            } catch {
              // Ignore transient probe failures.
            }

            if (tries >= 24) {
              window.clearInterval(timer);
            }
          }, 250);
        };

        const wrapPopupWindow = (popup, label) => {
          if (!popup || popup.__modManagerPopupWrapped) {
            return popup;
          }

          try {
            popup.__modManagerPopupWrapped = true;
          } catch {
            // Ignore marker write failures on restricted popup objects.
          }

          let lastHref = '';
          const monitorId = window.setInterval(() => {
            try {
              if (!popup || popup.closed) {
                window.clearInterval(monitorId);
                return;
              }

              const href = String((popup.location && popup.location.href) || '');
              if (href && href !== lastHref) {
                lastHref = href;
                emitDownload(href, label, true);
              }
            } catch {
              // Cross-origin popups can throw; keep polling until closed.
            }
          }, 200);

          const proxy = new Proxy(popup, {
            get(target, prop, receiver) {
              if (prop === 'location') {
                try {
                  const loc = target.location;
                  return new Proxy(loc, {
                    get(locTarget, locProp, locReceiver) {
                      if (locProp === 'assign' || locProp === 'replace') {
                        return (nextValue) => {
                          emitDownload(String(nextValue || ''), label, true);
                          return locTarget[locProp].call(locTarget, nextValue);
                        };
                      }
                      return Reflect.get(locTarget, locProp, locReceiver);
                    },
                    set(locTarget, locProp, nextValue) {
                      if ((locProp === 'href' || locProp === 'pathname' || locProp === 'search' || locProp === 'hash') && typeof nextValue === 'string') {
                        emitDownload(nextValue, label, true);
                      }
                      return Reflect.set(locTarget, locProp, nextValue);
                    },
                  });
                } catch {
                  return Reflect.get(target, prop, receiver);
                }
              }

              return Reflect.get(target, prop, receiver);
            },
            set(target, prop, value, receiver) {
              if (prop === 'location') {
                emitDownload(String(value || ''), label, true);
              }
              return Reflect.set(target, prop, value, receiver);
            },
          });

          return proxy;
        };

        document.addEventListener('click', (event) => {
          const target = getEventNode(event);
          const anchor = target && target.closest ? target.closest('a[href], area[href]') : null;
          if (!anchor) {
            return;
          }

          const href = anchor.href || '';
          const explicitDownload = anchor.hasAttribute('download');
          if (!href) {
            return;
          }

          if (explicitDownload || isDownloadUrl(href) || isLikelyAttachmentName(anchor.textContent || '')) {
            const fileName = (anchor.getAttribute('download') || anchor.textContent || '').trim();
            emitDownload(href, fileName || document.title || 'download', true);
          }

          const textUrl = findUrlInNodeText(anchor);
          if (textUrl && textUrl !== href) {
            emitDownload(textUrl, document.title || 'download', true);
          }
        }, true);

        document.addEventListener('click', (event) => {
          const target = getEventNode(event);
          if (!target || !target.closest) {
            return;
          }

          let handledButtonAction = false;
          const button = target.closest('button, [role="button"]');
          if (button) {
            const label = String(button.textContent || button.getAttribute('aria-label') || '').toLowerCase();
            if (/download|herunterladen/.test(label)) {
              handledButtonAction = true;
              emitDownload(window.location.href || '', button.textContent || document.title || 'download', true);
              scheduleDownloadProbe(button.textContent || document.title || 'download');

              const directHref =
                (button.getAttribute && (button.getAttribute('data-href') || button.getAttribute('href') || button.getAttribute('data-url'))) || '';
              const found = directHref || findNearbyAttachmentUrl(button);
              const fromText = findUrlInNodeText(button);
              const finalUrl = found || fromText || window.location.href || '';
              if (finalUrl) {
                emitDownload(finalUrl, button.textContent || document.title || 'download', true);
              }
            }

            if (/weiter zum download/.test(label)) {
              handledButtonAction = true;
              emitDownload(window.location.href || '', button.textContent || document.title || 'download', true);
              scheduleDownloadProbe(button.textContent || document.title || 'download');

              const found = findNearbyAttachmentUrl(button) || window.location.href || '';
              if (found) {
                emitDownload(found, button.textContent || document.title || 'download', true);
              }

              window.setTimeout(() => {
                try {
                  const nextHref = window.location.href || '';
                  if (nextHref) {
                    emitDownload(nextHref, document.title || 'download', true);
                  }
                } catch {
                  // Ignore post-confirm URL probe failures.
                }
              }, 180);
            }
          }

          if (handledButtonAction) {
            return;
          }

          const textUrl = findUrlInNodeText(target);
          if (textUrl && !isDownloadUrl(textUrl)) {
            emitDownload(textUrl, document.title || 'download', true);
          }
        }, true);

        const originalOpen = window.open ? window.open.bind(window) : null;
        if (originalOpen) {
          window.open = function(url, target, features) {
            const label = document.title || 'download';
            if (typeof url === 'string' && url) {
              emitDownload(url, label, true);
            }

            const popup = originalOpen(url, target, features);
            if (popup) {
              return wrapPopupWindow(popup, label);
            }

            return popup;
          };
        }

        const originalFetch = window.fetch ? window.fetch.bind(window) : null;
        if (originalFetch) {
          window.fetch = function(input, init) {
            const requestUrl = typeof input === 'string' ? input : (input && input.url) || '';
            emitDownload(requestUrl, document.title || 'download');
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
          emitDownload(href, document.title || 'download');
          return originalXhrSend.apply(this, args);
        };

        (window).__modManagerDiscordPollDownloadUrl = () => {
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
        if (typeof (window).__modManagerDiscordPollDownloadUrl === 'function') {
          (window).__modManagerDiscordPollDownloadUrl();
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
  }, [canUseNativeWebview, runWebviewScript]);

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
          <button
            type="button"
            onClick={() => {
              void openUrl("https://discord.com/app");
            }}
            className="inline-flex items-center gap-2 rounded-full border border-fuchsia-300/35 bg-fuchsia-500/15 px-4 py-2 text-sm font-medium text-fuchsia-100 transition hover:bg-fuchsia-500/25"
          >
            <ExternalLink className="h-4 w-4" />
            Open Full Discord in Browser
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
      {downloading ? <p className="mt-2 text-xs text-cyan-100/90">Installing selected download...</p> : null}
      {downloadError ? <p className="mt-2 text-xs text-rose-200/90">Download install failed: {downloadError}</p> : null}
      {localInstallStatus ? <p className="mt-2 text-xs text-emerald-200/90">{localInstallStatus}</p> : null}
      <p className="mt-2 text-xs text-slate-300/85">
        Discord blocks iframe embeds, so this tab uses a native webview profile instead of an iframe.
      </p>
      <p className="mt-1 text-xs text-slate-300/85">Download mode: In-app managed download.</p>
      {lastCapturedUrl ? <p className="mt-1 text-xs text-slate-300/85">Last captured URL: {lastCapturedUrl}</p> : null}
      <p className="mt-1 text-xs text-slate-300/85">
        Capture diagnostics: {captureCount} event{captureCount === 1 ? "" : "s"} received{lastCaptureAt ? `, last at ${new Date(lastCaptureAt).toLocaleTimeString()}` : ""}.
      </p>
    </section>
  );
}
