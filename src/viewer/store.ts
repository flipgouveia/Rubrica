// Viewer/tab state (CONTRACTS leaves this to the UI — DocInfo/MutationResult are the wire
// contract, everything here is client-side view state layered on top). One entry per open
// document/tab; `activeTabId` drives which tab's viewer/chrome is shown. Mutation events
// (`doc_state_changed`) are applied via `applyDocStateChanged` from a single listener mounted
// once in AppShell, so every tab stays in sync regardless of which one is active.
import { create } from "zustand";
import type { DocInfo, PageSize, Rect } from "../ipc/bindings";
import type { DocId } from "./types";
import { clampZoom } from "./types";

export type ZoomMode = "custom" | "fit-width" | "fit-page";

export interface TabState {
  docId: DocId;
  info: DocInfo;
  currentPage: number;
  zoom: number;
  zoomMode: ZoomMode;
  /** Set by callers that need the viewer to scroll to a page; the viewer clears it after acting. */
  pendingScrollTo: number | null;
}

// ---------------------------------------------------------------------------------------------
// Scrolling a PDF-point rect into view (search hits, B5). Pure geometry: ViewerSurface lays pages
// out as a fixed-height column (page height * zoom + PAGE_GAP, VIEWPORT_PADDING around it,
// horizontally centred), so a rect's position inside the scroller is computable without touching
// the DOM. The two constants below MUST match ViewerSurface.tsx.
// ---------------------------------------------------------------------------------------------
export const VIEWER_PAGE_GAP = 16;
export const VIEWER_PADDING = 24;

export interface RectScrollInput {
  pages: readonly PageSize[];
  zoom: number;
  page: number;
  /** In PDF points (y grows upwards), like every other rect in the app. */
  rect: Rect;
  view: { width: number; height: number; scrollTop: number; scrollLeft: number; scrollWidth?: number };
  /** Space at the top of the viewport that overlays content (the compact search bar). */
  topInset?: number;
  /** Breathing room kept around the rect. */
  margin?: number;
}

/**
 * Where to scroll so the rect is fully visible below `topInset`; `null` when it already is.
 * Centres the rect in the free area (or aligns its top edge when it is taller than the area).
 */
export function computeRectScroll(input: RectScrollInput): { top: number; left: number } | null {
  const { pages, zoom, page, rect, view, topInset = 0, margin = 16 } = input;
  const size = pages[page];
  if (!size) return null;
  const pageHeight = size.height ?? 792;
  const pageWidth = size.width ?? 612;

  let pageTop = VIEWER_PADDING;
  for (let i = 0; i < page; i++) pageTop += (pages[i]?.height ?? 792) * zoom + VIEWER_PAGE_GAP;
  const contentWidth = view.width - 2 * VIEWER_PADDING;
  const pageLeft = VIEWER_PADDING + (contentWidth - pageWidth * zoom) / 2;

  const rectHeight = (rect.height ?? 0) * zoom;
  const rectWidth = (rect.width ?? 0) * zoom;
  const rectTop = pageTop + (pageHeight - ((rect.y ?? 0) + (rect.height ?? 0))) * zoom;
  const rectLeft = pageLeft + (rect.x ?? 0) * zoom;

  const freeHeight = view.height - topInset;
  let top = view.scrollTop;
  if (rectTop < view.scrollTop + topInset + margin || rectTop + rectHeight > view.scrollTop + view.height - margin) {
    top = rectHeight + 2 * margin > freeHeight ? rectTop - topInset - margin : rectTop - topInset - (freeHeight - rectHeight) / 2;
  }
  let left = view.scrollLeft;
  if (rectLeft < view.scrollLeft + margin || rectLeft + rectWidth > view.scrollLeft + view.width - margin) {
    left = rectWidth + 2 * margin > view.width ? rectLeft - margin : rectLeft - (view.width - rectWidth) / 2;
  }

  let totalHeight = 2 * VIEWER_PADDING - VIEWER_PAGE_GAP;
  for (const p of pages) totalHeight += (p.height ?? 792) * zoom + VIEWER_PAGE_GAP;
  top = Math.min(Math.max(0, top), Math.max(0, totalHeight - view.height));
  left = Math.max(0, left);
  if (view.scrollWidth !== undefined) left = Math.min(left, Math.max(0, view.scrollWidth - view.width));

  top = Math.round(top);
  left = Math.round(left);
  return top === Math.round(view.scrollTop) && left === Math.round(view.scrollLeft) ? null : { top, left };
}

interface ViewerStoreState {
  tabs: TabState[];
  activeTabId: DocId | null;
  openTab: (info: DocInfo) => void;
  closeTab: (docId: DocId) => void;
  setActiveTab: (docId: DocId) => void;
  setCurrentPage: (docId: DocId, page: number) => void;
  setZoom: (docId: DocId, zoom: number, mode?: ZoomMode) => void;
  scrollToPage: (docId: DocId, page: number) => void;
  clearPendingScroll: (docId: DocId) => void;
  applyDocInfo: (info: DocInfo) => void;
  applyDocStateChanged: (docId: DocId, patch: { revision: number; dirty: boolean }) => void;
}

export const useViewerStore = create<ViewerStoreState>((set) => ({
  tabs: [],
  activeTabId: null,

  openTab: (info) =>
    set((state) => {
      const existing = state.tabs.find((tab) => tab.docId === info.docId);
      if (existing) {
        return {
          tabs: state.tabs.map((tab) => (tab.docId === info.docId ? { ...tab, info } : tab)),
          activeTabId: info.docId,
        };
      }
      const tab: TabState = {
        docId: info.docId,
        info,
        currentPage: 0,
        zoom: 1,
        zoomMode: "fit-width",
        pendingScrollTo: null,
      };
      return { tabs: [...state.tabs, tab], activeTabId: info.docId };
    }),

  closeTab: (docId) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.docId !== docId);
      const activeTabId =
        state.activeTabId === docId ? (tabs.length > 0 ? tabs[tabs.length - 1].docId : null) : state.activeTabId;
      return { tabs, activeTabId };
    }),

  setActiveTab: (docId) => set({ activeTabId: docId }),

  setCurrentPage: (docId, page) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.docId === docId ? { ...tab, currentPage: page } : tab)),
    })),

  setZoom: (docId, zoom, mode = "custom") =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.docId === docId ? { ...tab, zoom: clampZoom(zoom), zoomMode: mode } : tab)),
    })),

  scrollToPage: (docId, page) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.docId === docId ? { ...tab, currentPage: page, pendingScrollTo: page } : tab)),
    })),

  clearPendingScroll: (docId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.docId === docId ? { ...tab, pendingScrollTo: null } : tab)),
    })),

  applyDocInfo: (info) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.docId === info.docId ? { ...tab, info } : tab)),
    })),

  applyDocStateChanged: (docId, patch) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.docId === docId ? { ...tab, info: { ...tab.info, revision: patch.revision, dirty: patch.dirty } } : tab,
      ),
    })),
}));

export function useActiveTab(): TabState | null {
  return useViewerStore((state) => state.tabs.find((tab) => tab.docId === state.activeTabId) ?? null);
}

export function useTabByDocId(docId: DocId | null): TabState | null {
  return useViewerStore((state) => (docId ? (state.tabs.find((tab) => tab.docId === docId) ?? null) : null));
}

export function getTabByDocId(docId: DocId): TabState | null {
  return useViewerStore.getState().tabs.find((tab) => tab.docId === docId) ?? null;
}
