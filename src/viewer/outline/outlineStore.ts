// FROZEN shared access to a document's outline (CONTRACTS v1.2.0 `doc_outline`), used by the search
// scope selector (S6) and the outline side panel (S7). Fetched once per (document, revision) and
// cached; neither agent edits this file during wave F2.
import { useEffect } from "react";
import { create } from "zustand";
import { commands } from "../../ipc";
import type { OutlineItem } from "../../ipc/bindings";
import { useTabByDocId } from "../store";
import type { DocId } from "../types";

export type OutlineState =
  | { status: "loading" }
  | { status: "error" }
  /** `items` is `[]` when the PDF has no bookmarks. */
  | { status: "ready"; items: OutlineItem[] };

interface OutlineStoreState {
  /** Keyed by `${docId}@${revision}`. */
  byKey: Record<string, OutlineState>;
  load: (docId: DocId, revision: number) => Promise<void>;
}

const keyOf = (docId: DocId, revision: number) => `${docId}@${revision}`;

export const useOutlineStore = create<OutlineStoreState>((set, get) => ({
  byKey: {},
  load: async (docId, revision) => {
    const key = keyOf(docId, revision);
    if (get().byKey[key]) return;
    set((s) => ({ byKey: { ...s.byKey, [key]: { status: "loading" } } }));
    try {
      const result = await commands.docOutline(docId);
      const next: OutlineState = result.status === "ok" ? { status: "ready", items: result.data } : { status: "error" };
      set((s) => ({ byKey: { ...s.byKey, [key]: next } }));
    } catch {
      set((s) => ({ byKey: { ...s.byKey, [key]: { status: "error" } } }));
    }
  },
}));

const LOADING: OutlineState = { status: "loading" };

/** The outline of an open document, (re)loaded when its revision changes. */
export function useOutline(docId: DocId | null): OutlineState {
  const revision = useTabByDocId(docId)?.info.revision ?? 0;
  const state = useOutlineStore((s) => (docId ? s.byKey[keyOf(docId, revision)] : undefined));
  useEffect(() => {
    if (docId) void useOutlineStore.getState().load(docId, revision);
  }, [docId, revision]);
  return state ?? LOADING;
}

/** Depth-first, document order. */
export function flattenOutline(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutline(item.children)]);
}

function contains(item: OutlineItem, page: number): boolean {
  return item.page !== null && item.pageEnd !== null && page >= item.page && page <= item.pageEnd;
}

/** The depth-0 entry whose range contains `page` — the "Capítulo atual" search scope. */
export function topLevelItemForPage(items: OutlineItem[], page: number): OutlineItem | null {
  return items.find((item) => contains(item, page)) ?? null;
}

/**
 * The deepest entry whose range contains `page` — the one the outline panel highlights. Same rule as
 * the engine's `deepest_item_for_page` (so it agrees with `SearchHit.outlineItemId`): an entry
 * without a page never matches, but its paged children are still searched.
 */
export function deepestItemForPage(items: OutlineItem[], page: number): OutlineItem | null {
  for (const item of items) {
    if (item.page !== null && item.pageEnd !== null) {
      if (page >= item.page && page <= item.pageEnd) return deepestItemForPage(item.children, page) ?? item;
    } else {
      const inside = deepestItemForPage(item.children, page);
      if (inside) return inside;
    }
  }
  return null;
}

export function findOutlineItem(items: OutlineItem[], id: string): OutlineItem | null {
  return flattenOutline(items).find((item) => item.id === id) ?? null;
}
