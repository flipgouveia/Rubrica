import { beforeEach, describe, expect, it } from "vitest";
import type { DocInfo } from "../ipc/bindings";
import { computeRectScroll, useViewerStore } from "./store";

function makeDocInfo(docId: string, overrides: Partial<DocInfo> = {}): DocInfo {
  return {
    docId,
    path: `${docId}.pdf`,
    pageCount: 3,
    pages: [{ width: 612, height: 792 }, { width: 612, height: 792 }, { width: 612, height: 792 }],
    encrypted: false,
    dirty: false,
    revision: 0,
    hasForm: false,
    ...overrides,
  };
}

beforeEach(() => {
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

describe("tab lifecycle", () => {
  it("opens a new tab and makes it active", () => {
    useViewerStore.getState().openTab(makeDocInfo("doc-a"));
    const state = useViewerStore.getState();
    expect(state.tabs.map((t) => t.docId)).toEqual(["doc-a"]);
    expect(state.activeTabId).toBe("doc-a");
    expect(state.tabs[0].zoomMode).toBe("fit-width");
  });

  it("re-opening an already-open doc reuses the tab instead of duplicating it", () => {
    useViewerStore.getState().openTab(makeDocInfo("doc-a"));
    useViewerStore.getState().openTab(makeDocInfo("doc-b"));
    useViewerStore.getState().setZoom("doc-a", 2, "custom");

    useViewerStore.getState().openTab(makeDocInfo("doc-a", { revision: 3, dirty: true }));

    const state = useViewerStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("doc-a");
    // Re-opening updates DocInfo but preserves view state (zoom) rather than resetting it.
    expect(state.tabs.find((t) => t.docId === "doc-a")?.zoom).toBe(2);
    expect(state.tabs.find((t) => t.docId === "doc-a")?.info.revision).toBe(3);
  });

  it("closing the active tab activates the tab to its left", () => {
    useViewerStore.getState().openTab(makeDocInfo("doc-a"));
    useViewerStore.getState().openTab(makeDocInfo("doc-b"));
    useViewerStore.getState().openTab(makeDocInfo("doc-c"));
    expect(useViewerStore.getState().activeTabId).toBe("doc-c");

    useViewerStore.getState().closeTab("doc-c");

    const state = useViewerStore.getState();
    expect(state.tabs.map((t) => t.docId)).toEqual(["doc-a", "doc-b"]);
    expect(state.activeTabId).toBe("doc-b");
  });

  it("closing an inactive tab leaves the active tab untouched", () => {
    useViewerStore.getState().openTab(makeDocInfo("doc-a"));
    useViewerStore.getState().openTab(makeDocInfo("doc-b"));
    useViewerStore.getState().setActiveTab("doc-a");

    useViewerStore.getState().closeTab("doc-b");

    expect(useViewerStore.getState().activeTabId).toBe("doc-a");
    expect(useViewerStore.getState().tabs).toHaveLength(1);
  });

  it("closing the last tab leaves no active tab", () => {
    useViewerStore.getState().openTab(makeDocInfo("doc-a"));
    useViewerStore.getState().closeTab("doc-a");
    expect(useViewerStore.getState().activeTabId).toBeNull();
    expect(useViewerStore.getState().tabs).toHaveLength(0);
  });

  it("scrollToPage sets both currentPage and a pending scroll signal, cleared once consumed", () => {
    useViewerStore.getState().openTab(makeDocInfo("doc-a"));
    useViewerStore.getState().scrollToPage("doc-a", 2);
    expect(useViewerStore.getState().tabs[0].currentPage).toBe(2);
    expect(useViewerStore.getState().tabs[0].pendingScrollTo).toBe(2);

    useViewerStore.getState().clearPendingScroll("doc-a");
    expect(useViewerStore.getState().tabs[0].pendingScrollTo).toBeNull();
    expect(useViewerStore.getState().tabs[0].currentPage).toBe(2); // page itself is untouched
  });

  it("applyDocStateChanged updates revision/dirty without touching view state", () => {
    useViewerStore.getState().openTab(makeDocInfo("doc-a"));
    useViewerStore.getState().setZoom("doc-a", 1.5, "custom");
    useViewerStore.getState().applyDocStateChanged("doc-a", { revision: 4, dirty: true });

    const tab = useViewerStore.getState().tabs[0];
    expect(tab.info.revision).toBe(4);
    expect(tab.info.dirty).toBe(true);
    expect(tab.zoom).toBe(1.5);
  });
});

describe("computeRectScroll (B5: bring a hit's rect into view)", () => {
  const pages = Array.from({ length: 10 }, () => ({ width: 612, height: 792 }));
  const view = { width: 1200, height: 800, scrollTop: 0, scrollLeft: 0 };
  // Rect near the top of its page: PDF y=720 + h=14 -> 58pt below the page top.
  const rect = { x: 72, y: 720, width: 40, height: 14 };

  it("does nothing when the rect is already comfortably visible", () => {
    expect(computeRectScroll({ pages, zoom: 1, page: 0, rect, view })).toBeNull();
  });

  it("scrolls past the page start so the rect itself (not just its page) is centred", () => {
    const target = computeRectScroll({ pages, zoom: 1, page: 4, rect, view });
    const rectTop = 24 + 4 * (792 + 16) + 58;
    expect(target?.top).toBe(Math.round(rectTop - (800 - 14) / 2));
    expect(target?.left).toBe(0);
  });

  it("keeps the rect below the top inset (compact bar)", () => {
    const rectTop = 24 + 58;
    const target = computeRectScroll({ pages, zoom: 1, page: 0, rect, view: { ...view, scrollTop: 100 }, topInset: 64 });
    expect(target).not.toBeNull();
    expect(rectTop - (target?.top ?? 0)).toBeGreaterThanOrEqual(64);
  });

  it("accounts for zoom: the same rect is further down at a higher zoom", () => {
    const at1 = computeRectScroll({ pages, zoom: 1, page: 3, rect, view });
    const at4 = computeRectScroll({ pages, zoom: 4, page: 3, rect, view });
    expect(at4!.top).toBeGreaterThan(at1!.top * 3);
    const rectTop4 = 24 + 3 * (792 * 4 + 16) + 58 * 4;
    expect(at4!.top).toBe(Math.round(rectTop4 - (800 - 14 * 4) / 2));
  });

  it("scrolls horizontally when the page is wider than the viewport and the rect is off to the side", () => {
    const wide = { x: 500, y: 720, width: 40, height: 14 };
    const target = computeRectScroll({ pages, zoom: 4, page: 0, rect: wide, view });
    expect(target?.left).toBeGreaterThan(0);
  });

  it("never scrolls past the document's end or before its start", () => {
    const last = computeRectScroll({ pages, zoom: 1, page: 9, rect: { x: 72, y: 20, width: 40, height: 14 }, view });
    const total = 2 * 24 - 16 + 10 * (792 + 16);
    expect(last!.top).toBeLessThanOrEqual(total - 800);
    expect(computeRectScroll({ pages, zoom: 1, page: 0, rect, view: { ...view, scrollTop: 500 } })!.top).toBe(0);
  });

  it("returns null for an unknown page", () => {
    expect(computeRectScroll({ pages, zoom: 1, page: 99, rect, view })).toBeNull();
  });
});
