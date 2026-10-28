// Search UI regression tests (Phase 1, bugs B1-B12), driven through the real <SearchPanel/> against
// the mock engine (src/ipc/mock/text.ts). Every `it` was first written against the F1.0 code and
// seen to fail for the reason named in its title (see agents/reports/s2-report.md).
//
// jsdom has no layout: the page scroller is a plain div whose scrollTop/scrollLeft are plain
// numbers, and the viewer store's page sizes drive the same geometry ViewerSurface uses.
import "../../i18n";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalShortcuts } from "../../chrome/shortcuts";
import { commands, events } from "../../ipc";
import type { DocInfo, SearchBatch, SearchHit } from "../../ipc/bindings";
import { useViewerStore } from "../store";
import { SearchPanel } from "./SearchPanel";
import { useSearchStore } from "./searchStore";

const PLACEHOLDER = "Localizar no documento";

function Harness() {
  useGlobalShortcuts();
  const activeTabId = useViewerStore((s) => s.activeTabId);
  return (
    <div>
      <div data-testid="viewer-scroll" />
      {activeTabId && <SearchPanel docId={activeTabId} />}
    </div>
  );
}

async function openDoc(path: string): Promise<DocInfo> {
  const result = await commands.docOpen(path);
  if (result.status !== "ok") throw new Error("docOpen failed");
  useViewerStore.getState().openTab(result.data);
  return result.data;
}

function makeScroller(): HTMLElement {
  const el = screen.getByTestId("viewer-scroll");
  Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, "scrollLeft", { value: 0, writable: true, configurable: true });
  return el;
}

function hit(x: number, matched = "Rubrica", before = "before ", after = " after"): SearchHit {
  return {
    rects: [{ page: 0, rect: { x, y: 700, width: 40, height: 14 }, term: 0 }],
    charStart: x,
    charLen: matched.length,
    context: { before, matched, after, terms: [] },
    windowRects: [],
    score: null,
    spansPages: null,
    outlineItemId: null,
  };
}

function batch(searchId: string, partial: Partial<SearchBatch>): SearchBatch {
  return { searchId, matches: [], done: false, pagesSearched: 0, pageCount: 1, textless: false, ranked: false, furniture: [], ...partial };
}

const count = () => screen.getByTestId("search-count");

async function typeQuery(user: ReturnType<typeof userEvent.setup>, query: string) {
  const input = await screen.findByPlaceholderText(PLACEHOLDER);
  await user.clear(input);
  await user.type(input, query);
  return input;
}

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  localStorage.clear();
  user = userEvent.setup();
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useSearchStore.setState({ byDoc: {}, docId: null, isOpen: false, mode: "compact", panelWidth: 370 });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const docId of ["mock-text-doc", "mock-form-doc", "mock-perf-doc"]) await commands.docClose(docId);
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

