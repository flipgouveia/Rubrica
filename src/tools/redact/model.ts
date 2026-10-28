// Pending redaction marks: local, ephemeral UI state for rects the user has marked but not yet
// applied via `redact_apply` (CONTRACTS §3 — a mark only becomes a real mutation once the confirm
// dialog is accepted, see `apply.ts`). Scoped per open document (`marksByDoc`) so switching tabs,
// or having multiple documents open at once, never mixes one document's pending marks into
// another's, and closing/reopening a document doesn't resurrect stale marks from a previous
// session (there is no persistence here on purpose — pending marks are exactly that, pending).
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Rect } from "../../ipc/bindings";
import type { DocId } from "../../viewer/types";

export interface PendingMark {
  id: string;
  page: number;
  rect: Rect;
}

interface RedactStoreState {
  marksByDoc: Record<DocId, PendingMark[]>;
  addMark: (docId: DocId, page: number, rect: Rect) => string;
  removeMark: (docId: DocId, id: string) => void;
  removeMarks: (docId: DocId, ids: readonly string[]) => void;
  clearMarks: (docId: DocId) => void;
}

let markCounter = 0;
function nextMarkId(): string {
  markCounter += 1;
  return `redact-mark-${markCounter}`;
}

export const useRedactStore = create<RedactStoreState>((set) => ({
  marksByDoc: {},

  addMark: (docId, page, rect) => {
    const id = nextMarkId();
    set((state) => ({
      marksByDoc: { ...state.marksByDoc, [docId]: [...(state.marksByDoc[docId] ?? []), { id, page, rect }] },
    }));
    return id;
  },

  removeMark: (docId, id) =>
    set((state) => ({
      marksByDoc: { ...state.marksByDoc, [docId]: (state.marksByDoc[docId] ?? []).filter((mark) => mark.id !== id) },
    })),

  removeMarks: (docId, ids) =>
    set((state) => {
      const idSet = new Set(ids);
      return { marksByDoc: { ...state.marksByDoc, [docId]: (state.marksByDoc[docId] ?? []).filter((mark) => !idSet.has(mark.id)) } };
    }),

  clearMarks: (docId) =>
    set((state) => {
      const next = { ...state.marksByDoc };
      delete next[docId];
      return { marksByDoc: next };
    }),
}));

const EMPTY_MARKS: PendingMark[] = [];

export function useMarksForDoc(docId: DocId): PendingMark[] {
  return useRedactStore((state) => state.marksByDoc[docId] ?? EMPTY_MARKS);
}

/**
 * `.filter()` builds a fresh array every call — plugged straight into `useRedactStore` as a
 * selector, that fresh reference reads as "changed" on every render (`Object.is` fails even when
 * the filtered contents are identical), which starves `useSyncExternalStore` into an infinite
 * render loop. `useShallow` memoizes the selector's result by shallow-comparing it against the
 * previous call, handing back the *previous* array reference whenever the elements are the same,
 * which is what breaks the loop (`useMarksForDoc` above doesn't need this: it returns the stored
 * array/`EMPTY_MARKS` directly, never a derived copy).
 */
export function useMarksForPage(docId: DocId, page: number): PendingMark[] {
  return useRedactStore(useShallow((state) => state.marksByDoc[docId]?.filter((mark) => mark.page === page) ?? EMPTY_MARKS));
}
