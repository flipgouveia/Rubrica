// Shared path resolution for the e2e suite. Everything here is an absolute path — the app exe is
// spawned directly by tauri-driver (not via `pnpm tauri dev`/`cargo run`), so there is no
// guarantee about its working directory, and `doc_open` / `docSaveAs` calls need paths that
// resolve correctly regardless of where the process happens to start from.
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const E2E_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(E2E_DIR);
export const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");

export function fixture(name) {
  return path.join(FIXTURES_DIR, name);
}

/** Where a debug build's exe lands (`pnpm tauri build --debug` / `cargo build`). Override via RUBRICA_E2E_EXE for a release build or a CI-specific path. */
export function defaultAppPath() {
  return process.env.RUBRICA_E2E_EXE ?? path.join(REPO_ROOT, "src-tauri", "target", "debug", "rubrica.exe");
}

/** Scratch directory for this run's output artifacts (saved PDFs, etc.) — never fixtures/ itself, so the checked-in corpus stays pristine. */
export function scratchDir() {
  return process.env.RUBRICA_E2E_SCRATCH ?? path.join(REPO_ROOT, "e2e", ".scratch");
}

/** Absolute path for a scratch output file, creating the scratch directory on first use. Every mutating spec's `saveAs` destination + reopen-to-verify target should go through this — never a plain `save()` over a path under `fixtures/` (see actions.mjs's `save`/`saveAs` doc comments for the real accumulation bug this replaced). */
export function scratchPath(name) {
  const dir = scratchDir();
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/**
 * Isolated journal/app-data directories for this run's own app launches — never the developer
 * machine's real `%LOCALAPPDATA%\Rubrica\journal` / `%APPDATA%\Rubrica`. `run.mjs` sets
 * `RUBRICA_JOURNAL_DIR`/`RUBRICA_APPDATA_DIR` to these paths on the spawned app's environment
 * (`engine::journal`/`store` read them); `process.mjs`'s journal/app-data helpers read the same
 * two functions, so both sides always agree on where "this run's data" actually lives. Before
 * this, `onPrepare`/`killApp` operated on the real per-machine paths and a real running app name
 * — a local `pnpm e2e` could wipe a developer's own crash-recovery journal, recents, and prefs,
 * or kill an unrelated already-running Rubrica window.
 */
export function e2eJournalDir() {
  return path.join(scratchDir(), "journal");
}

export function e2eAppDataDir() {
  return path.join(scratchDir(), "appdata");
}