describe("B1 - batches emitted before text_search_start resolves are kept", () => {
  it("renders hits that arrive while the command promise is still pending", async () => {
    const info = await openDoc("text");
    vi.spyOn(commands, "textSearchStart").mockImplementation(async (_docId, searchId) => {
      // The engine streams immediately; the command resolves later.
      await events.searchBatch.emit(batch(searchId, { matches: [{ page: 0, hits: [hit(10), hit(60)] }], pagesSearched: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await events.searchBatch.emit(batch(searchId, { done: true, pagesSearched: 1 }));
      return { status: "ok", data: null };
    });
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(count()).toHaveAttribute("data-total", "2"));
    await waitFor(() => expect(count()).toHaveAttribute("data-done", "true"));
  });
});

describe("B2 - count, next/prev and the list are per hit, not per rect", () => {
  it("counts a match that wraps across two lines once", async () => {
    const info = await openDoc("text");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    // "exists only so the" straddles the mock's 60-column line break on every page.
    await typeQuery(user, "exists only so the");
    await waitFor(() => expect(count()).toHaveAttribute("data-done", "true"), { timeout: 3000 });
    expect(count()).toHaveAttribute("data-total", "5"); // 5 pages x 1 hit (2 rects each)
    expect(count()).toHaveTextContent("1 de 5");
  });
});

describe("B3 - closing cancels the running search and the pending debounce", () => {
  it("calls text_search_cancel when the close button is pressed mid-search", async () => {
    const info = await openDoc("perf");
    const cancel = vi.spyOn(commands, "textSearchCancel");
    const start = vi.spyOn(commands, "textSearchStart");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(start).toHaveBeenCalled());
    const searchId = start.mock.calls[0][1];
    await user.click(screen.getByTestId("search-close"));
    expect(cancel).toHaveBeenCalledWith(searchId);
  });

  it("does not start a search after the panel was closed inside the debounce window", async () => {
    const info = await openDoc("text");
    const start = vi.spyOn(commands, "textSearchStart");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "Rubrica");
    await user.click(screen.getByTestId("search-close"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(start).not.toHaveBeenCalled();
  });

  it("cancels the running search when the panel unmounts", async () => {
    const info = await openDoc("perf");
    const cancel = vi.spyOn(commands, "textSearchCancel");
    const start = vi.spyOn(commands, "textSearchStart");
    const view = render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(start).toHaveBeenCalled());
    view.unmount();
    expect(cancel).toHaveBeenCalledWith(start.mock.calls[0][1]);
  });
});

describe("B4 - a revision change drops stale results and re-runs the search", () => {
  it("re-runs on doc_state_changed and hides the old hits meanwhile", async () => {
    const info = await openDoc("text");
    const start = vi.spyOn(commands, "textSearchStart");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(count()).toHaveAttribute("data-total", "10"));
    await waitFor(() => expect(count()).toHaveAttribute("data-done", "true"));
    expect(start).toHaveBeenCalledTimes(1);

    // The second search never answers: whatever is shown now cannot come from the old results.
    start.mockImplementationOnce(async () => ({ status: "ok", data: null }));
    act(() => useViewerStore.getState().applyDocStateChanged(info.docId, { revision: info.revision + 1, dirty: true }));

    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1][1]).not.toBe(start.mock.calls[0][1]);
    expect(count()).toHaveAttribute("data-total", "0");
    expect(count()).toHaveAttribute("data-done", "false");
  });
});

describe("B5 - activating a hit scrolls the rect into view", () => {
  it("scrolls the viewer so a hit on page 3 is visible, not just the page", async () => {
    const info = await openDoc("text");
    render(<Harness />);
    const scroller = makeScroller();
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(count()).toHaveAttribute("data-done", "true"));
    const before = scroller.scrollTop;
    // hits are 2 per page: the 5th hit is the first one on page 3
    for (let i = 0; i < 4; i++) await user.click(screen.getByRole("button", { name: "Ocorrência seguinte" }));
    expect(count()).toHaveTextContent("5 de 10");
    // page 3 starts at 24 + 2 * (792 + 16) = 1640; the hit sits ~58pt below the page top
    expect(scroller.scrollTop).toBeGreaterThan(before + 1000);
    expect(scroller.scrollTop).toBeLessThan(1640 + 80);
  });

  it("keeps the hit below the compact bar instead of under it", async () => {
    const info = await openDoc("text");
    render(<Harness />);
    const scroller = makeScroller();
    scroller.scrollTop = 24 + 2 * 808 + 38; // the hit's top edge would sit 20px below the viewport top
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(count()).toHaveAttribute("data-done", "true"));
    for (let i = 0; i < 4; i++) await user.click(screen.getByRole("button", { name: "Ocorrência seguinte" }));
    // rect top (page-local) = 792 - (720 + 14) = 58pt; the compact bar needs it >= ~56px below the viewport top
    const rectTop = 24 + 2 * 808 + 58;
    expect(rectTop - scroller.scrollTop).toBeGreaterThanOrEqual(56);
  });
});

describe("B6 - the result list is virtualized and shows context", () => {
  it("mounts a handful of rows for thousands of hits, with page and context", async () => {
    const info = await openDoc("text");
    vi.spyOn(commands, "textSearchStart").mockImplementation(async (_docId, searchId) => {
      const matches = Array.from({ length: 300 }, (_, page) => ({
        page,
        hits: Array.from({ length: 10 }, (_, i) => hit(10 + i * 3, "contrato", `antes ${page}.${i} `, " depois")),
      }));
      await events.searchBatch.emit(batch(searchId, { matches, done: true, pagesSearched: 300, pageCount: 300 }));
      return { status: "ok", data: null };
    });
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    act(() => useSearchStore.getState().setMode("docked"));
    await typeQuery(user, "contrato");
    await waitFor(() => expect(count()).toHaveAttribute("data-total", "3000"));
    const list = screen.getByRole("list", { name: "Resultados da pesquisa" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0]).toHaveTextContent("p. 1");
    expect(rows[0]).toHaveTextContent("antes 0.0 contrato depois");
    expect(within(rows[0]).getByText("contrato").tagName).toBe("MARK");
  });
});

