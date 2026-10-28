// Text selection state + the pure range math (kept dependency-free from React so it's directly
// unit-testable — see selectionStore.test.ts). A selection is a (page, charIndex) anchor/focus
// pair; it may span multiple pages (anchor and focus on different pages), matching how a real
// PDF viewer's drag-to-select behaves.
import { create } from "zustand";
import type { DocId } from "../types";

export interface SelectionAnchor {
  page: number;
  charIndex: number;
}

export interface SelectionRange {
  docId: DocId;
  anchor: SelectionAnchor;
  focus: SelectionAnchor;
}

export interface NormalizedSelection {
  startPage: number;
  startIndex: number;
  endPage: number;
  endIndex: number;
}

function beforeOrEqual(a: SelectionAnchor, b: SelectionAnchor): boolean {
  return a.page < b.page || (a.page === b.page && a.charIndex <= b.charIndex);
}

export function normalizeSelection(sel: SelectionRange): NormalizedSelection {
  const [start, end] = beforeOrEqual(sel.anchor, sel.focus) ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor];
  return { startPage: start.page, startIndex: start.charIndex, endPage: end.page, endIndex: end.charIndex };
}

export function isCollapsed(sel: SelectionRange): boolean {
  const n = normalizeSelection(sel);
  return n.startPage === n.endPage && n.startIndex === n.endIndex;
}

/**
 * The [start, end) char range highlighted on `page`, or null if this page has nothing selected.
 * A page strictly between the selection's start/end pages is selected in full.
 */
export function selectionRangeForPage(
  sel: SelectionRange,
  page: number,
  pageTextLength: number,
): { start: number; end: number } | null {
  const { startPage, startIndex, endPage, endIndex } = normalizeSelection(sel);
  if (page < startPage || page > endPage) return null;
  if (startPage === endPage) {
    return startIndex === endIndex ? null : { start: startIndex, end: endIndex };
  }
  if (page === startPage) return { start: startIndex, end: pageTextLength };
  if (page === endPage) return { start: 0, end: endIndex };
  return { start: 0, end: pageTextLength };
}

interface SelectionStoreState {
  selection: SelectionRange | null;
  startSelection: (docId: DocId, page: number, charIndex: number) => void;
  extendSelection: (page: number, charIndex: number) => void;
  setSelection: (selection: SelectionRange | null) => void;
  clearSelection: () => void;
}

export const useSelectionStore = create<SelectionStoreState>((set) => ({
  selection: null,
  startSelection: (docId, page, charIndex) => set({ selection: { docId, anchor: { page, charIndex }, focus: { page, charIndex } } }),
  extendSelection: (page, charIndex) =>
    set((state) => (state.selection ? { selection: { ...state.selection, focus: { page, charIndex } } } : state)),
  setSelection: (selection) => set({ selection }),
  clearSelection: () => set({ selection: null }),
}));
