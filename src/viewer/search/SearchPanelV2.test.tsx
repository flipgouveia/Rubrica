// Search v2 (phase 2) UI: mode and window, term chips, scope selector, toggles, grouped/ordered result
// list, empty states, colour palette, Alt+P and persisted preferences — driven through the real
// <SearchPanel/> against the mock engine's 12-page "book" document (outline, headers/footers,
// proximity zones; see BOOK_* in src/ipc/mock/state.ts). 0-based pages in this comment:
//   outline: "1 Introdução" 1–3 (1.1 Âmbito 1–2, 1.2 Definições 3) · "2 Cessação do contrato" 4–8
//   (2.1 Por acordo 4, 2.2 Por incumprimento 5–7, 2.3 Efeitos 8) · "3 Disposições finais" 9–11;
//   page 0 is before the first chapter. "rescisão prazo indemnização": a tight zone on page 5
//   (126 chars, in 2.2) and a loose one spanning pages 10–11 (469 chars, in 3).
import "../../i18n";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalShortcuts } from "../../chrome/shortcuts";
import { commands, events } from "../../ipc";
import type { DocInfo, SearchBatch, SearchHit, SearchQuery } from "../../ipc/bindings";
import { useViewerStore } from "../store";
import { SearchPanel } from "./SearchPanel";
import { DEFAULT_HIGHLIGHT_COLORS } from "./searchColors";
import { resetSearchPrefsForTests, useSearchPrefs } from "./searchPrefs";
import { useSearchStore } from "./searchStore";

const BOOK_QUERY = "rescisão prazo indemnização";

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

const count = () => screen.getByTestId("search-count");
const store = () => useSearchStore.getState();
const prefs = () => useSearchPrefs.getState();
const done = () => waitFor(() => expect(count()).toHaveAttribute("data-done", "true"), { timeout: 4000 });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const lastQuery = (spy: { mock: { calls: unknown[][] } }): SearchQuery => spy.mock.calls[spy.mock.calls.length - 1][2] as SearchQuery;

/** Opens the docked panel for `docId` with `query` already typed (the search runs by itself). */
function openPanel(docId: string, query = "", mode: "docked" | "compact" = "docked") {
  render(<Harness />);
  act(() => {
    store().open(docId, mode);
    if (query) store().setQuery(docId, query);
  });
}

function hit(page: number, extra: Partial<SearchHit> & { matched?: string } = {}): SearchHit {
  const { matched = "zona", ...rest } = extra;
  return {
    rects: [{ page, rect: { x: 72, y: 700, width: 40, height: 14 }, term: 0 }],
    charStart: 0,
    charLen: matched.length,
    context: { before: "antes ", matched, after: " depois", terms: [] },
    windowRects: [],
    score: null,
    spansPages: null,
    outlineItemId: null,
    ...rest,
  };
}
const batch = (searchId: string, partial: Partial<SearchBatch>): SearchBatch => ({
  searchId,
  matches: [],
  done: false,
  pagesSearched: 0,
  pageCount: 12,
  textless: false,
  ranked: false,
  furniture: [],
  ...partial,
});

/** Makes `text_search_start` stream what `script` says instead of searching the mock (the command still resolves). */
function stubEngine(script: (searchId: string, query: SearchQuery) => SearchBatch[] | Promise<SearchBatch[]>) {
  return vi.spyOn(commands, "textSearchStart").mockImplementation(async (_docId, searchId, query) => {
    for (const b of await script(searchId, query)) await events.searchBatch.emit(b);
    return { status: "ok", data: null };
  });
}

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  localStorage.clear();
  resetSearchPrefsForTests();
  user = userEvent.setup();
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useSearchStore.setState({ byDoc: {}, docId: null, isOpen: false, mode: "compact", panelWidth: 370 });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const docId of ["mock-text-doc", "mock-form-doc", "mock-perf-doc", "mock-book-doc"]) await commands.docClose(docId);
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

describe("query building from the panel", () => {
  it("sends a phrase search over the whole document with accents ignored and headers/footers kept", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "rescisão");
    await done();
    expect(lastQuery(start)).toEqual({
      text: "rescisão",
      mode: "phrase",
      proximity: null,
      scope: { kind: "all" },
      caseSensitive: false,
      wholeWord: false,
      ignoreDiacritics: true,
      excludeHeadersFooters: false,
    });
    expect(screen.getByRole("switch", { name: "Ignorar acentos" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Excluir cabeçalhos e rodapés" })).not.toBeChecked();
  });

  it("re-runs the search when ANY option changes, with that option in the query", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "rescisão");
    await done();
    expect(start).toHaveBeenCalledTimes(1);

    const steps: [() => Promise<void>, Partial<SearchQuery>][] = [
      [() => user.click(screen.getByRole("switch", { name: "Ignorar acentos" })), { ignoreDiacritics: false }],
      [() => user.click(screen.getByRole("switch", { name: "Excluir cabeçalhos e rodapés" })), { excludeHeadersFooters: true }],
      [() => user.click(button("Distinguir maiúsculas/minúsculas")), { caseSensitive: true }],
      [() => user.click(button("Palavra inteira")), { wholeWord: true }],
    ];
    let calls = 1;
    for (const [act_, expected] of steps) {
      await act_();
      await waitFor(() => expect(start).toHaveBeenCalledTimes(calls + 1), { timeout: 2000 });
      calls++;
      expect(lastQuery(start)).toMatchObject(expected);
      await done();
    }
    expect(lastQuery(start)).toMatchObject({ ignoreDiacritics: false, excludeHeadersFooters: true, caseSensitive: true, wholeWord: true });
  }, 20_000); // walks every option through the debounce: ~4.5 s alone, more under a full parallel run

  it("debounces: several quick option changes make one search", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "rescisão");
    await done();
    start.mockClear();
    await user.click(screen.getByRole("switch", { name: "Ignorar acentos" }));
    await user.click(screen.getByRole("switch", { name: "Excluir cabeçalhos e rodapés" }));
    await user.click(button("Palavra inteira"));
    await waitFor(() => expect(start).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("builds a proximity query with the window", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, BOOK_QUERY);
    await done();
    await user.click(button("Proximidade"));
    await waitFor(() => expect(lastQuery(start).mode).toBe("proximity"), { timeout: 2000 });
    expect(lastQuery(start)).toMatchObject({ text: BOOK_QUERY, proximity: { window: 500 } });
    await done();
  });
});

