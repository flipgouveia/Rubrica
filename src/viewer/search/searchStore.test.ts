import { beforeEach, describe, expect, it } from "vitest";
import type { HitRect, SearchBatch, SearchHit } from "../../ipc/bindings";
import { resetSearchPrefsForTests, useSearchPrefs } from "./searchPrefs";import { clampDockedWidth, indexOfHit, useSearchStore } from "./searchStore";

const DOC = "test-doc";

const rect = (x: number): HitRect => ({ page: 0, rect: { x, y: 0, width: 1, height: 1 }, term: 0 });
const hit = (x: number, rects = 1): SearchHit => ({
  rects: Array.from({ length: rects }, (_, i) => rect(x + i)),
  charStart: x,
  charLen: 1,
  context: { before: "", matched: "x", after: "", terms: [] },
  windowRects: [],
  score: null,
  spansPages: null,
  outlineItemId: null,
});

const batch = (searchId: string, partial: Partial<SearchBatch>): SearchBatch => ({
  searchId,
  matches: [],
  done: false,
  pagesSearched: 0,
  pageCount: 1,
  textless: false,
  ranked: false,
  furniture: [],
  ...partial,
});

const doc = (id = DOC) => useSearchStore.getState().byDoc[id];
const store = () => useSearchStore.getState();
const start = (searchId: string, id = DOC) => store().startNewSearch(id, searchId, { key: searchId, revision: 0 });

beforeEach(() => {
  resetSearchPrefsForTests();
  useSearchStore.setState({ byDoc: {}, docId: null, isOpen: false, mode: "compact", panelWidth: 370 });
  store().open(DOC);
});

describe("search hit navigation", () => {
  it("accumulates streamed batches into a flat, page-ordered list of hits", () => {
    start("search-1");
    store().addBatch(batch("search-1", { matches: [{ page: 1, hits: [hit(0)] }] }));
    store().addBatch(batch("search-1", { matches: [{ page: 0, hits: [hit(0), hit(1)] }], done: true }));

    expect(doc().flat).toEqual([
      { page: 0, hitIndex: 0 },
      { page: 0, hitIndex: 1 },
      { page: 1, hitIndex: 0 },
    ]);
    expect(doc().done).toBe(true);
  });

  it("counts a hit with several rects once", () => {
    start("search-1");
    store().addBatch(batch("search-1", { matches: [{ page: 0, hits: [hit(0, 3), hit(10, 2)] }], done: true }));
    expect(doc().flat).toHaveLength(2);
  });

  it("ignores a batch from a stale/cancelled search id", () => {
    start("search-1");
    store().addBatch(batch("search-1", { matches: [{ page: 0, hits: [hit(0)] }] }));
    start("search-2"); // e.g. the query changed mid-flight
    store().addBatch(batch("search-1", { matches: [{ page: 5, hits: [hit(0)] }], done: true }));

    expect(doc().flat).toHaveLength(0);
    expect(doc().searchId).toBe("search-2");
  });

  it("keeps a batch that was emitted for an id adopted before the command resolved (B1)", () => {
    // The client adopts the id first, then the engine's very first batch lands before any await returns.
    start("search-1");
    store().addBatch(batch("search-1", { matches: [{ page: 0, hits: [hit(0)] }], pagesSearched: 1 }));
    expect(doc().flat).toHaveLength(1);
  });

  it("selects the first hit automatically once results arrive", () => {
    start("search-1");
    expect(doc().activeIndex).toBe(-1);
    store().addBatch(batch("search-1", { matches: [{ page: 0, hits: [hit(0)] }] }));
    expect(doc().activeIndex).toBe(0);
    expect(doc().active).toEqual({ page: 0, hitIndex: 0 });
  });

  it("wraps forward past the last hit and backward past the first", () => {
    start("search-1");
    store().addBatch(batch("search-1", { matches: [{ page: 0, hits: [hit(0), hit(1)] }], done: true }));

    expect(doc().activeIndex).toBe(0);
    store().nextMatch(DOC);
    expect(doc().activeIndex).toBe(1);
    store().nextMatch(DOC);
    expect(doc().activeIndex).toBe(0); // wrapped
    store().prevMatch(DOC);
    expect(doc().activeIndex).toBe(1); // wrapped the other way
  });

  it("is a no-op to navigate with no hits", () => {
    store().nextMatch(DOC);
    expect(doc().activeIndex).toBe(-1);
  });

  it("keeps the same hit active when a batch for an earlier page arrives later (B7)", () => {
    start("search-1");
    store().addBatch(batch("search-1", { matches: [{ page: 4, hits: [hit(1), hit(2)] }] }));
    store().setActiveIndex(DOC, 1);
    store().addBatch(batch("search-1", { matches: [{ page: 1, hits: [hit(1)] }], done: true }));
    expect(doc().flat[doc().activeIndex]).toEqual({ page: 4, hitIndex: 1 });
    expect(indexOfHit(doc().flat, { page: 4, hitIndex: 1 })).toBe(2);
  });
});