describe("B7 - the active hit is tracked by index, not by object reference", () => {
  it("keeps the same hit active when a batch for an earlier page arrives later", () => {
    useSearchStore.getState().open("doc-x");
    useSearchStore.getState().startNewSearch("doc-x", "s1", { key: "k", revision: 0 });
    const emit = (page: number, hits: SearchHit[], done = false) =>
      useSearchStore.getState().addBatch(batch("s1", { matches: [{ page, hits }], done }));
    emit(4, [hit(1), hit(2)]);
    useSearchStore.getState().setActiveIndex("doc-x", 1); // second hit on page 4
    emit(1, [hit(1)], true); // late batch for an earlier page re-orders the flat list
    const doc = useSearchStore.getState().byDoc["doc-x"];
    expect(doc.flat[doc.activeIndex]).toEqual({ page: 4, hitIndex: 1 });
  });

  it("outlines every rect of the active hit and only the active hit", async () => {
    const { SearchHighlights } = await import("./SearchHighlights");
    const { makePageViewport } = await import("../../chrome/tool-api");
    useSearchStore.getState().open("doc-y");
    useSearchStore.getState().startNewSearch("doc-y", "s2", { key: "k", revision: 0 });
    const wrapped: SearchHit = {
      rects: [
        { page: 0, rect: { x: 400, y: 700, width: 100, height: 14 }, term: 0 },
        { page: 0, rect: { x: 72, y: 686, width: 60, height: 14 }, term: 0 },
      ],
      charStart: 0,
      charLen: 20,
      context: { before: "", matched: "wrapped hit", after: "", terms: [] },
      windowRects: [],
      score: null,
      spansPages: null,
      outlineItemId: null,
    };
    useSearchStore.getState().addBatch(batch("s2", { matches: [{ page: 0, hits: [wrapped, hit(10)] }], done: true }));
    const viewport = makePageViewport("doc-y", 0, 612, 792, 1, 0);
    const { container } = render(<SearchHighlights page={0} viewport={viewport} />);
    expect(container.querySelectorAll("[data-search-rect]")).toHaveLength(3);
    expect(container.querySelectorAll('[data-search-rect][data-active="true"]')).toHaveLength(2);
  });
});

describe("B8 - keyboard", () => {
  it("Enter / Shift+Enter / F3 / Shift+F3 step through results, Esc closes and cancels", async () => {
    const info = await openDoc("text");
    const cancel = vi.spyOn(commands, "textSearchCancel");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    const input = await typeQuery(user, "Rubrica");
    await waitFor(() => expect(count()).toHaveAttribute("data-done", "true"));
    expect(count()).toHaveTextContent("1 de 10");
    await user.keyboard("{Enter}");
    expect(count()).toHaveTextContent("2 de 10");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(count()).toHaveTextContent("1 de 10");
    await user.keyboard("{F3}");
    expect(count()).toHaveTextContent("2 de 10");
    await user.keyboard("{Shift>}{F3}{/Shift}");
    expect(count()).toHaveTextContent("1 de 10");
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("search-panel")).not.toBeInTheDocument());
    expect(cancel).not.toHaveBeenCalledWith(expect.anything()); // already finished: nothing to cancel
  });

  it("Esc cancels a search that is still running", async () => {
    const info = await openDoc("perf");
    const cancel = vi.spyOn(commands, "textSearchCancel");
    const start = vi.spyOn(commands, "textSearchStart");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(start).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalledWith(start.mock.calls[0][1]);
    expect(screen.queryByTestId("search-panel")).not.toBeInTheDocument();
  });

  it("Ctrl+F on an open panel focuses the field and selects its text", async () => {
    const info = await openDoc("text");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    const input = (await typeQuery(user, "Rubrica")) as HTMLInputElement;
    act(() => input.blur());
    expect(input).not.toHaveFocus();
    await user.keyboard("{Control>}f{/Control}");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Rubrica".length);
  });

  it("Ctrl+F opens the compact bar and Ctrl+Shift+F opens the docked panel", async () => {
    await openDoc("text");
    render(<Harness />);
    await user.keyboard("{Control>}f{/Control}");
    expect(await screen.findByTestId("search-panel")).toHaveAttribute("data-mode", "compact");
    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    expect(screen.getByTestId("search-panel")).toHaveAttribute("data-mode", "docked");
  });
});

