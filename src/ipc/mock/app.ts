// Mock implementation of the "app" domain: recents, prefs, print, journal
// recovery (CONTRACTS §3's last bullet). CONTRACTS §5 only names owner files
// for document/render/text/history and annotations/pages/forms and
// textedit/redact — the app-domain commands aren't assigned a home there,
// so this file follows the same one-module-per-domain convention to cover
// them (a deviation worth flagging: not in CONTRACTS' explicit list, but
// necessary since "every single command must have a working mock").
//
// Storage: `localStorage`, since there's no real SQLite in mock mode (our
// call, per the task brief) — wrapped in try/catch so a restrictive
// environment (private browsing, disabled storage) degrades to "empty"
// rather than throwing.
import type { RecentDoc, RecoveryInfo } from "../bindings";
import { type CommandResult, ok } from "./state";

const RECENTS_KEY = "rubrica:mock:recents";
const PREFS_KEY_PREFIX = "rubrica:mock:prefs:";
const MAX_RECENTS = 20;

function readRecents(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentDoc[]) : [];
  } catch {
    return [];
  }
}

function writeRecents(list: RecentDoc[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable (e.g. private browsing quota) — silently drop.
  }
}

/**
 * Internal wiring (not part of the CONTRACTS command surface): `doc_open`
 * calls this so `recents_list` has something real to show after using the
 * demo. Kept here, next to the storage it writes to.
 */
export function recordRecent(path: string, lastPage = 0, lastZoom: number | null = null): void {
  if (!path) return;
  const existing = readRecents().filter((r) => r.path !== path);
  const entry: RecentDoc = { path, lastOpenedAt: new Date().toISOString(), lastPage, lastZoom };
  writeRecents([entry, ...existing].slice(0, MAX_RECENTS));
}

export async function recentsList(): Promise<CommandResult<RecentDoc[]>> {
  return ok(readRecents());
}

export async function recentsClear(): Promise<CommandResult<null>> {
  writeRecents([]);
  return ok(null);
}

function prefKey(key: string): string {
  return `${PREFS_KEY_PREFIX}${key}`;
}

export async function prefsGet(key: string): Promise<CommandResult<string | null>> {
  try {
    return ok(localStorage.getItem(prefKey(key)));
  } catch {
    return ok(null);
  }
}

export async function prefsSet(key: string, value: string): Promise<CommandResult<null>> {
  try {
    localStorage.setItem(prefKey(key), value);
  } catch {
    // Storage unavailable — the mock silently no-ops rather than failing the caller.
  }
  return ok(null);
}

/**
 * There is no real filesystem in the mock, so this fabricates plausible
 * temp-file paths rather than returning UNSUPPORTED — good enough for a UI
 * building the print flow against.
 */
export async function printRender(docId: string, pages: number[], dpi: number): Promise<CommandResult<string[]>> {
  const paths = pages.map((page) => `mock://print/${docId}/page-${page + 1}-${dpi}dpi.png`);
  return ok(paths);
}

/** The mock never has a crash journal to recover — always reports "nothing available", which is valid data, not UNSUPPORTED. */
export async function journalRecover(docId: string | null): Promise<CommandResult<RecoveryInfo>> {
  void docId; // signature parity with the real command; nothing to look up in mock mode.
  return ok({ available: false, path: null, journalId: null, savedAt: null });
}
