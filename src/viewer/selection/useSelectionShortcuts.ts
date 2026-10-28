// Keyboard side of selection (brief item 1: "mouse + keyboard, copy") + Ctrl+C. Registered once
// (mount this hook a single time, e.g. in ViewerSurface) via the global shortcut registry so it
// composes with everything else in `src/chrome/shortcuts.ts` rather than adding a second
// independent keydown listener. Handlers read fresh state via `.getState()` at call time instead
// of closing over React state, since shortcuts are registered once, not re-registered per render.
import { useEffect } from "react";
import { registerShortcut } from "../../chrome/shortcuts";
import { commands } from "../../ipc";
import { useViewerStore } from "../store";
import { getCachedPageTextLayout } from "./textLayoutCache";
import { normalizeSelection, useSelectionStore } from "./selectionStore";

function revisionOf(docId: string): number {
  return useViewerStore.getState().tabs.find((tab) => tab.docId === docId)?.info.revision ?? 0;
}

async function copySelection(): Promise<void> {
  const selection = useSelectionStore.getState().selection;
  if (!selection) return;
  const { docId, startPage, startIndex, endPage, endIndex } = { docId: selection.docId, ...normalizeSelection(selection) };
  const revision = revisionOf(docId);
  const parts: string[] = [];
  for (let page = startPage; page <= endPage; page++) {
    const start = page === startPage ? startIndex : 0;
    const boxes = getCachedPageTextLayout(docId, page, revision);
    const pageLength = boxes?.length ?? endIndex;
    const end = page === endPage ? endIndex : pageLength;
    const result = await commands.textExtractRange(docId, { page, start, end });
    if (result.status === "ok") parts.push(result.data);
  }
  const text = parts.join("\n");
  if (text) await navigator.clipboard.writeText(text).catch(() => undefined);
}

function extendBy(delta: 1 | -1): void {
  const selection = useSelectionStore.getState().selection;
  if (!selection) return;
  const { focus, docId } = selection;
  const revision = revisionOf(docId);
  const boxes = getCachedPageTextLayout(docId, focus.page, revision);
  const pageLength = boxes?.length ?? focus.charIndex;
  let nextPage = focus.page;
  let nextIndex = focus.charIndex + delta;
  if (nextIndex < 0) {
    nextPage = Math.max(0, focus.page - 1);
    const prevBoxes = getCachedPageTextLayout(docId, nextPage, revision);
    nextIndex = prevBoxes?.length ?? 0;
  } else if (nextIndex > pageLength) {
    nextPage = focus.page + 1;
    nextIndex = 0;
  }
  useSelectionStore.getState().extendSelection(nextPage, nextIndex);
}

function selectWholePage(page: number, docId: string): void {
  const boxes = getCachedPageTextLayout(docId, page, revisionOf(docId));
  const length = boxes?.length ?? 0;
  useSelectionStore.setState({ selection: { docId, anchor: { page, charIndex: 0 }, focus: { page, charIndex: length } } });
}

export function useSelectionShortcuts(): void {
  useEffect(() => {
    const unregisters = [
      registerShortcut({
        id: "viewer.selection.copy",
        keys: "ctrl+c",
        labelKey: "viewer:viewer.shortcuts.copy",
        handler: () => void copySelection(),
      }),
      registerShortcut({
        id: "viewer.selection.extendRight",
        keys: "shift+arrowright",
        labelKey: "viewer:viewer.shortcuts.extendRight",
        handler: () => extendBy(1),
      }),
      registerShortcut({
        id: "viewer.selection.extendLeft",
        keys: "shift+arrowleft",
        labelKey: "viewer:viewer.shortcuts.extendLeft",
        handler: () => extendBy(-1),
      }),
      registerShortcut({
        id: "viewer.selection.selectPage",
        keys: "ctrl+a",
        labelKey: "viewer:viewer.shortcuts.selectPage",
        handler: () => {
          // A real bug, found while building the e2e suite (R8): reading `docId`/`page` only
          // from an EXISTING selection means Ctrl+A was a silent no-op the moment nothing was
          // already selected — the common case, since this shortcut's whole point is to make a
          // first selection. Fall back to the active tab's own docId and currently-viewed page
          // (`useViewerStore`'s `currentPage`, kept up to date by scroll) when there's nothing
          // selected yet; keep extending the existing selection's page when there is one, so a
          // second Ctrl+A after Shift+Arrow-extending still "select whole page" the page the
          // selection is currently on rather than snapping back to the viewport's page.
          //
          // A second real bug a review caught: only reuse that existing selection when it
          // actually belongs to the ACTIVE tab. The selection store isn't cleared on tab switch,
          // so selecting text in document A, switching to document B, and pressing Ctrl+A used to
          // still select all of A's page (wherever the stale selection happened to focus) instead
          // of B's — a completely different, invisible document getting selected out from under
          // the tab actually on screen.
          const activeTab = useViewerStore.getState().tabs.find((tab) => tab.docId === useViewerStore.getState().activeTabId);
          const selection = useSelectionStore.getState().selection;
          const relevantSelection = selection && activeTab && selection.docId === activeTab.docId ? selection : null;
          const docId = relevantSelection?.docId ?? activeTab?.docId;
          const page = relevantSelection?.focus.page ?? activeTab?.currentPage ?? 0;
          if (docId) selectWholePage(page, docId);
        },
      }),
      registerShortcut({
        id: "viewer.selection.clear",
        keys: "escape",
        labelKey: "viewer:viewer.shortcuts.clearSelection",
        handler: () => useSelectionStore.getState().clearSelection(),
      }),
    ];
    return () => unregisters.forEach((unregister) => unregister());
  }, []);
}
