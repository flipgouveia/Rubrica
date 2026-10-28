// FROZEN read API of the search state (CONTRACTS v1.2.0, `agents/SEARCH-ORCHESTRATION.md` §2.3).
//
// Everything outside `src/viewer/search/**` (the density map, the outline panel) reads search
// results ONLY through these exports. S6 may re-implement the bodies when the store changes shape,
// but never the names, parameters or return types. Hooks return referentially stable values for
// unchanged state, so they are safe in render.
import { useMemo } from "react";
import type { DocId } from "../types";
import { type DocSearch, type HitRef, useSearchStore } from "./searchStore";

/** "phrase" results are occurrences, "proximity" results are zones (wording: "resultados" vs "zonas"). */
export type SearchResultKind = "phrase" | "proximity";

/** Number of hits that START on each page (0-based), only pages with ≥ 1 hit. */
export function selectHitCountsByPage(doc: DocSearch | undefined): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  if (!doc) return counts;
  for (const [page, hits] of Object.entries(doc.hitsByPage)) {
    if (hits.length > 0) counts.set(Number(page), hits.length);
  }
  return counts;
}

/** Number of hits per deepest outline entry id (`SearchHit.outlineItemId`); hits without one are not counted. */
export function selectHitCountsByOutlineItem(doc: DocSearch | undefined): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  if (!doc) return counts;
  for (const hits of Object.values(doc.hitsByPage)) {
    for (const hit of hits) {
      if (hit.outlineItemId !== null) counts.set(hit.outlineItemId, (counts.get(hit.outlineItemId) ?? 0) + 1);
    }
  }
  return counts;
}

export function selectActiveHit(doc: DocSearch | undefined): HitRef | null {
  return doc?.active ?? null;
}

/** True when the search UI is open for the document and it has at least one result. */
export function selectHasResults(doc: DocSearch | undefined): boolean {
  return !!doc && doc.isOpen && doc.flat.length > 0;
}

/** Mode of the search that produced the current results ("resultados" vs "zonas"); "phrase" when there is none. */
export function selectResultKind(doc: DocSearch | undefined): SearchResultKind {
  return doc?.resultMode ?? "phrase";
}

function useDoc(docId: DocId | null): DocSearch | undefined {
  return useSearchStore((s) => (docId ? s.byDoc[docId] : undefined));
}

export function useHitCountsByPage(docId: DocId | null): ReadonlyMap<number, number> {
  const doc = useDoc(docId);
  const hitsByPage = doc?.hitsByPage;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute only when the hits change
  return useMemo(() => selectHitCountsByPage(doc), [hitsByPage]);
}

export function useHitCountsByOutlineItem(docId: DocId | null): ReadonlyMap<string, number> {
  const doc = useDoc(docId);
  const hitsByPage = doc?.hitsByPage;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute only when the hits change
  return useMemo(() => selectHitCountsByOutlineItem(doc), [hitsByPage]);
}

export function useActiveHit(docId: DocId | null): HitRef | null {
  return useSearchStore((s) => selectActiveHit(docId ? s.byDoc[docId] : undefined));
}

export function useHasResults(docId: DocId | null): boolean {
  return useSearchStore((s) => selectHasResults(docId ? s.byDoc[docId] : undefined));
}

export function useResultKind(docId: DocId | null): SearchResultKind {
  return useSearchStore((s) => selectResultKind(docId ? s.byDoc[docId] : undefined));
}

/**
 * Activates (and scrolls to) the first hit IN DOCUMENT ORDER that starts on `page` or later — what
 * clicking the density map does — whatever order the list is sorted in. Falls back to the last
 * hit in document order when none is that late.
 */
export function activateFirstHitFrom(docId: DocId, page: number): void {
  const doc = useSearchStore.getState().byDoc[docId];
  if (!doc || doc.flat.length === 0) return;
  // DOCUMENT order (start page, then position inside the page), not the list's order: the list may be sorted by compactness.
  const pages = Object.keys(doc.hitsByPage)
    .map(Number)
    .filter((p) => doc.hitsByPage[p].length > 0)
    .sort((a, b) => a - b);
  if (pages.length === 0) return;
  const target = pages.find((p) => p >= page);
  const lastPage = pages[pages.length - 1];
  const ref: HitRef =
    target !== undefined
      ? { page: target, hitIndex: 0 }
      : { page: lastPage, hitIndex: doc.hitsByPage[lastPage].length - 1 };
  useSearchStore.getState().activateHit(docId, ref);
}
