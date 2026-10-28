// Contract tests of the FROZEN read API (`selectors.ts`) the density map and the outline panel
// consume: counts by page and by outline entry, active hit, "has results", result kind, stable
// references, and `activateFirstHitFrom` (document order, whatever the list order).
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { SearchBatch, SearchHit } from "../../ipc/bindings";
import { resetSearchPrefsForTests, useSearchPrefs } from "./searchPrefs";
import {
  activateFirstHitFrom,
  selectActiveHit,
  selectHasResults,
  selectHitCountsByOutlineItem,
  selectHitCountsByPage,
  selectResultKind,
  useActiveHit,
  useHasResults,
  useHitCountsByOutlineItem,
  useHitCountsByPage,
  useResultKind,
} from "./selectors";
import { useSearchStore } from "./searchStore";

const DOC = "sel-doc";
const store = () => useSearchStore.getState();

const zone = (outlineItemId: string | null, score: number | null): SearchHit => ({
  rects: [],
  charStart: 0,
  charLen: 1,
  context: { before: "", matched: "x", after: "", terms: [] },
  windowRects: [],
  score,
  spansPages: null,
  outlineItemId,
});
const batch = (partial: Partial<SearchBatch>): SearchBatch => ({
  searchId: "s",
  matches: [],
  done: false,
  pagesSearched: 0,
  pageCount: 10,
  textless: false,
  ranked: false,
  furniture: [],
  ...partial,
});
const proximityQuery = { text: "a b", mode: "proximity", proximity: { window: 500 }, scope: { kind: "all" }, caseSensitive: false, wholeWord: false, ignoreDiacritics: true, excludeHeadersFooters: false } as const;

function load(mode: "phrase" | "proximity" = "phrase") {
  store().open(DOC);
  store().startNewSearch(DOC, "s", { key: "k", revision: 0, query: mode === "proximity" ? proximityQuery : undefined });
  // page 2: A(500), A(100) · page 5: B(300) · page 9: no entry
  store().addBatch(
    batch({
      matches: [
        { page: 2, hits: [zone("A", 500), zone("A", 100)] },
        { page: 5, hits: [zone("B", 300)] },
        { page: 9, hits: [zone(null, 50)] },
      ],
      done: true,
      ranked: mode === "proximity",
    }),
  );
}

beforeEach(() => {
  resetSearchPrefsForTests();
  useSearchStore.setState({ byDoc: {}, docId: null, isOpen: false, mode: "compact", panelWidth: 370 });
});

describe("pure selectors", () => {
  it("count hits by START page, only pages with hits", () => {
    load();
    expect([...selectHitCountsByPage(store().byDoc[DOC])]).toEqual([
      [2, 2],
      [5, 1],
      [9, 1],
    ]);
    expect(selectHitCountsByPage(undefined).size).toBe(0);
  });

  it("count hits by deepest outline entry, ignoring hits without one", () => {
    load();
    expect(Object.fromEntries(selectHitCountsByOutlineItem(store().byDoc[DOC]))).toEqual({ A: 2, B: 1 });
    expect(selectHitCountsByOutlineItem(undefined).size).toBe(0);
  });

  it("report the active hit and whether there are results", () => {
    expect(selectActiveHit(undefined)).toBeNull();
    expect(selectHasResults(undefined)).toBe(false);
    load();
    expect(selectActiveHit(store().byDoc[DOC])).toEqual({ page: 2, hitIndex: 0 });
    expect(selectHasResults(store().byDoc[DOC])).toBe(true);
    store().close(DOC);
    expect(selectHasResults(store().byDoc[DOC])).toBe(false); // closed: the density map hides
    expect(selectActiveHit(store().byDoc[DOC])).toBeNull();
  });

  it("report the mode of the search that produced the results", () => {
    expect(selectResultKind(undefined)).toBe("phrase");
    load("proximity");
    expect(selectResultKind(store().byDoc[DOC])).toBe("proximity");
    store().startNewSearch(DOC, "t", { key: "k2", revision: 0 });
    expect(selectResultKind(store().byDoc[DOC])).toBe("phrase");
  });
});