describe("textless and progress", () => {
  it("records progress and the textless flag of the done batch", () => {
    start("search-1");
    store().addBatch(batch("search-1", { pagesSearched: 3, pageCount: 10 }));
    expect(doc()).toMatchObject({ pagesSearched: 3, pageCount: 10, done: false, textless: false });
    store().addBatch(batch("search-1", { pagesSearched: 10, pageCount: 10, done: true, textless: true }));
    expect(doc()).toMatchObject({ pagesSearched: 10, done: true, textless: true });
  });

  it("ignores `textless` on batches that are not the done batch", () => {
    start("search-1");
    store().addBatch(batch("search-1", { pagesSearched: 1, pageCount: 10, textless: true }));
    expect(doc().textless).toBe(false);
  });
});

describe("per-document state (B9)", () => {
  it("keeps each document's query, options and results independent", () => {
    store().open("doc-b");
    store().setQuery(DOC, "alpha");
    store().setQuery("doc-b", "beta");
    store().toggleWholeWord("doc-b");
    start("a", DOC);
    store().addBatch(batch("a", { matches: [{ page: 0, hits: [hit(0)] }] }));

    expect(doc(DOC)).toMatchObject({ query: "alpha", wholeWord: false });
    expect(doc("doc-b")).toMatchObject({ query: "beta", wholeWord: true });
    expect(doc(DOC).flat).toHaveLength(1);
    expect(doc("doc-b").flat).toHaveLength(0);
  });

  it("routes a batch to the document that owns its search id, even if another is focused", () => {
    store().open("doc-b");
    start("a", DOC);
    store().focusDoc("doc-b");
    store().addBatch(batch("a", { matches: [{ page: 2, hits: [hit(0)] }], done: true }));
    expect(doc(DOC).flat).toEqual([{ page: 2, hitIndex: 0 }]);
    expect(doc("doc-b").flat).toEqual([]);
  });

  it("tracks the open flag of the focused document for the toolbar", () => {
    store().open("doc-b");
    expect(store().isOpen).toBe(true);
    store().close("doc-b");
    expect(store().isOpen).toBe(false);
    store().focusDoc(DOC);
    expect(store().isOpen).toBe(true);
    store().removeDoc(DOC);
    expect(store().byDoc[DOC]).toBeUndefined();
  });

  it("close() drops results but keeps the query for the next Ctrl+F", () => {
    store().setQuery(DOC, "alpha");
    start("a");
    store().addBatch(batch("a", { matches: [{ page: 0, hits: [hit(0)] }] }));
    store().close(DOC);
    expect(doc()).toMatchObject({ isOpen: false, query: "alpha", searchId: null, flat: [], done: false });
  });
});

describe("invalidate (B4)", () => {
  it("drops results and the search id but keeps the query", () => {
    store().setQuery(DOC, "alpha");
    start("a");
    store().addBatch(batch("a", { matches: [{ page: 0, hits: [hit(0)] }], done: true }));
    store().invalidate(DOC);
    expect(doc()).toMatchObject({ query: "alpha", searchId: null, searchKey: null, flat: [], done: false, isOpen: true });
    // a late batch from the dropped search must not resurrect the stale hits
    store().addBatch(batch("a", { matches: [{ page: 0, hits: [hit(0)] }], done: true }));
    expect(doc().flat).toHaveLength(0);
  });
});

// ---- search v2 (phase 2) -------------------------------------------------------------------

