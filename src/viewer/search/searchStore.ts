// Search UI state (CONTRACTS v1.2.0 §3 text_search_start/cancel + search_batch event), kept PER
// DOCUMENT (B9): switching tabs and coming back keeps the query, the scope and the results. The store
// only holds state; `searchController.ts` owns the IPC round-trip and `SearchPanel.tsx` the React
// wiring, so this stays framework-light and testable on its own. The app-wide query options (mode,
// window, accents, headers/footers, sort, colours) live in `searchPrefs.ts`.
//
// One entry = one OCCURRENCE or ZONE ("hit"; it may have several rects, on one or two pages). Hits
// are stored by START page (`hitsByPage`, as streamed) and identified by `HitRef { page, hitIndex }`,
// never by object reference (B7). `flat` is the VISIBLE order of the result list (grouped by outline
// entry, "by position" or "most compact"): "X de N" and next/previous walk it. When the sort
// preference or the ranking changes, the order is recomputed but the active hit stays the same hit.
import { create } from "zustand";
import type { Rect, SearchBatch, SearchHit, SearchMatch, SearchQuery } from "../../ipc/bindings";
import type { DocId } from "../types";
import { buildHitOrder, groupKey, type HitGroup, type HitOrder, type HitRef } from "./searchOrder";
import { useSearchPrefs } from "./searchPrefs";
import { SCOPE_ALL, type ScopeChoice } from "./searchScope";

export type { HitGroup, HitRef } from "./searchOrder";

export type SearchMode = "compact" | "docked";

export const DOCKED_WIDTH_DEFAULT = 370;
export const DOCKED_WIDTH_MIN = 300;
export const DOCKED_WIDTH_MAX = 520;

export function clampDockedWidth(width: number): number {
  return Math.min(DOCKED_WIDTH_MAX, Math.max(DOCKED_WIDTH_MIN, Math.round(width)));
}

/** Why a search ended without results other than "none found". */
export interface SearchError {
  /** `invalid` = the engine answered INVALID_ARG (bad terms, window or scope). */
  kind: "invalid" | "failed";
  message: string;
}

export interface DocSearch {
  isOpen: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  scope: ScopeChoice;
  /** Id of the search whose batches this entry accepts (client-minted, CONTRACTS v1.1.0). */
  searchId: string | null;
  /** Fingerprint (query + options + scope + revision) of the search that produced `searchId`. */
  searchKey: string | null;
  /** Document revision the current results were computed against (B4). */
  revision: number | null;
  /** The query that was sent (null until a search starts): mode, window, scope, terms. */
  searchQuery: SearchQuery | null;
  /** Mode of the search that produced the results (wording "resultados" vs "zonas"). */
  resultMode: SearchQuery["mode"];
  /** Hits by START page, document order inside a page. */
  hitsByPage: Record<number, SearchHit[]>;
  /** Every hit in the VISIBLE order of the list. */
  flat: HitRef[];
  /** `flat` split by outline entry (one headerless group when `grouped` is false). */
  groups: HitGroup[];
  grouped: boolean;
  active: HitRef | null;
  /** Position of `active` inside `flat` (-1 when none). */
  activeIndex: number;
  done: boolean;
  textless: boolean;
  /** Proximity `done` batch received: scores are final and "most compact" ordering applies. */
  ranked: boolean;
  /** Excluded header/footer line rects per page (`excludeHeadersFooters`), to dim them. */
  furniture: Record<number, Rect[]>;
  error: SearchError | null;
  pagesSearched: number;
  /** Pages IN THE SCOPE of the running/last search (0 until the first batch). */
  pageCount: number;
  /** Collapsed result groups, by `groupKey`. */
  collapsed: Record<string, true>;
  /** Bumped every time the user activates a hit (next/prev/click) so even re-activating the same hit scrolls to it. */
  activateNonce: number;
  /** Bumped by every `open()` so an already-open panel can refocus and select its input. */
  focusRequest: number;
}

interface SearchStoreState {
  /** The document the toolbar button reflects (the active tab's). */
  docId: DocId | null;
  /** `byDoc[docId].isOpen` of the focused document — kept in sync, read by the toolbar. */
  isOpen: boolean;
  mode: SearchMode;
  panelWidth: number;
  byDoc: Record<DocId, DocSearch>;

  open: (docId: DocId, mode?: SearchMode) => void;
  close: (docId: DocId) => void;
  focusDoc: (docId: DocId | null) => void;
  removeDoc: (docId: DocId) => void;
  setMode: (mode: SearchMode) => void;
  setPanelWidth: (width: number) => void;
  setQuery: (docId: DocId, query: string) => void;
  toggleCaseSensitive: (docId: DocId) => void;
  toggleWholeWord: (docId: DocId) => void;
  setScope: (docId: DocId, scope: ScopeChoice) => void;
  startNewSearch: (docId: DocId, searchId: string, meta: { key: string; revision: number; query?: SearchQuery }) => void;
  /** Drops the results (and the search id) but keeps query/options — used when a revision or an option makes them stale. */
  invalidate: (docId: DocId) => void;
  finishWithError: (docId: DocId, searchId: string, error?: SearchError) => void;
  addBatch: (batch: SearchBatch) => void;
  /** Re-sorts every document's list (the sort preference changed). */
  reorderAll: () => void;
  toggleGroup: (docId: DocId, id: string | null) => void;
  setActiveIndex: (docId: DocId, index: number) => void;
  /** Activates a specific hit (if it is in the list), expanding its group. */
  activateHit: (docId: DocId, ref: HitRef) => void;
  nextMatch: (docId: DocId) => void;
  prevMatch: (docId: DocId) => void;
}