describe("mode and window", () => {
  it("shows the mode as a pressed segment, and the window controls only in proximity", async () => {
    const info = await openDoc("book");
    openPanel(info.docId);
    expect(button("Frase")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Janela de proximidade, em caracteres")).not.toBeInTheDocument();
    await user.click(button("Proximidade"));
    expect(button("Proximidade")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Janela de proximidade, em caracteres")).toHaveValue(500);
    expect(screen.getByText("car.")).toBeInTheDocument();
  });

  it("offers the presets 100/250/500/1000 and applies them", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, BOOK_QUERY);
    await user.click(button("Proximidade"));
    const group = screen.getByRole("group", { name: "Predefinições da janela" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["100", "250", "500", "1000"]);
    expect(within(group).getByRole("button", { name: "500" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(group).getByRole("button", { name: "250" }));
    expect(prefs().proximityWindow).toBe(250);
    expect(screen.getByLabelText("Janela de proximidade, em caracteres")).toHaveValue(250);
    expect(within(group).getByRole("button", { name: "250" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(lastQuery(start).proximity).toEqual({ window: 250 }), { timeout: 2000 });
  });

  it("takes a free value between 20 and 5000 and refuses anything else", async () => {
    const info = await openDoc("book");
    openPanel(info.docId);
    await user.click(button("Proximidade"));
    const input = screen.getByLabelText("Janela de proximidade, em caracteres");
    for (const [typed, expected] of [
      ["1234", 1234],
      ["20", 20],
      ["5000", 5000],
    ] as const) {
      await user.clear(input);
      await user.type(input, typed);
      expect(prefs().proximityWindow).toBe(expected);
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "19");
    expect(prefs().proximityWindow).toBe(5000); // unchanged: 19 is below the minimum
    expect(screen.getByRole("alert")).toHaveTextContent("Valor entre 20 e 5000 caracteres");
    await user.clear(input);
    await user.paste("5001"); // pasted at once (typing it would pass through the valid prefixes 50 and 500)
    expect(prefs().proximityWindow).toBe(5000);
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.tab(); // leaving the field restores the last valid value
    expect(input).toHaveValue(5000);
  });
});

describe("term chips", () => {
  it("shows one chip per term in proximity, with colour swatches by position; exclusions are struck through", async () => {
    const info = await openDoc("book");
    openPanel(info.docId, 'rescisão "justa causa" -anexo prazo');
    expect(screen.queryByRole("list", { name: "Termos da pesquisa" })).not.toBeInTheDocument(); // phrase mode: no chips
    await user.click(button("Proximidade"));
    const chips = screen.getByRole("list", { name: "Termos da pesquisa" });
    const items = within(chips).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["rescisão", "justa causa", "anexo", "prazo"]);
    // positive terms get a swatch with their colour slot (1, 2, 3 — the exclusion takes none)
    expect(within(chips).getAllByRole("button").map((b) => b.dataset.colorSlot)).toEqual(["1", "2", "3"]);
    expect(items[2]).toHaveAttribute("data-excluded");
    expect(items[2].className).toContain("line-through");
    expect(items[2]).toHaveAccessibleName("Excluído: anexo");
    expect(within(chips).getByRole("button", { name: "Mudar a cor de prazo" }).style.background).toBe("var(--search-t3s)");
  });

  it("explains the syntax", async () => {
    const info = await openDoc("book");
    openPanel(info.docId);
    await user.click(button("Proximidade"));
    expect(screen.getByText(/frases exatas/)).toBeInTheDocument();
  });
});

describe("scope selector", () => {
  async function openSelector() {
    await user.click(screen.getByTestId("search-scope"));
    return screen.getByRole("dialog", { name: "Âmbito" });
  }

  it("starts on the whole document and lists the options with their page counts", async () => {
    const info = await openDoc("book");
    useViewerStore.getState().setCurrentPage(info.docId, 6);
    openPanel(info.docId);
    expect(screen.getByTestId("search-scope")).toHaveTextContent("Documento inteiro");
    const dialog = await openSelector();
    expect(within(dialog).getByRole("button", { name: /Documento inteiro/ })).toHaveTextContent("12 p.");
    // page 6 (0-based) is in "2.2" inside "2 Cessação do contrato" (pages 4–8): the TOP-LEVEL entry, 5 pages
    const current = within(dialog).getByRole("button", { name: /Capítulo atual/ });
    expect(current).toHaveTextContent("Capítulo atual — 2 Cessação do contrato");
    expect(current).toHaveTextContent("5 p.");
    expect(within(dialog).getByText("Escolher capítulo…")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Primeira página")).toHaveValue(1);
    expect(within(dialog).getByLabelText("Última página")).toHaveValue(12);
    expect(within(dialog).getByText("De 1 a 12")).toBeInTheDocument();
  });

  it("'current chapter' searches the top-level entry holding the visible page", async () => {
    const info = await openDoc("book");
    useViewerStore.getState().setCurrentPage(info.docId, 6);
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "contrato");
    await done();
    const dialog = await openSelector();
    await user.click(within(dialog).getByRole("button", { name: /Capítulo atual/ }));
    expect(screen.queryByRole("dialog", { name: "Âmbito" })).not.toBeInTheDocument(); // picking an option closes it
    expect(screen.getByTestId("search-scope")).toHaveTextContent("Capítulo atual — 2 Cessação do contrato (p. 5–9)");
    await waitFor(() => expect(lastQuery(start).scope).toEqual({ kind: "outline", itemId: "1" }), { timeout: 2000 });
    await done();
    // the page count of the scope reaches the status line / progress ("N de M" counts only its pages)
    expect(store().byDoc[info.docId].pageCount).toBe(5);
  });

  it("follows the visible page: scrolling into another chapter re-targets 'current chapter'", async () => {
    const info = await openDoc("book");
    useViewerStore.getState().setCurrentPage(info.docId, 6);
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "contrato");
    await done();
    await user.click(screen.getByTestId("search-scope"));
    await user.click(within(screen.getByRole("dialog", { name: "Âmbito" })).getByRole("button", { name: /Capítulo atual/ }));
    await waitFor(() => expect(lastQuery(start).scope).toEqual({ kind: "outline", itemId: "1" }), { timeout: 2000 });
    await done();
    act(() => useViewerStore.getState().setCurrentPage(info.docId, 10));
    await waitFor(() => expect(lastQuery(start).scope).toEqual({ kind: "outline", itemId: "2" }), { timeout: 2000 });
    expect(screen.getByTestId("search-scope")).toHaveTextContent("3 Disposições finais");
  });

  it("'choose chapter' shows the outline tree with page ranges and picks any entry, even a sub-chapter", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "contrato");
    await done();
    const dialog = await openSelector();
    const tree = within(dialog).getByTestId("scope-tree");
    expect(within(tree).getByRole("button", { name: /^1 Introdução/ })).toHaveTextContent("2–4");
    expect(within(tree).getByRole("button", { name: /^2 Cessação do contrato/ })).toHaveTextContent("5–9");
    expect(within(tree).getByRole("button", { name: /^3 Disposições finais/ })).toHaveTextContent("10–12");
    expect(within(tree).queryByRole("button", { name: /^2\.2 Por incumprimento/ })).not.toBeInTheDocument(); // collapsed

    await user.click(within(tree).getByRole("button", { name: "Expandir 2 Cessação do contrato" }));
    const sub = within(tree).getByRole("button", { name: /^2\.2 Por incumprimento/ });
    expect(sub).toHaveTextContent("6–8");
    await user.click(sub);
    expect(screen.getByTestId("search-scope")).toHaveTextContent("2.2 Por incumprimento (p. 6–8)");
    await waitFor(() => expect(lastQuery(start).scope).toEqual({ kind: "outline", itemId: "1.1" }), { timeout: 2000 });
    await done();
    // reopening shows the chosen entry selected, with its ancestors open
    const again = await openSelector();
    expect(within(again).getByRole("button", { name: /^2\.2 Por incumprimento/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("'pages X–Y' is 1-based in the UI and 0-based over IPC", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "contrato");
    await done();
    const dialog = await openSelector();
    const from = within(dialog).getByLabelText("Primeira página");
    const to = within(dialog).getByLabelText("Última página");
    await user.clear(from);
    await user.type(from, "3");
    await user.clear(to);
    await user.type(to, "5");
    await waitFor(() => expect(lastQuery(start).scope).toEqual({ kind: "pages", from: 2, to: 4 }), { timeout: 2000 });
    expect(screen.getByTestId("search-scope")).toHaveTextContent("Páginas 3–5");
    await done();
    expect(store().byDoc[info.docId].pageCount).toBe(3);
  });

  it("refuses an invalid page range without searching, and says so", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "contrato");
    await done();
    start.mockClear();
    const dialog = await openSelector();
    const from = within(dialog).getByLabelText("Primeira página");
    const to = within(dialog).getByLabelText("Última página");
    await user.clear(from);
    await user.type(from, "9");
    await user.clear(to);
    await user.type(to, "4");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Intervalo de páginas inválido.");
    await user.clear(to);
    await user.type(to, "99"); // beyond the last page
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(start).not.toHaveBeenCalled();
    expect(store().byDoc[info.docId].flat).toHaveLength(0); // the stale results are gone
  });

  it("disables the chapter options with an explanation when the PDF has no outline; pages still work", async () => {
    const info = await openDoc("text");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "Rubrica");
    await done();
    const dialog = await openSelector();
    await waitFor(() => expect(within(dialog).getByRole("note")).toHaveTextContent("Este PDF não tem índice (marcadores)."));
    const current = within(dialog).getByRole("button", { name: /Capítulo atual/ });
    expect(current).toBeDisabled();
    expect(current.parentElement).toHaveAttribute("title", "Este PDF não tem índice (marcadores).");
    expect(within(dialog).queryByTestId("scope-tree")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Documento inteiro/ })).toBeEnabled();
    const from = within(dialog).getByLabelText("Primeira página");
    await user.clear(from);
    await user.type(from, "2");
    await waitFor(() => expect(lastQuery(start).scope).toEqual({ kind: "pages", from: 1, to: 4 }), { timeout: 2000 });
  });

  it("closes on Escape without closing the search, and on an outside click", async () => {
    const info = await openDoc("book");
    openPanel(info.docId, "contrato");
    await openSelector();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Âmbito" })).not.toBeInTheDocument();
    expect(screen.getByTestId("search-panel")).toBeInTheDocument();
    await openSelector();
    await user.click(screen.getByTestId("search-input"));
    expect(screen.queryByRole("dialog", { name: "Âmbito" })).not.toBeInTheDocument();
  });
});

