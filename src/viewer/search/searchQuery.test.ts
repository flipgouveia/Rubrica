// The SearchQuery built from the UI state (CONTRACTS v1.2.0 §3): every option, every scope kind.
import { describe, expect, it } from "vitest";
import type { OutlineItem } from "../../ipc/bindings";
import type { OutlineState } from "../outline/outlineStore";
import { buildSearchQuery, searchKeyFor, type QueryInputs } from "./searchQuery";
import { ancestorIds, isValidPageRange, resolveScope } from "./searchScope";

const item = (id: string, title: string, page: number | null, pageEnd: number | null, depth: number, children: OutlineItem[] = []): OutlineItem => ({
  id,
  title,
  page,
  pageEnd,
  depth,
  children,
});

// 40-page document, 0-based ranges
const ITEMS: OutlineItem[] = [
  item("0", "1. Objeto", 0, 12, 0, [item("0.0", "1.1 Âmbito", 0, 5, 1), item("0.1", "1.2 Partes", 6, 12, 1)]),
  item("1", "2. Rescisão", 13, 19, 0, [item("1.0", "2.1 Por incumprimento", 15, 17, 1), item("1.1", "2.2 Sem destino", null, null, 1)]),
  item("2", "3. Preço", 20, 39, 0),
];
const READY: OutlineState = { status: "ready", items: ITEMS };

function inputs(partial: Partial<QueryInputs> = {}): QueryInputs {
  return {
    text: "rescisão prazo",
    caseSensitive: false,
    wholeWord: false,
    scope: { kind: "all" },
    mode: "phrase",
    window: 500,
    ignoreDiacritics: true,
    excludeHeadersFooters: false,
    outline: READY,
    currentPage: 0,
    pageCount: 40,
    ...partial,
  };
}

function query(partial: Partial<QueryInputs> = {}) {
  const build = buildSearchQuery(inputs(partial));
  if (!build.ok) throw new Error(`no query: ${build.problem}`);
  return build.query;
}

describe("buildSearchQuery — options", () => {
  it("builds a phrase query over the whole document with the default options", () => {
    expect(query()).toEqual({
      text: "rescisão prazo",
      mode: "phrase",
      proximity: null,
      scope: { kind: "all" },
      caseSensitive: false,
      wholeWord: false,
      ignoreDiacritics: true,
      excludeHeadersFooters: false,
    });
  });

  it("carries the window only in proximity mode", () => {
    expect(query({ mode: "proximity", window: 250 })).toMatchObject({ mode: "proximity", proximity: { window: 250 } });
    expect(query({ mode: "phrase", window: 250 }).proximity).toBeNull();
  });

  it("passes case, whole word, accents and headers/footers through", () => {
    expect(query({ caseSensitive: true, wholeWord: true, ignoreDiacritics: false, excludeHeadersFooters: true })).toMatchObject({
      caseSensitive: true,
      wholeWord: true,
      ignoreDiacritics: false,
      excludeHeadersFooters: true,
    });
  });

  it("changes the search key when ANY option changes (so each one re-runs the search)", () => {
    const base = searchKeyFor(query(), 0);
    const variants = [
      query({ text: "outro" }),
      query({ mode: "proximity" }),
      query({ mode: "proximity", window: 100 }),
      query({ caseSensitive: true }),
      query({ wholeWord: true }),
      query({ ignoreDiacritics: false }),
      query({ excludeHeadersFooters: true }),
      query({ scope: { kind: "pages", from: 1, to: 2 } }),
    ].map((q) => searchKeyFor(q, 0));
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
    expect(searchKeyFor(query(), 1)).not.toBe(base); // the revision too
    expect(searchKeyFor(query(), 0)).toBe(base); // and nothing else
  });

  it("has nothing to search for an empty text, or a proximity query with only exclusions", () => {
    expect(buildSearchQuery(inputs({ text: "   " }))).toMatchObject({ ok: false, problem: "empty" });
    expect(buildSearchQuery(inputs({ text: "-anexo", mode: "proximity" }))).toMatchObject({ ok: false, problem: "terms" });
    expect(buildSearchQuery(inputs({ text: "-anexo", mode: "phrase" })).ok).toBe(true); // in phrase mode it is just text
  });
});