describe("hooks keep referentially stable outputs for unchanged state", () => {
  it("returns the same Map until the hits change, and ignores navigation", () => {
    load();
    const byPage = renderHook(() => useHitCountsByPage(DOC));
    const byItem = renderHook(() => useHitCountsByOutlineItem(DOC));
    const first = byPage.result.current;
    const firstItems = byItem.result.current;
    act(() => store().nextMatch(DOC));
    act(() => useSearchPrefs.getState().setSort("position"));
    expect(byPage.result.current).toBe(first);
    expect(byItem.result.current).toBe(firstItems);

    act(() => {
      store().addBatch(batch({ matches: [{ page: 7, hits: [zone("B", 1)] }] }));
    });
    expect(byPage.result.current).not.toBe(first);
    expect(byPage.result.current.get(7)).toBe(1);
    expect(byItem.result.current.get("B")).toBe(2);
  });

  it("tracks the active hit, the results flag and the result kind", () => {
    load("proximity");
    const active = renderHook(() => useActiveHit(DOC));
    const has = renderHook(() => useHasResults(DOC));
    const kind = renderHook(() => useResultKind(DOC));
    expect(kind.result.current).toBe("proximity");
    expect(has.result.current).toBe(true);
    const ref = active.result.current;
    expect(ref).toEqual({ page: 9, hitIndex: 0 }); // ranked: the most compact zone (50) is first
    act(() => store().nextMatch(DOC));
    expect(active.result.current).not.toBe(ref);
    act(() => store().close(DOC));
    expect(has.result.current).toBe(false);
    expect(active.result.current).toBeNull();
  });

  it("handles a null/unknown document", () => {
    expect(renderHook(() => useHitCountsByPage(null)).result.current.size).toBe(0);
    expect(renderHook(() => useHitCountsByOutlineItem("nope")).result.current.size).toBe(0);
    expect(renderHook(() => useActiveHit(null)).result.current).toBeNull();
    expect(renderHook(() => useHasResults(null)).result.current).toBe(false);
    expect(renderHook(() => useResultKind(null)).result.current).toBe("phrase");
  });
});

describe("activateFirstHitFrom", () => {
  it("activates the first hit in DOCUMENT order starting on that page or later", () => {
    // visible (compact) order: page 9 (50), then A: page 2 hit 1 (100), page 2 hit 0 (500), then B: page 5 (300)
    load("proximity");
    expect(store().byDoc[DOC].flat[0]).toEqual({ page: 9, hitIndex: 0 });
    activateFirstHitFrom(DOC, 3);
    expect(store().byDoc[DOC].active).toEqual({ page: 5, hitIndex: 0 });
    activateFirstHitFrom(DOC, 0);
    expect(store().byDoc[DOC].active).toEqual({ page: 2, hitIndex: 0 });
    activateFirstHitFrom(DOC, 2);
    expect(store().byDoc[DOC].active).toEqual({ page: 2, hitIndex: 0 });
  });

  it("falls back to the last hit in document order when nothing starts that late", () => {
    load("proximity");
    activateFirstHitFrom(DOC, 50);
    expect(store().byDoc[DOC].active).toEqual({ page: 9, hitIndex: 0 });
  });

  it("bumps the activation nonce (so the viewer scrolls) and keeps the list order", () => {
    load("proximity");
    const before = store().byDoc[DOC];
    activateFirstHitFrom(DOC, 5);
    const after = store().byDoc[DOC];
    expect(after.activateNonce).toBe(before.activateNonce + 1);
    expect(after.flat).toEqual(before.flat);
    expect(after.activeIndex).toBe(after.flat.findIndex((r) => r.page === 5));
  });

  it("does nothing without results or for an unknown document", () => {
    activateFirstHitFrom("nope", 0);
    store().open(DOC);
    activateFirstHitFrom(DOC, 0);
    expect(store().byDoc[DOC].active).toBeNull();
  });
});
