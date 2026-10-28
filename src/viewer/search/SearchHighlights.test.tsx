// The highlight layer: colour per term position (user colours, cycling), active outline, proximity
// window, hits that span a page break drawn on BOTH pages, and dimmed header/footer furniture.
import "../../i18n";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePageViewport } from "../../chrome/tool-api";
import type { Rect, SearchBatch, SearchHit } from "../../ipc/bindings";
import { SearchHighlights } from "./SearchHighlights";
import { DEFAULT_HIGHLIGHT_COLORS } from "./searchColors";
import { resetSearchPrefsForTests, useSearchPrefs } from "./searchPrefs";
import { useSearchStore } from "./searchStore";

const DOC = "hl-doc";
const rect = (x: number, y = 700, width = 40, height = 14): Rect => ({ x, y, width, height });
const store = () => useSearchStore.getState();

function hit(rects: SearchHit["rects"], extra: Partial<SearchHit> = {}): SearchHit {
  return {
    rects,
    charStart: 0,
    charLen: 1,
    context: { before: "", matched: "x", after: "", terms: [] },
    windowRects: [],
    score: null,
    spansPages: null,
    outlineItemId: null,
    ...extra,
  };
}
const batch = (partial: Partial<SearchBatch>): SearchBatch => ({
  searchId: "s",
  matches: [],
  done: true,
  pagesSearched: 5,
  pageCount: 5,
  textless: false,
  ranked: false,
  furniture: [],
  ...partial,
});

function load(matches: SearchBatch["matches"], furniture: SearchBatch["furniture"] = []) {
  store().open(DOC);
  store().startNewSearch(DOC, "s", { key: "k", revision: 0 });
  store().addBatch(batch({ matches, furniture }));
}

function renderPage(page: number, zoom = 1) {
  const viewport = makePageViewport(DOC, page, 612, 792, zoom, 0);
  return render(<SearchHighlights page={page} viewport={viewport} />);
}

const rects = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("[data-search-rect]"));

beforeEach(() => {
  resetSearchPrefsForTests();
  useSearchStore.setState({ byDoc: {}, docId: null, isOpen: false });
});
afterEach(cleanup);

