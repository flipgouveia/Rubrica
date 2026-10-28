// Search UI root, mounted once by AppShell for the active tab. It owns the React wiring only:
// the app-wide engine hooks (batch listener, persisted mode), the keyboard shortcuts, the debounced
// (re)search effect and "scroll to the active hit". The IPC lives in `searchController.ts`, the
// state in `searchStore.ts` (per document), and the two layouts in `SearchBar.tsx` (compact, a
// floating line over the viewer's margin) and `SearchDock.tsx` (a resizable right column).
import { useEffect, useRef } from "react";
import { registerShortcut } from "../../chrome/shortcuts";
import { useViewerStore } from "../store";
import type { DocId } from "../types";
import { SearchBar } from "./SearchBar";
import { SearchDock } from "./SearchDock";
import { cancelSearch, closeSearch, scheduleSearch, setSearchMode, startSearchEngine } from "./searchController";
import { COMPACT_BAR_INSET, DOCKED_INSET, scrollToHit } from "./scrollToHit";
import { useSearchPrefs } from "./searchPrefs";
import { searchKeyFor, useSearchQuery } from "./searchQuery";
import { useSearchStore } from "./searchStore";

function activeDocId(): DocId | null {
  return useViewerStore.getState().activeTabId;
}

function isOpenFor(docId: DocId | null): docId is DocId {
  return docId !== null && Boolean(useSearchStore.getState().byDoc[docId]?.isOpen);
}

/** Registers the search shortcuts through the central map (collisions are asserted by shortcuts.collisions.test.tsx). */
function registerSearchShortcuts(): () => void {
  const unregisters = [
    registerShortcut({
      id: "viewer.search.open",
      keys: "ctrl+f",
      labelKey: "viewer:viewer.shortcuts.search",
      allowInFormFields: true,
      handler: () => {
        const docId = activeDocId();
        if (docId) useSearchStore.getState().open(docId);
      },
    }),
    registerShortcut({
      id: "viewer.search.openPanel",
      keys: "ctrl+shift+f",
      labelKey: "viewer:viewer.shortcuts.searchPanel",
      allowInFormFields: true,
      handler: () => {
        const docId = activeDocId();
        if (!docId) return;
        useSearchStore.getState().open(docId);
        setSearchMode("docked");
      },
    }),
    registerShortcut({
      id: "viewer.search.next",
      keys: "f3",
      labelKey: "viewer:viewer.shortcuts.searchNext",
      allowInFormFields: true,
      handler: () => {
        const docId = activeDocId();
        if (isOpenFor(docId)) useSearchStore.getState().nextMatch(docId);
      },
    }),
    registerShortcut({
      id: "viewer.search.previous",
      keys: "shift+f3",
      labelKey: "viewer:viewer.shortcuts.searchPrevious",
      allowInFormFields: true,
      handler: () => {
        const docId = activeDocId();
        if (isOpenFor(docId)) useSearchStore.getState().prevMatch(docId);
      },
    }),
    registerShortcut({
      id: "viewer.search.toggleMode",
      keys: "alt+p",
      labelKey: "viewer:viewer.shortcuts.searchToggleMode",
      allowInFormFields: true,
      handler: () => {
        if (isOpenFor(activeDocId())) useSearchPrefs.getState().toggleMode();
      },
    }),
    registerShortcut({
      id: "viewer.search.close",
      keys: "escape",
      labelKey: "viewer:viewer.shortcuts.searchClose",
      // Not "always": Escape is already the "clear selection" shortcut (an "always" one) and both
      // are meant to fire. The registry fires every handler bound to a combo regardless of scope.
      scope: "tool-active",
      allowInFormFields: true,
      handler: () => {
        const docId = activeDocId();
        if (isOpenFor(docId)) closeSearch(docId);
      },
    }),
  ];
  return () => unregisters.forEach((unregister) => unregister());
}

interface SearchPanelProps {
  docId: DocId;
}

export function SearchPanel({ docId }: SearchPanelProps) {
  const mode = useSearchStore((s) => s.mode);
  const isOpen = useSearchStore((s) => s.byDoc[docId]?.isOpen ?? false);
  const searchKey = useSearchStore((s) => s.byDoc[docId]?.searchKey ?? null);
  const focusRequest = useSearchStore((s) => s.byDoc[docId]?.focusRequest ?? 0);
  const revision = useViewerStore((s) => s.tabs.find((tab) => tab.docId === docId)?.info.revision ?? 0);
  // Everything that decides what a search returns (text, toggles, mode, window, accents, headers/
  // footers, scope — "current chapter" resolved against the visible page) folded into one query.
  const build = useSearchQuery(isOpen ? docId : null);
  const key = build.ok ? searchKeyFor(build.query, revision) : null;
  const problem = build.ok ? null : build.problem;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => startSearchEngine(), []);
  useEffect(() => registerSearchShortcuts(), []);
  useEffect(() => useSearchStore.getState().focusDoc(docId), [docId]);

  // (Re)run the search whenever what it would return changes: query, ANY option, the scope, or the
  // document revision (B4: an edit/undo/redo makes the drawn rects stale). Results already computed
  // for exactly this key are kept, which is what lets a tab switch round-trip without a new search (B9).
  useEffect(() => {
    if (!isOpen) return;
    const state = useSearchStore.getState();
    const doc = state.byDoc[docId];
    if (!doc) return;
    if (key === null) {
      if (problem === "outline") return; // the chapter list is still loading: decide once it is there
      cancelSearch(docId);
      if (doc.searchId) state.invalidate(docId);
      return;
    }
    if (doc.searchKey === key) return;
    if (doc.searchId) {
      cancelSearch(docId);
      state.invalidate(docId); // drop the stale hits right away instead of showing them for the debounce
    }
    scheduleSearch(docId);
  }, [docId, isOpen, key, problem, searchKey]);

  // Focus + select the field on open, on Ctrl+F while already open, and after a mode switch
  // (the input remounts when the layout changes).
  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isOpen, focusRequest, mode]);

  // Scroll the active hit's rect into view (B5), once per activation of a hit.
  const activeKey = useSearchStore((s) => {
    const doc = s.byDoc[docId];
    return doc?.active ? `${doc.searchId}:${doc.active.page}:${doc.active.hitIndex}:${doc.activateNonce}` : null;
  });
  const scrolledFor = useRef(new Map<DocId, string>());
  useEffect(() => {
    if (!isOpen || activeKey === null) {
      scrolledFor.current.delete(docId);
      return;
    }
    if (scrolledFor.current.get(docId) === activeKey) return; // e.g. coming back to this tab: keep its scroll position
    scrolledFor.current.set(docId, activeKey);
    const state = useSearchStore.getState();
    const doc = state.byDoc[docId];
    const hit = doc?.active ? doc.hitsByPage[doc.active.page]?.[doc.active.hitIndex] : undefined;
    if (doc?.active && hit) scrollToHit(docId, doc.active.page, hit, state.mode === "compact" ? COMPACT_BAR_INSET : DOCKED_INSET);
  }, [docId, isOpen, activeKey]);

  if (!isOpen) return null;
  if (mode === "docked") return <SearchDock docId={docId} inputRef={inputRef} />;
  return (
    <div className="relative z-30 w-0 shrink-0">
      <SearchBar docId={docId} inputRef={inputRef} />
    </div>
  );
}
