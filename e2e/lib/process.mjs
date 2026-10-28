// Process/journal helpers for the recovery scenario (R8 deliverable 1: "kill mid-edit, journal
// replay"). CONTRACTS §8: the autosave journal lives at
// `%LOCALAPPDATA%\Rubrica\journal\<doc-hash>.jsonl` in production, deleted only on a clean
// save/close — killing the process outright (rather than closing the WebDriver session normally)
// is what leaves one behind for the next launch's `recovery_available` startup scan to find. This
// suite never touches that real, per-machine location: `run.mjs` points every app launch it
// spawns at the isolated directories `e2eJournalDir()`/`e2eAppDataDir()` resolve to (via
// RUBRICA_JOURNAL_DIR/RUBRICA_APPDATA_DIR), and the helpers below read the same two functions —
// so this file and the running app always agree on where "this run's data" lives, and a local
// `pnpm e2e` can never wipe a developer's own crash-recovery journal, recents, or prefs.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { defaultAppPath, e2eAppDataDir, e2eJournalDir } from "./paths.mjs";

export function journalDir() {
  return e2eJournalDir();
}

/** Deletes any pre-existing journal files so a leftover from an earlier (e.g. interrupted) test run can't be mistaken for this scenario's own — CONTRACTS' journal_recover(None) resolves to "the most-recent orphaned journal on disk", which would otherwise be ambiguous. */
export function clearJournals() {
  const dir = journalDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) rmSync(path.join(dir, file), { force: true });
}

export function hasJournal() {
  const dir = journalDir();
  return existsSync(dir) && readdirSync(dir).length > 0;
}

/**
 * Deletes this run's own isolated SQLite store (recents + prefs, CONTRACTS §8), resetting
 * language/theme/night-mode/etc. to their defaults for every launch this suite makes. A real leak
 * this suite found in itself: 08-i18n-smoke.e2e.mjs's language switch calls the real `prefs_set`,
 * which persists across app restarts by design (it's not a per-session/per-test setting) — left
 * alone, a prior run's "switch to English" step makes EVERY subsequent launch (this run's own
 * earlier specs included, since Home screen text is pt-PT-only there) boot in English and fail
 * from their first pt-PT selector. That spec's own `after` hook switches back, but resetting here
 * too means one crashed/interrupted run can't wreck the next.
 */
export function resetAppData() {
  const dbDir = e2eAppDataDir();
  if (!existsSync(dbDir)) return;
  for (const file of readdirSync(dbDir)) {
    if (file.startsWith("rubrica.db")) rmSync(path.join(dbDir, file), { force: true });
  }
}

/**
 * Force-kills only the rubrica.exe process this run's own app path resolves to — simulates a
 * crash/power-loss mid-edit, as opposed to the graceful close a normal WebDriver session end
 * performs (which would go through doc_save/journal cleanup and defeat the point of this
 * scenario). Deliberately NOT a bare `taskkill /IM rubrica.exe` — that kills *every* process with
 * that image name, real user data (an unrelated already-running Rubrica window) included. Matches
 * on the exact executable path (`RUBRICA_E2E_EXE`/the default debug build path) via a CIM query,
 * not just the name, before killing.
 */
export function killApp() {
  const exePath = defaultAppPath();
  try {
    const script = `Get-CimInstance Win32_Process -Filter "Name='rubrica.exe'" | Where-Object { $_.ExecutablePath -eq '${exePath.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
  } catch {
    // Nothing matched, or PowerShell itself errored — either way, nothing more to do here.
  }
}