const emptyResults = {
  searchId: null as string | null,
  searchKey: null as string | null,
  revision: null as number | null,
  searchQuery: null as SearchQuery | null,
  resultMode: "phrase" as SearchQuery["mode"],
  hitsByPage: {} as Record<number, SearchHit[]>,
  flat: [] as HitRef[],
  groups: [] as HitGroup[],
  grouped: false,
  active: null as HitRef | null,
  activeIndex: -1,
  done: false,
  textless: false,
  ranked: false,
  furniture: {} as Record<number, Rect[]>,
  error: null as SearchError | null,
  pagesSearched: 0,
  pageCount: 0,
};

export function createDocSearch(): DocSearch {
  return {
    isOpen: false,
    query: "",
    caseSensitive: false,
    wholeWord: false,
    scope: SCOPE_ALL,
    collapsed: {},
    focusRequest: 0,
    activateNonce: 0,
    ...emptyResults,
  };
}

/** Position of `ref` in the (visible-order) list; -1 when absent. */
export function indexOfHit(flat: HitRef[], ref: HitRef | null): number {
  if (!ref) return -1;
  return flat.findIndex((cur) => cur.page === ref.page && cur.hitIndex === ref.hitIndex);
}

/** The list order that applies to a document right now ("most compact" needs a ranked proximity search). */
function orderOf(doc: Pick<DocSearch, "hitsByPage" | "resultMode" | "ranked">): HitOrder {
  const compact = doc.resultMode === "proximity" && doc.ranked && useSearchPrefs.getState().sort === "compact";
  return buildHitOrder(doc.hitsByPage, compact);
}

/** Installs a new visible order, keeping `active` (or falling back to the first hit when it is gone). */
function withOrder(doc: DocSearch, order: HitOrder, active: HitRef | null): DocSearch {
  let index = indexOfHit(order.flat, active);
  if (index === -1 && order.flat.length > 0) index = 0;
  return {
    ...doc,
    flat: order.flat,
    groups: order.groups,
    grouped: order.grouped,
    active: index === -1 ? null : order.flat[index],
    activeIndex: index,
  };
}

function mergeMatches(hitsByPage: Record<number, SearchHit[]>, matches: SearchMatch[]): Record<number, SearchHit[]> {
  const next = { ...hitsByPage };
  for (const match of matches) next[match.page] = match.hits;
  return next;
}

/** Marks `index` of the list active; opens the group it lives in so it is visible in the list. */
function activate(doc: DocSearch, index: number): DocSearch {
  const ref = doc.flat[index];
  const hit = doc.hitsByPage[ref.page]?.[ref.hitIndex];
  const key = groupKey(hit?.outlineItemId ?? null);
  const collapsed = doc.collapsed[key] ? { ...doc.collapsed } : doc.collapsed;
  if (doc.collapsed[key]) delete collapsed[key];
  return { ...doc, collapsed, activeIndex: index, active: ref, activateNonce: doc.activateNonce + 1 };
}