const zone = (outlineItemId: string | null, score: number | null, extra: Partial<SearchHit> = {}): SearchHit => ({
  ...hit(0),
  outlineItemId,
  score,
  ...extra,
});
const startProximity = (searchId: string, id = DOC) =>
  store().startNewSearch(id, searchId, {
    key: searchId,
    revision: 0,
    query: { text: "a b", mode: "proximity", proximity: { window: 500 }, scope: { kind: "all" }, caseSensitive: false, wholeWord: false, ignoreDiacritics: true, excludeHeadersFooters: false },
  });
// p1: chapter A 300 · p2: A 100 and B 500 · p3: B 200
const sampleMatches = [
  { page: 1, hits: [zone("A", 300)] },
  { page: 2, hits: [zone("A", 100), zone("B", 500)] },
  { page: 3, hits: [zone("B", 200)] },
];

describe("result mode, ranking and the visible order", () => {
  it("remembers the mode of the search that produced the results", () => {
    startProximity("p");
    expect(doc().resultMode).toBe("proximity");
    expect(doc().searchQuery?.proximity).toEqual({ window: 500 });
    start("q");
    expect(doc().resultMode).toBe("phrase");
    expect(doc().searchQuery).toBeNull();
  });

  it("lists by position until the done batch says `ranked`, then by compactness within groups", () => {
    startProximity("p");
    store().addBatch(batch("p", { matches: sampleMatches, pagesSearched: 3, pageCount: 3 }));
    expect(doc().ranked).toBe(false);
    expect(doc().flat.map((r) => `${r.page}.${r.hitIndex}`)).toEqual(["1.0", "2.0", "2.1", "3.0"]);
    expect(doc().groups.map((g) => g.id)).toEqual(["A", "B"]);

    store().addBatch(batch("p", { done: true, ranked: true, pagesSearched: 3, pageCount: 3 }));
    expect(doc().ranked).toBe(true);
    // A: 100 (p2), 300 (p1) · B: 200 (p3), 500 (p2.1); groups by best hit A(100) < B(200)
    expect(doc().flat.map((r) => `${r.page}.${r.hitIndex}`)).toEqual(["2.0", "1.0", "3.0", "2.1"]);
  });

  it("keeps position order when the user prefers it, and re-sorts live when the preference changes", () => {
    startProximity("p");
    store().addBatch(batch("p", { matches: sampleMatches, done: true, ranked: true, pagesSearched: 3, pageCount: 3 }));
    store().setActiveIndex(DOC, 3); // the 4th item of the compact order: page 2, hit 1 (score 500)
    expect(doc().active).toEqual({ page: 2, hitIndex: 1 });

    useSearchPrefs.getState().setSort("position");
    expect(doc().flat.map((r) => `${r.page}.${r.hitIndex}`)).toEqual(["1.0", "2.0", "2.1", "3.0"]);
    expect(doc().active).toEqual({ page: 2, hitIndex: 1 }); // the same hit stays active…
    expect(doc().activeIndex).toBe(2); // …and "X de N" follows its new position
    useSearchPrefs.getState().setSort("compact");
    expect(doc().activeIndex).toBe(3);
  });

  it("lands on the most compact zone when ranking arrives before the user moved, but never moves a hit the user chose", () => {
    startProximity("p");
    store().addBatch(batch("p", { matches: sampleMatches, pagesSearched: 3, pageCount: 3 }));
    expect(doc().active).toEqual({ page: 1, hitIndex: 0 }); // first by position
    store().addBatch(batch("p", { done: true, ranked: true, pagesSearched: 3, pageCount: 3 }));
    expect(doc().active).toEqual({ page: 2, hitIndex: 0 }); // best score
    expect(doc().activeIndex).toBe(0);

    startProximity("p2");
    store().addBatch(batch("p2", { matches: sampleMatches, pagesSearched: 3, pageCount: 3 }));
    store().setActiveIndex(DOC, 3); // user picked page 3's zone
    store().addBatch(batch("p2", { done: true, ranked: true, pagesSearched: 3, pageCount: 3 }));
    expect(doc().active).toEqual({ page: 3, hitIndex: 0 });
    expect(doc().activeIndex).toBe(2); // its position in the compact order
  });

  it("walks next/previous in the visible (compact) order, wrapping", () => {
    startProximity("p");
    store().addBatch(batch("p", { matches: sampleMatches, done: true, ranked: true, pagesSearched: 3, pageCount: 3 }));
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(`${doc().active?.page}.${doc().active?.hitIndex}`);
      store().nextMatch(DOC);
    }
    expect(seen).toEqual(["2.0", "1.0", "3.0", "2.1"]);
    expect(doc().activeIndex).toBe(0); // wrapped
    store().prevMatch(DOC);
    expect(doc().active).toEqual({ page: 2, hitIndex: 1 });
  });

  it("does not rank a phrase search, whatever the sort preference", () => {
    start("q");
    store().addBatch(batch("q", { matches: [{ page: 2, hits: [zone("A", null)] }, { page: 1, hits: [zone("A", null)] }], done: true }));
    expect(doc().flat.map((r) => r.page)).toEqual([1, 2]);
  });
});