describe("result list: grouping, counts and rows", () => {
  it("groups proximity zones by the deepest outline entry, with counts, page, window length and a spanning marker", async () => {
    const info = await openDoc("book");
    openPanel(info.docId, BOOK_QUERY);
    await user.click(button("Proximidade"));
    await done();
    await waitFor(() => expect(count()).toHaveTextContent("zonas"));
    expect(count()).toHaveTextContent("1 de 2 zonas · 12 páginas");
    const list = screen.getByRole("list", { name: "Resultados da pesquisa" });
    const groups = within(list).getAllByTestId("search-group");
    expect(groups.map((g) => g.textContent)).toEqual(["2.2 Por incumprimento1", "3 Disposições finais1"]);
    const rows = within(list).getAllByRole("listitem").filter((li) => !groups.includes(li));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("p. 6");
    expect(rows[0]).toHaveTextContent("126 car.");
    expect(rows[1]).toHaveTextContent("p. 11–12");
    expect(rows[1]).toHaveTextContent("469 car.");
    expect(rows[1]).toHaveTextContent("Atravessa a mudança de página");
    expect(rows[0]).not.toHaveTextContent("Atravessa");
  });

  it("colours each term of the snippet by its position, and follows a colour change", async () => {
    const info = await openDoc("book");
    openPanel(info.docId, BOOK_QUERY);
    await user.click(button("Proximidade"));
    await done();
    const rows = () =>
      within(screen.getByRole("list", { name: "Resultados da pesquisa" }))
        .getAllByRole("listitem")
        .filter((li) => !li.hasAttribute("data-testid"));
    const marks = within(rows()[0]).getAllByText(/^(rescisão|prazo|indemnização)$/);
    expect(marks.map((m) => [m.tagName, m.dataset.term, m.textContent])).toEqual([
      ["MARK", "0", "rescisão"],
      ["MARK", "1", "prazo"],
      ["MARK", "2", "indemnização"],
    ]);
    const first = within(rows()[0]).getByText("rescisão");
    expect(first.dataset.term).toBe("0");
    expect(first.style.background).toBe("var(--search-t1)");
    expect(within(rows()[0]).getByText("prazo").style.background).toBe("var(--search-t2)");
    act(() => prefs().setHighlightColor(1, "#a78bfa"));
    expect(within(rows()[0]).getByText("prazo").style.background).toBe("rgba(167, 139, 250, 0.5)");
  });

  it("collapses and expands a group (count unchanged), and navigation re-opens the group it lands in", async () => {
    const info = await openDoc("book");
    openPanel(info.docId, BOOK_QUERY);
    await user.click(button("Proximidade"));
    await done();
    const list = () => screen.getByRole("list", { name: "Resultados da pesquisa" });
    await user.click(within(list()).getByRole("button", { name: "Recolher 2.2 Por incumprimento" }));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(3); // 2 headers + 1 row
    expect(count()).toHaveTextContent("1 de 2 zonas"); // still counts the hidden zone
    expect(within(list()).getByRole("button", { name: "Expandir 2.2 Por incumprimento" })).toHaveAttribute("aria-expanded", "false");
    await user.click(button("Ocorrência seguinte")); // 2nd zone (group 3)
    await user.click(button("Ocorrência seguinte")); // wraps to the 1st, inside the collapsed group
    expect(within(list()).getAllByRole("listitem")).toHaveLength(4); // the group opened again
    expect(count()).toHaveTextContent("1 de 2 zonas");
  });

  it("is a flat list without group headers when the PDF has no outline", async () => {
    const info = await openDoc("text");
    openPanel(info.docId, "Rubrica");
    await done();
    const list = screen.getByRole("list", { name: "Resultados da pesquisa" });
    expect(within(list).queryAllByTestId("search-group")).toHaveLength(0);
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(3);
  });

  it("puts hits before the first chapter under 'Antes do primeiro capítulo'", async () => {
    const info = await openDoc("book");
    stubEngine((searchId) => [
      batch(searchId, { matches: [{ page: 0, hits: [hit(0, { outlineItemId: null })] }, { page: 5, hits: [hit(5, { outlineItemId: "1.1" })] }], done: true, pagesSearched: 12 }),
    ]);
    openPanel(info.docId, "zona");
    await done();
    const groups = within(screen.getByRole("list", { name: "Resultados da pesquisa" })).getAllByTestId("search-group");
    expect(groups.map((g) => g.textContent)).toEqual(["Antes do primeiro capítulo1", "2.2 Por incumprimento1"]);
  });
});

