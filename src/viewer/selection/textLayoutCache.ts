// Per-(doc, page, revision) cache of `text_page_layout` results, so the selection overlay and
// keyboard navigation don't re-fetch on every render/re-mount. A revision bump (any mutation)
// invalidates naturally since it's part of the cache key — stale layouts for an old revision are
// just never looked up again, no explicit eviction needed (tiny mock documents; a real 500-page
// document would want an LRU here, left as a follow-up note rather than premature complexity).
import { useEffect, useState } from "react";
import { commands } from "../../ipc";
import type { CharBox } from "../../ipc/bindings";
import type { DocId } from "../types";

const cache = new Map<string, CharBox[]>();
const inflight = new Map<string, Promise<CharBox[]>>();

function keyOf(docId: DocId, page: number, revision: number): string {
  return `${docId}:${page}:${revision}`;
}

export function getCachedPageTextLayout(docId: DocId, page: number, revision: number): CharBox[] | null {
  return cache.get(keyOf(docId, page, revision)) ?? null;
}

export async function fetchPageTextLayout(docId: DocId, page: number, revision: number): Promise<CharBox[]> {
  const key = keyOf(docId, page, revision);
  const cached = cache.get(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = commands.textPageLayout(docId, page).then((result) => {
    const boxes = result.status === "ok" ? result.data : [];
    cache.set(key, boxes);
    inflight.delete(key);
    return boxes;
  });
  inflight.set(key, promise);
  return promise;
}

/** null while loading. */
export function usePageTextLayout(docId: DocId, page: number, revision: number): CharBox[] | null {
  const [boxes, setBoxes] = useState<CharBox[] | null>(() => getCachedPageTextLayout(docId, page, revision));

  useEffect(() => {
    let cancelled = false;
    setBoxes(getCachedPageTextLayout(docId, page, revision));
    void fetchPageTextLayout(docId, page, revision).then((result) => {
      if (!cancelled) setBoxes(result);
    });
    return () => {
      cancelled = true;
    };
  }, [docId, page, revision]);

  return boxes;
}
