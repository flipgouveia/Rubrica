// The IPC side of search (CONTRACTS §3 text_search_start / text_search_cancel + `search_batch`),
// kept out of React so it is testable and so lifecycle rules live in one place:
//   - the CLIENT mints the searchId and adopts it in the store before awaiting the command, so a
//     batch emitted before the command resolves is never dropped (B1);
//   - closing, unmounting or superseding a search cancels the running one and clears the debounce
//     timer (B3);
//   - the search key includes the document revision, so an edit invalidates stale results and
//     re-runs the search (B4).
import { commands, events } from "../../ipc";
import { getTabByDocId, useViewerStore } from "../store";
import type { DocId } from "../types";
import { currentQueryBuild, searchKeyFor } from "./searchQuery";
import { useSearchPrefs } from "./searchPrefs";
import { getDocSearch, useSearchStore, type SearchMode } from "./searchStore";

export const DEBOUNCE_MS = 250;
export const PREF_LAST_MODE = "search.lastMode";
export const PREF_PANEL_WIDTH = "search.panelWidth";

const timers = new Map<DocId, number>();

export function currentRevision(docId: DocId): number {
  return getTabByDocId(docId)?.info.revision ?? 0;
}

function clearTimer(docId: DocId): void {
  const timer = timers.get(docId);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(docId);
}

/** Cancels the running search of a document (if any) and any pending debounced start. */
export function cancelSearch(docId: DocId): void {
  clearTimer(docId);
  const doc = getDocSearch(docId);
  if (doc?.searchId && !doc.done) void commands.textSearchCancel(doc.searchId);
}

/**
 * Starts a search right now, superseding (and cancelling) a running one. The query is rebuilt from the
 * stores at this very moment (mode, window, scope, accents… — see searchQuery.ts), so the search
 * key stored with the results is the one the React effect compares against.
 */
export async function runSearchNow(docId: DocId): Promise<void> {
  clearTimer(docId);
  const doc = getDocSearch(docId);
  if (!doc || !doc.isOpen) return;
  const build = currentQueryBuild(docId);
  if (!build?.ok) return;
  if (doc.searchId && !doc.done) void commands.textSearchCancel(doc.searchId);

  const searchId = crypto.randomUUID();
  const revision = currentRevision(docId);
  useSearchStore.getState().startNewSearch(docId, searchId, { key: searchKeyFor(build.query, revision), revision, query: build.query });
  try {
    const result = await commands.textSearchStart(docId, searchId, build.query);
    if (result.status === "error") {
      const { code, message } = result.error;
      useSearchStore.getState().finishWithError(docId, searchId, { kind: code === "INVALID_ARG" ? "invalid" : "failed", message });
    }
  } catch (error) {
    useSearchStore.getState().finishWithError(docId, searchId, { kind: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}

/** Debounced `runSearchNow`; typing restarts the window. */
export function scheduleSearch(docId: DocId): void {
  clearTimer(docId);
  timers.set(
    docId,
    window.setTimeout(() => {
      timers.delete(docId);
      void runSearchNow(docId);
    }, DEBOUNCE_MS),
  );
}

/** Closes a document's search UI: cancels what is running and drops the results. */
export function closeSearch(docId: DocId): void {
  cancelSearch(docId);
  useSearchStore.getState().close(docId);
}

/** Cancels every running search and pending timer (the panel is going away). */
export function cancelAllSearches(): void {
  for (const docId of Object.keys(useSearchStore.getState().byDoc)) cancelSearch(docId);
}

let modeTouched = false;

/** Switches between the compact bar and the docked panel and remembers the choice. */
export function setSearchMode(mode: SearchMode): void {
  modeTouched = true;
  useSearchStore.getState().setMode(mode);
  void commands.prefsSet(PREF_LAST_MODE, mode);
}

export function persistPanelWidth(width: number): void {
  void commands.prefsSet(PREF_PANEL_WIDTH, String(width));
}

async function loadPrefs(): Promise<void> {
  void useSearchPrefs.getState().load();
  const [mode, width] = await Promise.all([commands.prefsGet(PREF_LAST_MODE), commands.prefsGet(PREF_PANEL_WIDTH)]);
  if (!modeTouched && mode.status === "ok" && (mode.data === "compact" || mode.data === "docked")) {
    useSearchStore.getState().setMode(mode.data);
  }
  if (width.status === "ok" && width.data !== null && Number.isFinite(Number(width.data))) {
    useSearchStore.getState().setPanelWidth(Number(width.data));
  }
}

/**
 * Wires the app-wide pieces: the single `search_batch` listener, the "tab closed" cleanup and the
 * persisted mode/width. Returns the teardown (which also cancels everything still running).
 */
export function startSearchEngine(): () => void {
  modeTouched = false;
  void loadPrefs();

  const unlistenPromise = events.searchBatch.listen((event) => useSearchStore.getState().addBatch(event.payload));

  const unsubscribeTabs = useViewerStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs) return;
    const open = new Set(state.tabs.map((tab) => tab.docId));
    for (const docId of Object.keys(useSearchStore.getState().byDoc)) {
      if (open.has(docId)) continue;
      cancelSearch(docId);
      useSearchStore.getState().removeDoc(docId);
    }
  });

  return () => {
    unsubscribeTabs();
    cancelAllSearches();
    void unlistenPromise.then((unlisten) => unlisten());
  };
}