describe("colour per term", () => {
  it("paints each rect with its term position's colour, cycling after the fourth", () => {
    const six = Array.from({ length: 6 }, (_, term) => ({ page: 0, rect: rect(10 + term * 50), term }));
    load([{ page: 0, hits: [hit(six)] }]);
    const { container } = renderPage(0);
    const painted = rects(container);
    expect(painted.map((el) => el.dataset.term)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(painted.map((el) => el.dataset.color)).toEqual([...DEFAULT_HIGHLIGHT_COLORS, DEFAULT_HIGHLIGHT_COLORS[0], DEFAULT_HIGHLIGHT_COLORS[1]]);
    expect(painted.map((el) => el.style.background)).toEqual(["var(--search-t1)", "var(--search-t2)", "var(--search-t3)", "var(--search-t4)", "var(--search-t1)", "var(--search-t2)"]);
  });

  it("uses the user's colours at ~50 % opacity, and follows a change live", () => {
    load([{ page: 0, hits: [hit([{ page: 0, rect: rect(10), term: 1 }])] }]);
    useSearchPrefs.getState().setHighlightColor(1, "#a78bfa");
    const { container } = renderPage(0);
    expect(rects(container)[0].dataset.color).toBe("#A78BFA");
    expect(rects(container)[0].style.background).toBe("rgba(167, 139, 250, 0.5)");
    // phrase mode: the engine reports term 0 everywhere -> colour 1
    useSearchPrefs.getState().resetHighlightColors();
    useSearchPrefs.getState().setHighlightColor(0, "#60a5fa");
    cleanup();
    store().invalidate(DOC);
    store().startNewSearch(DOC, "s2", { key: "k2", revision: 0 });
    store().addBatch(batch({ searchId: "s2", matches: [{ page: 0, hits: [hit([{ page: 0, rect: rect(10), term: 0 }])] }] }));
    expect(rects(renderPage(0).container)[0].style.background).toBe("rgba(96, 165, 250, 0.5)");
  });
});

describe("active hit and proximity window", () => {
  it("outlines every rect of the active hit with --search-active and nothing else", () => {
    load([{ page: 0, hits: [hit([{ page: 0, rect: rect(10), term: 0 }, { page: 0, rect: rect(70), term: 0 }]), hit([{ page: 0, rect: rect(200), term: 0 }])] }]);
    const { container } = renderPage(0);
    const [a, b, c] = rects(container);
    expect(a.dataset.active).toBe("true");
    expect(b.dataset.active).toBe("true");
    expect(c.dataset.active).toBeUndefined();
    expect(a.style.outline).toContain("var(--search-active)");
    expect(c.style.outline).toBe("");
    store().nextMatch(DOC);
    cleanup();
    const after = rects(renderPage(0).container);
    expect(after.map((el) => el.dataset.active)).toEqual([undefined, undefined, "true"]);
  });

  it("draws the window of a proximity zone as one soft box, outlined only when active", () => {
    const zone = (x: number) =>
      hit([{ page: 0, rect: rect(x), term: 0 }], {
        windowRects: [
          { page: 0, rect: rect(x, 700, 300, 14) },
          { page: 0, rect: rect(x, 686, 120, 14) },
        ],
        score: 200,
      });
    load([{ page: 0, hits: [zone(10), zone(100)] }]);
    const { container } = renderPage(0);
    const windows = Array.from(container.querySelectorAll<HTMLElement>("[data-search-window]"));
    expect(windows).toHaveLength(2);
    expect(windows[0].dataset.active).toBe("true");
    expect(windows[0].style.background).toBe("var(--search-window)");
    expect(windows[0].style.boxShadow).toContain("var(--search-window-line)");
    expect(windows[1].dataset.active).toBeUndefined();
    expect(windows[1].style.boxShadow).toBe("");
    // one box around BOTH line rects: from x=10 (minus the 3px pad) and tall enough for two lines
    expect(parseFloat(windows[0].style.left)).toBe(7);
    expect(parseFloat(windows[0].style.width)).toBe(306);
    expect(parseFloat(windows[0].style.height)).toBe(28 + 6);
  });

  it("draws nothing for a phrase hit's window (none) and nothing when there are no hits", () => {
    load([{ page: 0, hits: [hit([{ page: 0, rect: rect(10), term: 0 }])] }]);
    expect(renderPage(0).container.querySelectorAll("[data-search-window]")).toHaveLength(0);
    cleanup();
    expect(renderPage(3).container.firstChild).toBeNull();
  });
});

describe("a hit that spans a page break", () => {
  // starts on page 2 (0-based), continues on page 3
  const spanning = hit(
    [
      { page: 2, rect: rect(300, 60), term: 0 },
      { page: 3, rect: rect(72, 740), term: 1 },
    ],
    {
      spansPages: [2, 3],
      windowRects: [
        { page: 2, rect: rect(300, 60, 200, 14) },
        { page: 3, rect: rect(72, 740, 150, 14) },
      ],
      score: 120,
    },
  );

  it("draws each rect and window piece on its OWN page", () => {
    load([{ page: 2, hits: [spanning] }]);
    const first = renderPage(2);
    expect(rects(first.container)).toHaveLength(1);
    expect(rects(first.container)[0].dataset.term).toBe("0");
    expect(first.container.querySelectorAll("[data-search-window]")).toHaveLength(1);
    first.unmount();

    const second = renderPage(3);
    expect(rects(second.container)).toHaveLength(1);
    expect(rects(second.container)[0].dataset.term).toBe("1");
    expect(second.container.querySelectorAll("[data-search-window]")).toHaveLength(1);
    // active on the second page too: identity is the START page + index
    expect(rects(second.container)[0].dataset.active).toBe("true");
    second.unmount();

    // neither the page before nor the one after the pair is touched
    expect(renderPage(1).container.firstChild).toBeNull();
    cleanup();
    expect(renderPage(4).container.firstChild).toBeNull();
  });

  it("does not leak an ordinary hit onto the next page", () => {
    load([{ page: 2, hits: [hit([{ page: 2, rect: rect(10), term: 0 }])] }]);
    expect(renderPage(3).container.firstChild).toBeNull();
  });
});

describe("headers and footers excluded by the search", () => {
  it("dims and strikes the furniture rects of the page, with an explanation", () => {
    load([{ page: 0, hits: [hit([{ page: 0, rect: rect(10), term: 0 }])] }], [{ page: 0, rects: [rect(72, 760, 400, 12), rect(250, 30, 100, 10)] }]);
    const { container } = renderPage(0);
    const dimmed = Array.from(container.querySelectorAll<HTMLElement>("[data-search-furniture]"));
    expect(dimmed).toHaveLength(2);
    expect(dimmed[0].title).toBe("Cabeçalho ou rodapé ignorado");
    expect(dimmed[0].querySelector(".top-1\\/2")).not.toBeNull(); // the strike-through line
    expect(parseFloat(dimmed[0].style.width)).toBe(400);
  });

  it("draws furniture even on a page without hits, and not on other pages", () => {
    load([], [{ page: 1, rects: [rect(72, 760, 400, 12)] }]);
    expect(renderPage(1).container.querySelectorAll("[data-search-furniture]")).toHaveLength(1);
    cleanup();
    expect(renderPage(0).container.firstChild).toBeNull();
  });

  it("scales rects with the zoom", () => {
    load([{ page: 0, hits: [hit([{ page: 0, rect: rect(10, 700, 40, 14), term: 0 }])] }]);
    const el = rects(renderPage(0, 2).container)[0];
    expect(parseFloat(el.style.width)).toBe(80);
    expect(parseFloat(el.style.height)).toBe(28);
    expect(parseFloat(el.style.left)).toBe(20);
  });
});