export const useSearchStore = create<SearchStoreState>((set, get) => {
  /** Applies `fn` to one document's entry (creating it on demand) and keeps `isOpen` in sync. */
  const update = (docId: DocId, fn: (doc: DocSearch) => DocSearch, extra: Partial<SearchStoreState> = {}) =>
    set((state) => {
      const doc = fn(state.byDoc[docId] ?? createDocSearch());
      const focusedDocId = extra.docId !== undefined ? extra.docId : state.docId;
      const byDoc = { ...state.byDoc, [docId]: doc };
      return { ...extra, byDoc, isOpen: focusedDocId ? (byDoc[focusedDocId]?.isOpen ?? false) : false };
    });

  const step = (docId: DocId, delta: 1 | -1) =>
    set((state) => {
      const doc = state.byDoc[docId];
      if (!doc || doc.flat.length === 0) return state;
      const index = (doc.activeIndex + delta + doc.flat.length) % doc.flat.length;
      return { byDoc: { ...state.byDoc, [docId]: activate(doc, index) } };
    });

  return {
    docId: null,
    isOpen: false,
    mode: "compact",
    panelWidth: DOCKED_WIDTH_DEFAULT,
    byDoc: {},

    open: (docId, mode) =>
      update(docId, (doc) => ({ ...doc, isOpen: true, focusRequest: doc.focusRequest + 1 }), {
        docId,
        ...(mode ? { mode } : {}),
      }),

    // Closing drops the results (and the search id) but remembers the query and scope, so Ctrl+F brings it back selected.
    close: (docId) => update(docId, (doc) => ({ ...doc, ...emptyResults, isOpen: false })),

    focusDoc: (docId) =>
      set((state) => ({
        docId,
        isOpen: docId ? (state.byDoc[docId]?.isOpen ?? false) : false,
      })),

    removeDoc: (docId) =>
      set((state) => {
        const byDoc = { ...state.byDoc };
        delete byDoc[docId];
        const docIdNext = state.docId === docId ? null : state.docId;
        return { byDoc, docId: docIdNext, isOpen: docIdNext ? (byDoc[docIdNext]?.isOpen ?? false) : false };
      }),

    setMode: (mode) => set({ mode }),
    setPanelWidth: (width) => set({ panelWidth: clampDockedWidth(width) }),

    setQuery: (docId, query) => update(docId, (doc) => ({ ...doc, ...emptyResults, query })),
    toggleCaseSensitive: (docId) => update(docId, (doc) => ({ ...doc, caseSensitive: !doc.caseSensitive })),
    toggleWholeWord: (docId) => update(docId, (doc) => ({ ...doc, wholeWord: !doc.wholeWord })),
    setScope: (docId, scope) => update(docId, (doc) => ({ ...doc, scope })),

    startNewSearch: (docId, searchId, meta) =>
      update(docId, (doc) => ({
        ...doc,
        ...emptyResults,
        searchId,
        searchKey: meta.key,
        revision: meta.revision,
        searchQuery: meta.query ?? null,
        resultMode: meta.query?.mode ?? "phrase",
        collapsed: {},
      })),

    invalidate: (docId) => update(docId, (doc) => ({ ...doc, ...emptyResults })),

    finishWithError: (docId, searchId, error) =>
      update(docId, (doc) => (doc.searchId === searchId ? { ...doc, done: true, error: error ?? null } : doc)),

    addBatch: (batch) => {
      const docId = Object.keys(get().byDoc).find((id) => get().byDoc[id].searchId === batch.searchId);
      if (!docId) return; // stale/cancelled search id
      update(docId, (doc) => {
        const hitsByPage = batch.matches.length > 0 ? mergeMatches(doc.hitsByPage, batch.matches) : doc.hitsByPage;
        const ranked = doc.ranked || (batch.done && batch.ranked);
        const furniture = batch.furniture.length > 0 ? { ...doc.furniture } : doc.furniture;
        for (const entry of batch.furniture) furniture[entry.page] = entry.rects;

        let next: DocSearch = {
          ...doc,
          hitsByPage,
          ranked,
          furniture,
          done: batch.done,
          textless: batch.done ? batch.textless : false,
          pagesSearched: Math.max(doc.pagesSearched, batch.pagesSearched),
          pageCount: batch.pageCount,
        };
        if (hitsByPage !== doc.hitsByPage || ranked !== doc.ranked) {
          // Ranking just arrived and the user has not moved yet: land on the most compact zone, not on
          // whatever the position order happened to put first.
          const rankedNow = ranked && !doc.ranked;
          const keep = rankedNow && doc.activateNonce === 0 ? null : doc.active;
          next = withOrder(next, orderOf(next), keep);
        }
        return next;
      });
    },

    reorderAll: () =>
      set((state) => {
        const byDoc: Record<DocId, DocSearch> = {};
        for (const [id, doc] of Object.entries(state.byDoc)) {
          byDoc[id] = doc.flat.length > 0 ? withOrder(doc, orderOf(doc), doc.active) : doc;
        }
        return { byDoc };
      }),

    toggleGroup: (docId, id) =>
      update(docId, (doc) => {
        const key = groupKey(id);
        const collapsed = { ...doc.collapsed };
        if (collapsed[key]) delete collapsed[key];
        else collapsed[key] = true;
        return { ...doc, collapsed };
      }),

    setActiveIndex: (docId, index) =>
      set((state) => {
        const doc = state.byDoc[docId];
        if (!doc || index < 0 || index >= doc.flat.length) return state;
        return { byDoc: { ...state.byDoc, [docId]: activate(doc, index) } };
      }),

    activateHit: (docId, ref) =>
      set((state) => {
        const doc = state.byDoc[docId];
        const index = doc ? indexOfHit(doc.flat, ref) : -1;
        if (!doc || index === -1) return state;
        return { byDoc: { ...state.byDoc, [docId]: activate(doc, index) } };
      }),

    nextMatch: (docId) => step(docId, 1),
    prevMatch: (docId) => step(docId, -1),
  };
});

// A changed sort preference re-sorts every open list (the active hit stays the same hit).
useSearchPrefs.subscribe((state, previous) => {
  if (state.sort !== previous.sort) useSearchStore.getState().reorderAll();
});

/** Selector helper: the (possibly absent) search state of one document. */
export function selectDoc(docId: DocId | null) {
  return (state: SearchStoreState): DocSearch | undefined => (docId ? state.byDoc[docId] : undefined);
}

export function getDocSearch(docId: DocId): DocSearch | undefined {
  return useSearchStore.getState().byDoc[docId];
}