describe("buildSearchQuery — scope", () => {
  it("sends a chapter as an outline scope by id", () => {
    expect(query({ scope: { kind: "chapter", itemId: "1.0" } }).scope).toEqual({ kind: "outline", itemId: "1.0" });
  });

  it("'current chapter' is the TOP-LEVEL entry containing the visible page, not the deepest", () => {
    // page 16 (0-based) is inside 2.1 (15-17) inside 2. Rescisão (13-19)
    expect(query({ scope: { kind: "currentChapter" }, currentPage: 16 }).scope).toEqual({ kind: "outline", itemId: "1" });
    expect(query({ scope: { kind: "currentChapter" }, currentPage: 0 }).scope).toEqual({ kind: "outline", itemId: "0" });
    expect(query({ scope: { kind: "currentChapter" }, currentPage: 39 }).scope).toEqual({ kind: "outline", itemId: "2" });
  });

  it("converts the 1-based page range of the UI into the 0-based, inclusive IPC range", () => {
    expect(query({ scope: { kind: "pages", from: 14, to: 20 } }).scope).toEqual({ kind: "pages", from: 13, to: 19 });
    expect(query({ scope: { kind: "pages", from: 1, to: 40 } }).scope).toEqual({ kind: "pages", from: 0, to: 39 });
    expect(query({ scope: { kind: "pages", from: 7, to: 7 } }).scope).toEqual({ kind: "pages", from: 6, to: 6 });
  });

  it("refuses an invalid page range instead of sending it", () => {
    for (const [from, to] of [
      [0, 5],
      [5, 4],
      [1, 41],
      [null, 5],
      [3, null],
      [1.5, 3],
    ] as const) {
      expect(buildSearchQuery(inputs({ scope: { kind: "pages", from, to } }))).toMatchObject({ ok: false, problem: "scope" });
    }
    expect(isValidPageRange(1, 40, 40)).toBe(true);
    expect(isValidPageRange(2, 1, 40)).toBe(false);
  });

  it("waits while the outline is loading, and falls back to the whole document when there is none", () => {
    expect(buildSearchQuery(inputs({ scope: { kind: "currentChapter" }, outline: { status: "loading" } }))).toMatchObject({
      ok: false,
      problem: "outline",
    });
    // a page range does not need the outline
    expect(buildSearchQuery(inputs({ scope: { kind: "pages", from: 1, to: 2 }, outline: { status: "loading" } })).ok).toBe(true);
    for (const outline of [{ status: "ready", items: [] }, { status: "error" }] as OutlineState[]) {
      const build = buildSearchQuery(inputs({ scope: { kind: "chapter", itemId: "1" }, outline }));
      expect(build.ok && build.query.scope).toEqual({ kind: "all" });
      expect(build.ok && build.scope).toMatchObject({ kind: "all", fellBack: true });
    }
  });

  it("falls back to the whole document for an entry that vanished or has no destination", () => {
    expect(query({ scope: { kind: "chapter", itemId: "9.9" } }).scope).toEqual({ kind: "all" });
    expect(query({ scope: { kind: "chapter", itemId: "1.1" } }).scope).toEqual({ kind: "all" });
  });
});

describe("resolveScope", () => {
  it("counts the pages of every option", () => {
    expect(resolveScope({ kind: "all" }, ITEMS, 0, 40)).toMatchObject({ kind: "all", pages: 40 });
    expect(resolveScope({ kind: "chapter", itemId: "1" }, ITEMS, 0, 40)).toMatchObject({ kind: "chapter", pages: 7, current: false });
    expect(resolveScope({ kind: "currentChapter" }, ITEMS, 14, 40)).toMatchObject({ kind: "chapter", pages: 7, current: true });
    expect(resolveScope({ kind: "pages", from: 14, to: 20 }, ITEMS, 0, 40)).toMatchObject({ kind: "pages", pages: 7, from: 14, to: 20 });
  });

  it("finds the ancestors of an entry to open them in the tree", () => {
    expect(ancestorIds(ITEMS, "1.0")).toEqual(["1"]);
    expect(ancestorIds(ITEMS, "2")).toEqual([]);
    expect(ancestorIds(ITEMS, "nope")).toEqual([]);
  });
});
