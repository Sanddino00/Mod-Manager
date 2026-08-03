import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  ChevronRight,
  Download,
  Folder,
  FolderTree,
  Gamepad2,
  Loader2,
  Monitor,
  Settings2,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";
import { GAME_ORDER, GAMES } from "./config/games";
import type { BootstrapState, GameKey } from "./types";

interface Props {
  state: BootstrapState;
  onComplete: () => void | Promise<void>;
}

type Step = "welcome" | "games" | "scaffold" | "installing" | "done";

const SHELL =
  "min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.12),_transparent_28%),radial-gradient(circle_at_84%_12%,_rgba(34,197,94,0.10),_transparent_24%),linear-gradient(180deg,_#020617_0%,_#0b1220_52%,_#030712_100%)] text-slate-100";
const PANEL =
  "rounded-2xl border border-slate-700/45 bg-slate-950/62 shadow-[0_22px_80px_rgba(2,6,20,0.40)]";
const CARD =
  "rounded-xl border border-slate-700/35 bg-slate-900/55 p-4";
const BTN_PRIMARY =
  "inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_SECONDARY =
  "inline-flex items-center gap-2 rounded-xl border border-slate-600/60 bg-slate-800/60 px-5 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-slate-700/70 disabled:opacity-50";

export function SetupWizard({ state, onComplete }: Props) {
  const [step, setStep] = useState<Step>("welcome");

  // Step: welcome
  const [installDir, setInstallDir] = useState(state.legacy_install?.base_dir ?? state.exe_dir);

  // Step: games — pre-fill from existing settings if available
  const [selectedGames, setSelectedGames] = useState<Set<GameKey>>(() => {
    const existing = Object.entries(state.settings.mod_paths ?? {})
      .filter(([, p]) => p?.trim())
      .map(([id]) => id as GameKey);
    return new Set(existing.length > 0 ? existing : (["gi"] as GameKey[]));
  });
  const [modPaths, setModPaths] = useState<Partial<Record<GameKey, string>>>(
    () => ({ ...(state.settings.mod_paths ?? {}) })
  );

  // Step: scaffold
  const [scaffoldGames, setScaffoldGames] = useState<Set<GameKey>>(new Set());
  const [createShortcut, setCreateShortcut] = useState(false);

  // Step: installing
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);

  async function pickDir(current: string, setter: (v: string) => void) {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: current.trim() ? current : undefined,
      title: "Select folder",
    });
    if (!picked) return;
    setter(Array.isArray(picked) ? (picked[0] ?? current) : picked);
  }

  function toggleGame(id: GameKey) {
    setSelectedGames((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleScaffold(id: GameKey) {
    setScaffoldGames((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runInstall() {
    setStep("installing");
    setInstallLog([]);
    setInstallError(null);

    const log = (msg: string) => setInstallLog((prev) => [...prev, msg]);

    try {
      log("Checking for latest release...");
      const info = await invoke<{
        available: boolean;
        latest_tag: string;
        app_latest_tag?: string;
        resources_latest_tag?: string;
        resources_url: string | null;
        exe_url: string | null;
        updater_url: string | null;
      }>("check_for_updates", { force: false });

      if (!info.updater_url || !info.resources_url) {
        setInstallError("Could not fetch release assets. Check your internet connection.");
        return;
      }

      const paths: Record<string, string> = {};
      for (const gameId of selectedGames) {
        const p = modPaths[gameId]?.trim();
        if (p) paths[gameId] = p;
      }

      log("Downloading updater and resources (this may take a moment)...");
      const installedPath = await invoke<string>("bootstrap_installation", {
        installDir,
        updaterUrl: info.updater_url,
        resourcesUrl: info.resources_url,
        appTag: info.app_latest_tag ?? info.latest_tag ?? null,
        resourcesTag: info.resources_latest_tag ?? null,
        createDesktopShortcutFlag: createShortcut,
        gameModPaths: Object.keys(paths).length > 0 ? paths : null,
      });

      log(`Resources installed at ${installedPath}`);

      for (const gameId of scaffoldGames) {
        const modRoot = paths[gameId];
        if (!modRoot) continue;
        log(`Creating folder scaffold for ${GAMES[gameId].name}...`);
        try {
          await invoke("create_mod_folder_scaffold", { game: gameId, modRoot });
        } catch (scaffoldErr) {
          log(`  Warning: scaffold for ${GAMES[gameId].name} failed — ${String(scaffoldErr)}`);
        }
      }

      log("Setup complete!");
      setStep("done");
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <main className={clsx(SHELL, "flex min-h-dvh items-start justify-center px-4 py-10")}>
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs uppercase tracking-[0.3em] text-cyan-100">
            <Sparkles className="h-3.5 w-3.5" />
            First-time Setup
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">Mod Manager v2</h1>
          <p className="mt-2 text-xs text-slate-500">
            Already set up?{" "}
            <button
              onClick={onComplete}
              className="text-cyan-400 underline-offset-2 hover:underline"
            >
              Skip and open the manager
            </button>
          </p>
        </div>

        <div className={clsx(PANEL, "p-6")}>
          {/* Step indicators */}
          <div className="flex items-center justify-between gap-3">
            <StepBar current={step} />
            {step !== "done" ? (
              <button
                type="button"
                onClick={onComplete}
                className={clsx(BTN_SECONDARY, "shrink-0")}
              >
                Skip Setup
              </button>
            ) : null}
          </div>

          <div className="mt-8">
            {step === "welcome" && (
              <WelcomeStep
                installDir={installDir}
                setInstallDir={setInstallDir}
                onPickDir={() => pickDir(installDir, setInstallDir)}
                onNext={() => setStep("games")}
              />
            )}

            {step === "games" && (
              <GamesStep
                selectedGames={selectedGames}
                modPaths={modPaths}
                onToggleGame={toggleGame}
                onSetPath={(id, path) => setModPaths((p) => ({ ...p, [id]: path }))}
                onPickDir={(id) =>
                  pickDir(modPaths[id] ?? "", (v) => setModPaths((p) => ({ ...p, [id]: v })))
                }
                onBack={() => setStep("welcome")}
                onNext={() => setStep("scaffold")}
              />
            )}

            {step === "scaffold" && (
              <ScaffoldStep
                selectedGames={selectedGames}
                modPaths={modPaths}
                scaffoldGames={scaffoldGames}
                createShortcut={createShortcut}
                onToggleScaffold={toggleScaffold}
                onToggleShortcut={() => setCreateShortcut((v) => !v)}
                onBack={() => setStep("games")}
                onInstall={runInstall}
              />
            )}

            {step === "installing" && (
              <InstallingStep log={installLog} error={installError} onRetry={() => setStep("scaffold")} />
            )}

            {step === "done" && <DoneStep onLaunch={onComplete} />}
          </div>
        </div>
      </div>
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Install Path" },
  { id: "games", label: "Games" },
  { id: "scaffold", label: "Finish" },
  { id: "installing", label: "Installing" },
  { id: "done", label: "Done" },
];

const STEP_ORDER: Step[] = ["welcome", "games", "scaffold", "installing", "done"];

function StepBar({ current }: { current: Step }) {
  const currentIndex = STEP_ORDER.indexOf(current);
  return (
    <div className="flex items-center gap-1">
      {STEPS.map((s, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <div key={s.id} className="flex flex-1 items-center gap-1">
            <div
              className={clsx(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                done
                  ? "bg-cyan-500 text-slate-950"
                  : active
                    ? "border-2 border-cyan-400 text-cyan-300"
                    : "border border-slate-600 text-slate-500"
              )}
            >
              {done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
            </div>
            <span
              className={clsx(
                "hidden text-xs sm:block",
                active ? "text-slate-200" : done ? "text-cyan-400" : "text-slate-500"
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <div className={clsx("h-px flex-1", done ? "bg-cyan-500/60" : "bg-slate-700/70")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function WelcomeStep({
  installDir,
  setInstallDir,
  onPickDir,
  onNext,
}: {
  installDir: string;
  setInstallDir: (v: string) => void;
  onPickDir: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-base font-semibold text-slate-100">
          <Settings2 className="h-5 w-5 text-cyan-400" />
          Install Location
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          This is where resources, the updater, and your settings will be stored. The app
          executable is already installed by the installer — only the data folder is set up here.
        </p>
      </div>

      <div className={CARD}>
        <label className="mb-1.5 block text-xs uppercase tracking-widest text-slate-400">
          Install base directory
        </label>
        <div className="flex items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-slate-600/60 bg-slate-800/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500/70"
            value={installDir}
            onChange={(e) => setInstallDir(e.target.value)}
          />
          <button onClick={onPickDir} className={BTN_SECONDARY}>
            <Folder className="h-4 w-4" />
            Browse
          </button>
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Resources will be placed at: <span className="text-slate-300">{installDir || "…"}\resources</span>
        </p>
      </div>

      <div className="flex justify-end">
        <button onClick={onNext} disabled={!installDir.trim()} className={BTN_PRIMARY}>
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function GamesStep({
  selectedGames,
  modPaths,
  onToggleGame,
  onSetPath,
  onPickDir,
  onBack,
  onNext,
}: {
  selectedGames: Set<GameKey>;
  modPaths: Partial<Record<GameKey, string>>;
  onToggleGame: (id: GameKey) => void;
  onSetPath: (id: GameKey, path: string) => void;
  onPickDir: (id: GameKey) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-base font-semibold text-slate-100">
          <Gamepad2 className="h-5 w-5 text-cyan-400" />
          Game Configuration
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Select which games you want to manage and set the mod folder path for each. You can
          change these later in Settings.
        </p>
      </div>

      <div className="space-y-3">
        {GAME_ORDER.map((gameId) => {
          const game = GAMES[gameId];
          const active = selectedGames.has(gameId);
          return (
            <div
              key={gameId}
              className={clsx(
                CARD,
                "transition",
                active ? "border-cyan-500/40 bg-slate-900/70" : "opacity-60"
              )}
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id={`game-${gameId}`}
                  checked={active}
                  onChange={() => onToggleGame(gameId)}
                  className="h-4 w-4 accent-cyan-400"
                />
                <label htmlFor={`game-${gameId}`} className="flex-1 cursor-pointer">
                  <div className="text-sm font-semibold text-slate-100">{game.name}</div>
                  <div className="text-xs text-slate-500">{game.shortLabel}</div>
                </label>
              </div>

              {active && (
                <div className="mt-3 flex items-center gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-lg border border-slate-600/60 bg-slate-800/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500/70"
                    placeholder="Mod folder path (optional)"
                    value={modPaths[gameId] ?? ""}
                    onChange={(e) => onSetPath(gameId, e.target.value)}
                  />
                  <button onClick={() => onPickDir(gameId)} className={BTN_SECONDARY}>
                    <Folder className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-between">
        <button onClick={onBack} className={BTN_SECONDARY}>
          Back
        </button>
        <button onClick={onNext} disabled={selectedGames.size === 0} className={BTN_PRIMARY}>
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ScaffoldStep({
  selectedGames,
  modPaths,
  scaffoldGames,
  createShortcut,
  onToggleScaffold,
  onToggleShortcut,
  onBack,
  onInstall,
}: {
  selectedGames: Set<GameKey>;
  modPaths: Partial<Record<GameKey, string>>;
  scaffoldGames: Set<GameKey>;
  createShortcut: boolean;
  onToggleScaffold: (id: GameKey) => void;
  onToggleShortcut: () => void;
  onBack: () => void;
  onInstall: () => void;
}) {
  const gamesWithPaths = GAME_ORDER.filter(
    (id) => selectedGames.has(id) && modPaths[id]?.trim()
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-base font-semibold text-slate-100">
          <FolderTree className="h-5 w-5 text-cyan-400" />
          Folder Scaffold &amp; Shortcut
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Optionally create the standard character/weapon/etc. subfolders in each mod folder
          now. You can also do this later from the Settings page.
        </p>
      </div>

      {gamesWithPaths.length > 0 && (
        <div className={CARD}>
          <div className="mb-3 text-xs uppercase tracking-widest text-slate-400">
            Create folder scaffold
          </div>
          <div className="space-y-2">
            {gamesWithPaths.map((gameId) => (
              <label key={gameId} className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={scaffoldGames.has(gameId)}
                  onChange={() => onToggleScaffold(gameId)}
                  className="h-4 w-4 accent-cyan-400"
                />
                <span className="text-sm text-slate-200">{GAMES[gameId].name}</span>
                <span className="truncate text-xs text-slate-500">{modPaths[gameId]}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className={CARD}>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={createShortcut}
            onChange={onToggleShortcut}
            className="h-4 w-4 accent-cyan-400"
          />
          <Monitor className="h-4 w-4 text-slate-400" />
          <span className="text-sm text-slate-200">Create a desktop shortcut</span>
        </label>
      </div>

      <div className="flex justify-between">
        <button onClick={onBack} className={BTN_SECONDARY}>
          Back
        </button>
        <button onClick={onInstall} className={BTN_PRIMARY}>
          <Download className="h-4 w-4" />
          Install
        </button>
      </div>
    </div>
  );
}

function InstallingStep({
  log,
  error,
  onRetry,
}: {
  log: string[];
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        {error ? (
          <div className="h-7 w-7 shrink-0 rounded-full bg-red-500/20 p-1 text-red-400">✕</div>
        ) : (
          <Loader2 className="h-6 w-6 shrink-0 animate-spin text-cyan-400" />
        )}
        <div className="text-base font-semibold text-slate-100">
          {error ? "Setup failed" : "Setting up…"}
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-700/50 bg-slate-900/80 p-3 font-mono text-xs leading-6 text-slate-300">
        {log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        {!error && log.length === 0 && <div className="text-slate-500">Starting…</div>}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {error && (
        <div className="flex justify-end">
          <button onClick={onRetry} className={BTN_SECONDARY}>
            Back &amp; Retry
          </button>
        </div>
      )}
    </div>
  );
}

function DoneStep({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="space-y-6 text-center">
      <div className="flex justify-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-cyan-500/15 ring-2 ring-cyan-500/40">
          <CheckCircle2 className="h-8 w-8 text-cyan-400" />
        </div>
      </div>
      <div>
        <div className="text-xl font-semibold text-slate-100">Setup complete!</div>
        <p className="mt-2 text-sm text-slate-400">
          Resources and the updater are installed. Your mod manager is ready to use.
        </p>
      </div>
      <button onClick={onLaunch} className={clsx(BTN_PRIMARY, "mx-auto")}>
        Launch Manager
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