describe("result list: ordering and the 'X de N' counter", () => {
  // Group "2.2 Por incumprimento" (1.1): pages 4/5/6 with scores 400/100/250; group "3" ("2"): page 10, score 50.
  // By position: p.5 (400), p.6 (100), p.7 (250), p.11 (50). By compactness: groups by best hit -> "3" (50) first,
  // then 2.2: p.6 (100), p.7 (250), p.5 (400).
  const zones = () => [
    { page: 4, hits: [hit(4, { outlineItemId: "1.1", score: 400, matched: "quatrocentos" })] },
    { page: 5, hits: [hit(5, { outlineItemId: "1.1", score: 100, matched: "cem" })] },
    { page: 6, hits: [hit(6, { outlineItemId: "1.1", score: 250, matched: "duzentos" })] },
    { page: 10, hits: [hit(10, { outlineItemId: "2", score: 50, matched: "cinquenta" })] },
  ];
  const rowsText = () =>
    within(screen.getByRole("list", { name: "Resultados da pesquisa" }))
      .getAllByRole("listitem")
      .filter((li) => !li.hasAttribute("data-testid"))
      .map((li) => li.textContent);

  async function openRanked() {
    const info = await openDoc("book");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // first the positional batches, then — once the test lets go — the ranked `done` batch
    vi.spyOn(commands, "textSearchStart").mockImplementation(async (_docId, searchId) => {
      await events.searchBatch.emit(batch(searchId, { matches: zones(), pagesSearched: 12 }));
      void gate.then(() => events.searchBatch.emit(batch(searchId, { done: true, ranked: true, pagesSearched: 12 })));
      return { status: "ok", data: null };
    });
    openPanel(info.docId, "a b");
    await user.click(button("Proximidade"));
    return { info, release };
  }

  it("lists by position until the engine ranks, then by compactness inside groups (groups by best hit)", async () => {
    const { release } = await openRanked();
    await waitFor(() => expect(store().byDoc["mock-book-doc"].flat).toHaveLength(4), { timeout: 3000 });
    expect(rowsText().map((t) => t?.match(/quatrocentos|cem|duzentos|cinquenta/)?.[0])).toEqual(["quatrocentos", "cem", "duzentos", "cinquenta"]);
    expect(store().byDoc["mock-book-doc"].ranked).toBe(false);
    act(() => release());
    await done();
    expect(store().byDoc["mock-book-doc"].ranked).toBe(true);
    expect(rowsText().map((t) => t?.match(/quatrocentos|cem|duzentos|cinquenta/)?.[0])).toEqual(["cinquenta", "cem", "duzentos", "quatrocentos"]);
    const groups = within(screen.getByRole("list", { name: "Resultados da pesquisa" })).getAllByTestId("search-group");
    expect(groups.map((g) => g.textContent)).toEqual(["3 Disposições finais1", "2.2 Por incumprimento3"]);
  });

  it("'X de N' and the next/previous buttons follow the visible order", async () => {
    const { release } = await openRanked();
    await waitFor(() => expect(store().byDoc["mock-book-doc"].flat).toHaveLength(4), { timeout: 3000 });
    // by position the first zone is the 400-char one (page 5)
    expect(count()).toHaveTextContent(/^A pesquisar/);
    act(() => release());
    await done();
    // ranked: "1 de 4" is the most compact zone overall (50 chars, page 11)
    expect(count()).toHaveTextContent("1 de 4 zonas");
    expect(store().byDoc["mock-book-doc"].active).toEqual({ page: 10, hitIndex: 0 });
    await user.click(button("Ocorrência seguinte"));
    expect(count()).toHaveTextContent("2 de 4 zonas");
    expect(store().byDoc["mock-book-doc"].active).toEqual({ page: 5, hitIndex: 0 }); // 100 chars
    await user.keyboard("{Enter}");
    expect(store().byDoc["mock-book-doc"].active).toEqual({ page: 6, hitIndex: 0 }); // 250
    await user.click(button("Ocorrência anterior"));
    await user.click(button("Ocorrência anterior"));
    await user.click(button("Ocorrência anterior")); // wraps to the last: 400 chars
    expect(count()).toHaveTextContent("4 de 4 zonas");
    expect(store().byDoc["mock-book-doc"].active).toEqual({ page: 4, hitIndex: 0 });
  });

  it("switches to document order with 'Por posição' and keeps the same zone selected", async () => {
    const { release } = await openRanked();
    act(() => release());
    await done();
    await user.click(button("Ocorrência seguinte")); // 2nd in compact order: the 100-char zone, page 6
    expect(store().byDoc["mock-book-doc"].active).toEqual({ page: 5, hitIndex: 0 });
    await user.selectOptions(screen.getByRole("combobox", { name: "Ordenar resultados" }), "position");
    expect(prefs().sort).toBe("position");
    expect(rowsText().map((t) => t?.match(/quatrocentos|cem|duzentos|cinquenta/)?.[0])).toEqual(["quatrocentos", "cem", "duzentos", "cinquenta"]);
    expect(store().byDoc["mock-book-doc"].active).toEqual({ page: 5, hitIndex: 0 });
    expect(count()).toHaveTextContent("2 de 4 zonas"); // its place in the list on screen
    await user.click(button("Ocorrência seguinte"));
    expect(store().byDoc["mock-book-doc"].active).toEqual({ page: 6, hitIndex: 0 });
    await commands.prefsGet("search.sort").then((r) => expect(r.status === "ok" && r.data).toBe("position"));
  });

  it("offers the sort selector only in proximity mode", async () => {
    const info = await openDoc("book");
    openPanel(info.docId, "rescisão");
    expect(screen.queryByRole("combobox", { name: "Ordenar resultados" })).not.toBeInTheDocument();
    await user.click(button("Proximidade"));
    const select = screen.getByRole("combobox", { name: "Ordenar resultados" });
    expect(select).toHaveValue("compact");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Mais compactas", "Por posição"]);
  });

  it("keeps a phrase search in document order whatever the sort preference", async () => {
    const info = await openDoc("book");
    prefs().setSort("compact");
    stubEngine((searchId) => [batch(searchId, { matches: zones(), done: true, pagesSearched: 12 })]);
    openPanel(info.docId, "zona");
    await done();
    expect(rowsText().map((t) => t?.match(/quatrocentos|cem|duzentos|cinquenta/)?.[0])).toEqual(["quatrocentos", "cem", "duzentos", "cinquenta"]);
  });
});

