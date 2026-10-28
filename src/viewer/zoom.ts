// Zoom commands shared by the toolbar buttons, the keyboard shortcuts and (via `setZoom`) the
// Ctrl+wheel handler, so every way of zooming steps by the same amount. They read the tab from the
// store at call time, so a handler registered once never zooms from a stale snapshot.
import { useEffect } from "react";
import { useAppViewStore } from "../chrome/appViewStore";
import { registerShortcut } from "../chrome/shortcuts";
import { useViewerStore } from "./store";
import { clampZoom, type DocId } from "./types";

/** Multiplier per zoom-in / zoom-out step (toolbar buttons and keyboard alike). */
export const ZOOM_STEP = 1.2;

function currentZoom(docId: DocId): number | null {
  return useViewerStore.getState().tabs.find((tab) => tab.docId === docId)?.zoom ?? null;
}

export function zoomIn(docId: DocId): void {
  const zoom = currentZoom(docId);
  if (zoom !== null) useViewerStore.getState().setZoom(docId, clampZoom(zoom * ZOOM_STEP));
}

export function zoomOut(docId: DocId): void {
  const zoom = currentZoom(docId);
  if (zoom !== null) useViewerStore.getState().setZoom(docId, clampZoom(zoom / ZOOM_STEP));
}

/** Ctrl+0: back to 100% (the browser/PDF-viewer convention), not to a fit mode. */
export function zoomActualSize(docId: DocId): void {
  useViewerStore.getState().setZoom(docId, 1, "custom");
}

/**
 * Ctrl + / Ctrl = / Ctrl - / Ctrl 0 and their numpad twins (`shortcuts.ts` folds every "+" and "-"
 * key variant into "plus" / "minus"). Fires inside text fields too: these chords insert nothing, and
 * zooming while the search box has focus is the common case. Ignored while Home/Settings is showing,
 * since the toolbar stays mounted (hidden) behind them.
 */
export function useZoomShortcuts(docId: DocId | null): void {
  useEffect(() => {
    if (!docId) return undefined;
    const whenViewing = (action: (id: DocId) => void) => () => {
      if (useAppViewStore.getState().view === "viewer") action(docId);
    };
    const unregisters = [
      registerShortcut({ id: "viewer.zoom.in", keys: "ctrl+plus", labelKey: "viewer:viewer.shortcuts.zoomIn", handler: whenViewing(zoomIn), allowInFormFields: true }),
      registerShortcut({ id: "viewer.zoom.out", keys: "ctrl+minus", labelKey: "viewer:viewer.shortcuts.zoomOut", handler: whenViewing(zoomOut), allowInFormFields: true }),
      registerShortcut({ id: "viewer.zoom.reset", keys: "ctrl+0", labelKey: "viewer:viewer.shortcuts.zoomReset", handler: whenViewing(zoomActualSize), allowInFormFields: true }),
    ];
    return () => unregisters.forEach((unregister) => unregister());
  }, [docId]);
}