describe("groups", () => {
  it("is a flat list when no hit has an outline entry", () => {
    start("q");
    store().addBatch(batch("q", { matches: [{ page: 0, hits: [zone(null, null)] }], done: true }));
    expect(doc().grouped).toBe(false);
  });

  it("collapses and expands a group without touching the order, and expands it when a hit inside is activated", () => {
    startProximity("p");
    store().addBatch(batch("p", { matches: sampleMatches, done: true, pagesSearched: 3, pageCount: 3 }));
    store().toggleGroup(DOC, "B");
    expect(doc().collapsed).toEqual({ B: true });
    expect(doc().flat).toHaveLength(4); // collapsed hits stay in the order (they still count for "X de N")
    store().setActiveIndex(DOC, 3); // a hit of group B
    expect(doc().collapsed).toEqual({});
    store().toggleGroup(DOC, null);
    expect(Object.keys(doc().collapsed)).toHaveLength(1);
  });

  it("activateHit finds a hit by identity whatever its position", () => {
    startProximity("p");
    store().addBatch(batch("p", { matches: sampleMatches, done: true, ranked: true, pagesSearched: 3, pageCount: 3 }));
    store().activateHit(DOC, { page: 3, hitIndex: 0 });
    expect(doc().active).toEqual({ page: 3, hitIndex: 0 });
    expect(doc().activeIndex).toBe(2);
    const nonce = doc().activateNonce;
    store().activateHit(DOC, { page: 99, hitIndex: 0 }); // unknown: ignored
    expect(doc().activateNonce).toBe(nonce);
  });
});

describe("furniture, errors and scope", () => {
  it("collects the excluded header/footer rects per page and clears them with the results", () => {
    start("q");
    store().addBatch(
      batch("q", {
        furniture: [
          { page: 1, rects: [{ x: 1, y: 2, width: 3, height: 4 }] },
          { page: 2, rects: [] },
        ],
      }),
    );
    store().addBatch(batch("q", { furniture: [{ page: 3, rects: [{ x: 9, y: 9, width: 1, height: 1 }] }] }));
    expect(Object.keys(doc().furniture)).toEqual(["1", "2", "3"]);
    expect(doc().furniture[1]).toHaveLength(1);
    store().invalidate(DOC);
    expect(doc().furniture).toEqual({});
  });

  it("records why a search failed, only for the current search id", () => {
    start("q");
    store().finishWithError(DOC, "stale", { kind: "failed", message: "x" });
    expect(doc().error).toBeNull();
    store().finishWithError(DOC, "q", { kind: "invalid", message: "bad window" });
    expect(doc()).toMatchObject({ done: true, error: { kind: "invalid", message: "bad window" } });
    start("r");
    expect(doc().error).toBeNull();
  });

  it("keeps the scope across new searches and closing, per document", () => {
    store().setScope(DOC, { kind: "chapter", itemId: "1.0" });
    store().open("doc-b");
    expect(doc("doc-b").scope).toEqual({ kind: "all" });
    start("q");
    store().close(DOC);
    expect(doc().scope).toEqual({ kind: "chapter", itemId: "1.0" });
    store().setQuery(DOC, "again");
    expect(doc().scope).toEqual({ kind: "chapter", itemId: "1.0" });
  });
});

describe("panel width", () => {
  it("clamps to 300..520", () => {
    expect(clampDockedWidth(100)).toBe(300);
    expect(clampDockedWidth(400.4)).toBe(400);
    expect(clampDockedWidth(9000)).toBe(520);
    store().setPanelWidth(1);
    expect(store().panelWidth).toBe(300);
  });
});
