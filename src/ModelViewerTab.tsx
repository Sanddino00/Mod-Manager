import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Props = {
  gameModPath: string;
  language: "en" | "de";
};

type ViewerBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
};

function getViewerBounds(element: HTMLElement): ViewerBounds {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.left,
    y: bounds.top,
    width: bounds.width,
    height: bounds.height,
    scaleFactor: window.devicePixelRatio || 1,
  };
}

export function ModelViewerTab({ gameModPath, language }: Props) {
  const rootRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewerRunningRef = useRef(false);
  const [viewerRunning, setViewerRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listen("model-viewer-closed", () => {
      viewerRunningRef.current = false;
      setViewerRunning(false);
      setBusy(false);
    })
      .then((stopListening) => {
        if (cancelled) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((reason) => {
        console.error("Could not listen for model viewer shutdown events.", reason);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!viewerRunning) setError(null);
  }, [gameModPath, viewerRunning]);

  useEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    if (!viewerRunning || !root || !viewport) {
      return;
    }

    const updateBounds = () => {
      void invoke("position_model_viewer", getViewerBounds(viewport)).catch((reason) => {
        const detail = reason instanceof Error ? reason.message : String(reason);
        setError(language === "de"
          ? `Der eingebettete Modell-Viewer konnte nicht positioniert werden: ${detail}`
          : `Could not position the embedded model viewer: ${detail}`);
      });
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(root);
    observer.observe(viewport);
    window.addEventListener("resize", updateBounds);
    window.addEventListener("scroll", updateBounds, true);
    updateBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      window.removeEventListener("scroll", updateBounds, true);
    };
  }, [language, viewerRunning]);

  useEffect(() => () => {
    if (viewerRunningRef.current) {
      void invoke("close_model_viewer").catch((reason) => {
        console.error("Could not close the embedded model viewer.", reason);
      });
    }
  }, []);

  async function launchViewer() {
    const startDirectory = gameModPath.trim();
    if (!startDirectory) {
      setError(language === "de"
        ? "Für dieses Spiel ist kein Mod-Ordner konfiguriert. Lege ihn zuerst in den Einstellungen fest."
        : "No mod folder is configured for this game. Set one in Settings first.");
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      setError(language === "de" ? "Der Modell-Viewer-Bereich ist nicht verfügbar." : "The model viewer area is not available.");
      return;
    }

    setBusy(true);
    setError(null);
    viewerRunningRef.current = true;
    try {
      await invoke<string>("open_model_viewer", {
        startDirectory,
        ...getViewerBounds(viewport),
      });
      setViewerRunning(true);
    } catch (reason) {
      viewerRunningRef.current = false;
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(language === "de"
        ? `Der Modell-Viewer konnte nicht geöffnet werden: ${detail}`
        : `Could not open the model viewer: ${detail}`);
    } finally {
      setBusy(false);
    }
  }

  async function closeViewer() {
    setBusy(true);
    setError(null);
    try {
      await invoke("close_model_viewer");
      viewerRunningRef.current = false;
      setViewerRunning(false);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(language === "de"
        ? `Der Modell-Viewer konnte nicht geschlossen werden: ${detail}`
        : `Could not close the model viewer: ${detail}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section ref={rootRef} className="mt-6 grid gap-4">
      <header className="rounded-[28px] border border-white/10 bg-slate-950/45 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold text-white">
              {language === "de" ? "3DMigoto Modell-Viewer" : "3DMigoto Model Viewer"}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              {language === "de"
                ? "Öffnet den Viewer mit dem Mod-Ordner des ausgewählten Spiels als Startordner für die interne Ordnerauswahl. Die EXE wird über das reguläre Ressourcen-Update installiert und ersetzt."
                : "Opens the viewer with the selected game's mod folder as the starting location for its built-in folder picker. The executable is installed and replaced through the regular resources update."}
            </p>
            <p className="mt-3 break-all text-xs text-slate-400">
              {gameModPath || (language === "de"
                ? "Für das ausgewählte Spiel ist kein Mod-Ordner konfiguriert."
                : "No mod folder is configured for the selected game.")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {viewerRunning ? (
              <button
                type="button"
                onClick={() => void closeViewer()}
                disabled={busy}
                className="rounded-full border border-rose-300/25 bg-rose-500/15 px-4 py-2 text-sm text-rose-100 hover:bg-rose-500/25 disabled:opacity-60"
              >
                {busy
                  ? (language === "de" ? "Wird geschlossen…" : "Closing…")
                  : (language === "de" ? "Viewer schließen" : "Close viewer")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void launchViewer()}
                disabled={busy}
                className="rounded-full border border-cyan-300/30 bg-cyan-500/20 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-60"
              >
                {busy
                  ? (language === "de" ? "Wird geöffnet…" : "Opening…")
                  : (language === "de" ? "Viewer öffnen" : "Open viewer")}
              </button>
            )}
          </div>
        </div>
      </header>

      {error ? (
        <p role="alert" className="rounded-2xl border border-rose-300/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </p>
      ) : null}

      <div
        ref={viewportRef}
        className="relative min-h-[480px] overflow-hidden rounded-[24px] border border-white/12 bg-slate-950/70"
        style={{ height: "calc(100vh - 240px)" }}
      >
        {!viewerRunning ? (
          <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-slate-400">
            {busy
              ? (language === "de" ? "Modell-Viewer wird gestartet…" : "Starting the model viewer…")
              : (language === "de" ? "Der Modell-Viewer wird hier angezeigt." : "The model viewer will appear here.")}
          </div>
        ) : null}
      </div>
    </section>
  );
}