describe("B9 - search state is kept per document", () => {
  it("keeps query and results when switching tabs and coming back", async () => {
    const a = await openDoc("text");
    const start = vi.spyOn(commands, "textSearchStart");
    render(<Harness />);
    act(() => useSearchStore.getState().open(a.docId));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(count()).toHaveAttribute("data-done", "true"));
    expect(count()).toHaveAttribute("data-total", "10");

    const b = await openDoc("form");
    act(() => useViewerStore.getState().setActiveTab(b.docId));
    await waitFor(() => expect(screen.queryByTestId("search-panel")).not.toBeInTheDocument());

    act(() => useViewerStore.getState().setActiveTab(a.docId));
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toHaveValue("Rubrica");
    expect(count()).toHaveAttribute("data-total", "10");
    expect(start).toHaveBeenCalledTimes(1); // no needless re-search
  });
});

describe("B10 - progress", () => {
  it("shows 'página X de N' and a thin progress bar while searching", async () => {
    const info = await openDoc("perf");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    act(() => useSearchStore.getState().setMode("docked"));
    await typeQuery(user, "Rubrica");
    await waitFor(() => expect(count()).toHaveTextContent(/página \d+ de 500/), { timeout: 3000 });
    const bar = screen.getByRole("progressbar");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(bar).toHaveAttribute("aria-valuemax", "500");
  });
});

describe("textless", () => {
  it("shows the no-searchable-text message instead of 'sem resultados'", async () => {
    const info = await openDoc("text");
    vi.spyOn(commands, "textSearchStart").mockImplementation(async (_docId, searchId) => {
      await events.searchBatch.emit(batch(searchId, { done: true, pagesSearched: 5, pageCount: 5, textless: true }));
      return { status: "ok", data: null };
    });
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "qualquer");
    expect(await screen.findByText("Este documento não tem texto pesquisável")).toBeInTheDocument();
    expect(screen.getByText(/documento digitalizado/)).toBeInTheDocument();
  });

  it("still says 'sem resultados' for a text document without matches", async () => {
    const info = await openDoc("text");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await typeQuery(user, "zzzzzz");
    await waitFor(() => expect(count()).toHaveAttribute("data-done", "true"));
    expect(count()).toHaveTextContent("Sem resultados");
    expect(screen.queryByText("Este documento não tem texto pesquisável")).not.toBeInTheDocument();
  });
});

describe("B12 - compact bar and docked panel never cover the page", () => {
  it("renders the compact bar floating and the docked panel as a 370px column", async () => {
    const info = await openDoc("text");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    const bar = await screen.findByTestId("search-panel");
    expect(bar).toHaveAttribute("data-mode", "compact");
    expect(bar.className).toContain("absolute");

    await user.click(screen.getByRole("button", { name: "Pesquisa avançada (painel)" }));
    const dock = screen.getByTestId("search-panel");
    expect(dock).toHaveAttribute("data-mode", "docked");
    expect(dock.className).not.toContain("absolute");
    expect(dock.style.width).toBe("370px");
    expect(within(dock).getByText("Pesquisa")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Compactar para a barra de uma linha" }));
    expect(screen.getByTestId("search-panel")).toHaveAttribute("data-mode", "compact");
  });

  it("resizes with the keyboard, clamped to 300..520px", async () => {
    const info = await openDoc("text");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    act(() => useSearchStore.getState().setMode("docked"));
    const handle = await screen.findByRole("separator", { name: "Redimensionar o painel de pesquisa" });
    handle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("search-panel").style.width).toBe("386px");
    for (let i = 0; i < 40; i++) await user.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("search-panel").style.width).toBe("520px");
    for (let i = 0; i < 40; i++) await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("search-panel").style.width).toBe("300px");
  });

  it("remembers the last mode used", async () => {
    const info = await openDoc("text");
    render(<Harness />);
    act(() => useSearchStore.getState().open(info.docId));
    await user.click(await screen.findByRole("button", { name: "Pesquisa avançada (painel)" }));
    await waitFor(async () => expect((await commands.prefsGet("search.lastMode")).status === "ok").toBe(true));
    const stored = await commands.prefsGet("search.lastMode");
    expect(stored.status === "ok" && stored.data).toBe("docked");

    await user.click(screen.getByTestId("search-close"));
    expect(screen.queryByTestId("search-panel")).not.toBeInTheDocument();
    await user.keyboard("{Control>}f{/Control}");
    expect(await screen.findByTestId("search-panel")).toHaveAttribute("data-mode", "docked");
  });
});