describe("empty and failed states", () => {
  it("proximity with no zone: says how many terms and which window, and offers to widen it", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    prefs().setMode("proximity");
    prefs().setProximityWindow(250);
    openPanel(info.docId, "rescisão matrimónio");
    await done();
    const notice = await screen.findByText("Nenhuma zona com os 2 termos em 250 caracteres.");
    expect(within(notice.closest("[role=status]") as HTMLElement).getByText("Sem resultados")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pesquisar no documento inteiro" })).not.toBeInTheDocument(); // already the whole document
    await user.click(screen.getByRole("button", { name: "Aumentar janela para 500" }));
    expect(prefs().proximityWindow).toBe(500);
    await waitFor(() => expect(lastQuery(start).proximity).toEqual({ window: 500 }), { timeout: 2000 });
  });

  it("offers to search the whole document when a narrower scope found nothing", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, "zzzzzz");
    act(() => store().setScope(info.docId, { kind: "pages", from: 1, to: 3 }));
    await waitFor(() => expect(lastQuery(start).scope).toEqual({ kind: "pages", from: 0, to: 2 }), { timeout: 2000 });
    await done();
    expect(await screen.findByText("Sem resultados")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pesquisar no documento inteiro" }));
    expect(store().byDoc[info.docId].scope).toEqual({ kind: "all" });
    await waitFor(() => expect(lastQuery(start).scope).toEqual({ kind: "all" }), { timeout: 2000 });
  });

  it("does not offer to widen a window that is already at the maximum", async () => {
    const info = await openDoc("book");
    prefs().setMode("proximity");
    prefs().setProximityWindow(5000);
    openPanel(info.docId, "rescisão matrimónio");
    await done();
    await screen.findByText("Nenhuma zona com os 2 termos em 5000 caracteres.");
    expect(screen.queryByRole("button", { name: /Aumentar janela/ })).not.toBeInTheDocument();
  });

  it("a phrase search with no hit says 'Sem resultados' in the panel (and in the bar's counter)", async () => {
    const info = await openDoc("book");
    openPanel(info.docId, "zzzzzz");
    await done();
    expect(await screen.findByText("Sem resultados")).toBeInTheDocument();
    expect(screen.queryByText(/Nenhuma zona/)).not.toBeInTheDocument();
  });

  it("shows the no-searchable-text message for a scanned document", async () => {
    const info = await openDoc("book");
    stubEngine((searchId) => [batch(searchId, { done: true, pagesSearched: 12, textless: true })]);
    openPanel(info.docId, "qualquer");
    expect(await screen.findByText("Este documento não tem texto pesquisável")).toBeInTheDocument();
    expect(screen.queryByText("Sem resultados")).not.toBeInTheDocument();
  });

  it("explains an invalid query (INVALID_ARG from the engine)", async () => {
    const info = await openDoc("book");
    vi.spyOn(commands, "textSearchStart").mockResolvedValue({ status: "error", error: { code: "INVALID_ARG", message: "proximity window out of range" } });
    openPanel(info.docId, "qualquer");
    expect(await screen.findByText("Escreva pelo menos um termo a procurar.")).toBeInTheDocument();
    expect(screen.queryByText("Sem resultados")).not.toBeInTheDocument();
    expect(count()).toHaveTextContent("");
  });

  it("explains a proximity query with only exclusions without calling the engine", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    prefs().setMode("proximity");
    openPanel(info.docId, "-anexo");
    expect(await screen.findByText("Escreva pelo menos um termo a procurar.")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(start).not.toHaveBeenCalled();
  });

  it("reports an engine failure with its message", async () => {
    const info = await openDoc("book");
    vi.spyOn(commands, "textSearchStart").mockResolvedValue({ status: "error", error: { code: "INTERNAL", message: "boom" } });
    openPanel(info.docId, "qualquer");
    expect(await screen.findByText("A pesquisa falhou: boom")).toBeInTheDocument();
  });

  it("shows the invalid/failed notice in the compact bar too", async () => {
    const info = await openDoc("book");
    vi.spyOn(commands, "textSearchStart").mockResolvedValue({ status: "error", error: { code: "INTERNAL", message: "boom" } });
    openPanel(info.docId, "qualquer", "compact");
    expect(await screen.findByText("A pesquisa falhou: boom")).toBeInTheDocument();
    expect(screen.getByTestId("search-panel")).toHaveAttribute("data-mode", "compact");
  });
});

