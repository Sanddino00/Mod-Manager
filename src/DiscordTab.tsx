import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, RefreshCw } from "lucide-react";

const DISCORD_WEBVIEW_LABEL = "discord-browser-view";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = {
  rememberWebSessions: boolean;
};

export function DiscordTab({ rememberWebSessions }: Props) {
  const [browserUrl, setBrowserUrl] = useState("https://discord.com/app");
  const [addressInput, setAddressInput] = useState("https://discord.com/app");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [webviewReady, setWebviewReady] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [profileId] = useState(() => `discord-profile-temp-${Date.now()}-${Math.floor(Math.random() * 10000)}`);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<Webview | null>(null);
  const canUseNativeWebview = isTauriRuntime();

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
      <p className="mt-2 text-xs text-slate-300/85">
        Discord blocks iframe embeds, so this tab uses a native webview profile instead of an iframe.
      </p>
    </section>
  );
}