describe("highlight colours in the panel", () => {
  async function openPalette(term = "prazo") {
    const info = await openDoc("book");
    openPanel(info.docId, BOOK_QUERY);
    await user.click(button("Proximidade"));
    await user.click(screen.getByRole("button", { name: `Mudar a cor de ${term}` }));
    return screen.getByRole("dialog", { name: /^Cor \d — / });
  }

  it("opens the palette of a term from its swatch: 8 presets, a hex field, a preview and the reset", async () => {
    const dialog = await openPalette();
    expect(dialog).toHaveAccessibleName("Cor 2 — prazo");
    const presets = within(dialog).getAllByRole("button", { name: /^Cor predefinida #/ });
    expect(presets).toHaveLength(8);
    expect(presets[1]).toHaveAttribute("aria-pressed", "true"); // #22D3EE is colour 2's original
    expect(within(dialog).getByLabelText("Cor em hexadecimal")).toHaveValue("#22D3EE");
    expect(within(dialog).getByText("Exemplo:")).toBeInTheDocument();
    expect(within(dialog).getByTestId("color-example")).toHaveTextContent("prazo");
    expect(within(dialog).getByRole("button", { name: "Repor originais" })).toBeInTheDocument();
  });

  it("picking a preset changes that POSITION's colour, previews it and persists it", async () => {
    const dialog = await openPalette();
    await user.click(within(dialog).getByRole("button", { name: "Cor predefinida #A78BFA" }));
    expect(prefs().highlightColors).toEqual(["#FACC15", "#A78BFA", "#F472B6", "#4ADE80"]);
    expect(within(dialog).getByRole("button", { name: "Cor predefinida #A78BFA" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByTestId("color-example").style.background).toBe("rgba(167, 139, 250, 0.5)");
    expect(screen.getByRole("button", { name: "Mudar a cor de prazo" }).style.background).toBe("rgb(167, 139, 250)");
    const stored = await commands.prefsGet("search.highlightColors");
    expect(JSON.parse(stored.status === "ok" ? (stored.data as string) : "null")).toEqual(["#FACC15", "#A78BFA", "#F472B6", "#4ADE80"]);
  });

  it("accepts a free #RRGGBB (any case, saved upper-case) and rejects an invalid one with a message", async () => {
    const dialog = await openPalette();
    const hex = within(dialog).getByLabelText("Cor em hexadecimal");
    await user.clear(hex);
    await user.type(hex, "#12ab9c");
    expect(prefs().highlightColors[1]).toBe("#12AB9C");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();

    await user.clear(hex);
    await user.type(hex, "#12ab9");
    expect(prefs().highlightColors[1]).toBe("#12AB9C"); // not applied
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Use o formato #RRGGBB.");
    await user.clear(hex);
    await user.type(hex, "azul");
    expect(prefs().highlightColors[1]).toBe("#12AB9C");
    await user.tab();
    expect(hex).toHaveValue("#12AB9C"); // restored on leaving
  });

  it("'Repor originais' restores all four colours", async () => {
    const dialog = await openPalette();
    act(() => {
      prefs().setHighlightColor(0, "#FB923C");
      prefs().setHighlightColor(3, "#F87171");
    });
    await user.click(within(dialog).getByRole("button", { name: "Repor originais" }));
    expect(prefs().highlightColors).toEqual(DEFAULT_HIGHLIGHT_COLORS);
    expect(screen.getByRole("button", { name: "Mudar a cor de prazo" }).style.background).toBe("var(--search-t2s)");
  });

  it("closes with Escape (the search stays open) and on an outside click", async () => {
    await openPalette();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /^Cor \d — / })).not.toBeInTheDocument();
    expect(screen.getByTestId("search-panel")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mudar a cor de rescisão" }));
    expect(screen.getByRole("dialog", { name: "Cor 1 — rescisão" })).toBeInTheDocument();
    await user.click(screen.getByTestId("search-input"));
    expect(screen.queryByRole("dialog", { name: /^Cor \d — / })).not.toBeInTheDocument();
  });

  it("a term past the fourth edits the colour it cycles to", async () => {
    const info = await openDoc("book");
    prefs().setMode("proximity");
    openPanel(info.docId, "a b c d e");
    await user.click(screen.getByRole("button", { name: "Mudar a cor de e" }));
    expect(screen.getByRole("dialog", { name: "Cor 1 — e" })).toBeInTheDocument();
  });
});

describe("Alt+P", () => {
  it("toggles phrase/proximity from anywhere (even typing in the field) and persists the choice", async () => {
    const info = await openDoc("book");
    openPanel(info.docId, "rescisão");
    const input = screen.getByTestId("search-input");
    input.focus();
    await user.keyboard("{Alt>}p{/Alt}");
    expect(button("Proximidade")).toHaveAttribute("aria-pressed", "true");
    expect(prefs().mode).toBe("proximity");
    await user.keyboard("{Alt>}p{/Alt}");
    expect(button("Frase")).toHaveAttribute("aria-pressed", "true");
    const stored = await commands.prefsGet("search.mode");
    expect(stored.status === "ok" && stored.data).toBe("phrase");
  });

  it("re-runs the search in the new mode, also from the compact bar", async () => {
    const info = await openDoc("book");
    const start = vi.spyOn(commands, "textSearchStart");
    openPanel(info.docId, BOOK_QUERY, "compact");
    await done();
    expect(lastQuery(start).mode).toBe("phrase");
    await user.keyboard("{Alt>}p{/Alt}");
    await waitFor(() => expect(lastQuery(start).mode).toBe("proximity"), { timeout: 2000 });
    await done();
    expect(count()).toHaveAttribute("data-total", "2");
  });

  it("does nothing while the search is closed", async () => {
    await openDoc("book");
    render(<Harness />);
    await user.keyboard("{Alt>}p{/Alt}");
    expect(prefs().mode).toBe("phrase");
  });
});

describe("preferences", () => {
  it("restores the saved mode, window, toggles and sort when the panel starts", async () => {
    await commands.prefsSet("search.mode", "proximity");
    await commands.prefsSet("search.proximityWindow", "1000");
    await commands.prefsSet("search.ignoreDiacritics", "false");
    await commands.prefsSet("search.excludeHeadersFooters", "true");
    await commands.prefsSet("search.sort", "position");
    const info = await openDoc("book");
    openPanel(info.docId);
    await waitFor(() => expect(button("Proximidade")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByLabelText("Janela de proximidade, em caracteres")).toHaveValue(1000);
    expect(screen.getByRole("switch", { name: "Ignorar acentos" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Excluir cabeçalhos e rodapés" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Ordenar resultados" })).toHaveValue("position");
  });

  it("saves every change straight away", async () => {
    const info = await openDoc("book");
    openPanel(info.docId);
    await user.click(button("Proximidade"));
    await user.click(screen.getByRole("switch", { name: "Ignorar acentos" }));
    await user.click(screen.getByRole("switch", { name: "Excluir cabeçalhos e rodapés" }));
    await user.click(within(screen.getByRole("group", { name: "Predefinições da janela" })).getByRole("button", { name: "100" }));
    const read = async (key: string) => {
      const r = await commands.prefsGet(key);
      return r.status === "ok" ? r.data : undefined;
    };
    expect(await read("search.mode")).toBe("proximity");
    expect(await read("search.ignoreDiacritics")).toBe("false");
    expect(await read("search.excludeHeadersFooters")).toBe("true");
    expect(await read("search.proximityWindow")).toBe("100");
  });

  it("starts the next document's search from the same options (they are app-wide)", async () => {
    const book = await openDoc("book");
    openPanel(book.docId);
    await user.click(button("Proximidade"));
    await user.click(screen.getByRole("switch", { name: "Ignorar acentos" }));
    const other = await openDoc("text");
    const start = vi.spyOn(commands, "textSearchStart");
    act(() => {
      store().open(other.docId, "docked");
      store().setQuery(other.docId, "Rubrica");
    });
    await waitFor(() => expect(start).toHaveBeenCalled(), { timeout: 2000 });
    expect(lastQuery(start)).toMatchObject({ mode: "proximity", ignoreDiacritics: false });
  });
});

describe("headers and footers (furniture) through the panel", () => {
  it("keeps the excluded line rects the engine reports, per page, and clears them with a new search", async () => {
    const info = await openDoc("book");
    prefs().setExcludeHeadersFooters(true);
    stubEngine((searchId) => [
      batch(searchId, {
        matches: [{ page: 1, hits: [hit(1)] }],
        furniture: [{ page: 1, rects: [{ x: 72, y: 740, width: 300, height: 12 }] }],
        done: true,
        pagesSearched: 12,
      }),
    ]);
    openPanel(info.docId, "zona");
    await done();
    expect(Object.keys(store().byDoc[info.docId].furniture)).toEqual(["1"]);
    act(() => store().setQuery(info.docId, "outra"));
    expect(store().byDoc[info.docId].furniture).toEqual({});
  });
});
