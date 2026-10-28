// Outline panel against the mock engine's "book" document (BOOK_OUTLINE in src/ipc/mock/state.ts,
// 0-based pages: "1 Introdução" p.2-4, "2 Cessação do contrato" p.5-9 with sub-entries, "3 Disposições
// finais" p.10-12 when shown 1-based). Search counts come from a mocked `selectors` module here;
// DensityMap.integration.test.tsx covers the real search -> counts path.
import "../../i18n";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../../ipc";
import type { DocInfo, OutlineItem } from "../../ipc/bindings";
import { useViewerStore } from "../store";
import { OutlinePanel } from "./OutlinePanel";
import { useOutlineStore } from "./outlineStore";

const search = vi.hoisted(() => ({ hasResults: false, counts: new Map<string, number>() }));
vi.mock("../search/selectors", () => ({
  useHasResults: () => search.hasResults,
  useHitCountsByOutlineItem: () => search.counts,
}));

let docId = "";

async function openBook(): Promise<DocInfo> {
  const result = await commands.docOpen("book");
  if (result.status !== "ok") throw new Error("docOpen failed");
  useViewerStore.getState().openTab(result.data);
  docId = result.data.docId;
  return result.data;
}

const rowByTitle = (title: string) => screen.getByRole("treeitem", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
const currentPageOf = () => useViewerStore.getState().tabs.find((tab) => tab.docId === docId)!.currentPage;
const setPage = (page: number) => act(() => useViewerStore.getState().setCurrentPage(docId, page));

beforeEach(async () => {
  search.hasResults = false;
  search.counts = new Map();
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useOutlineStore.setState({ byKey: {} });
  await openBook();
});

afterEach(async () => {
  cleanup();
  await commands.docClose(docId);
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useOutlineStore.setState({ byKey: {} });
});

describe("tree", () => {
  it("renders the outline as an ARIA tree with titles and 1-based page numbers", async () => {
    render(<OutlinePanel docId={docId} />);
    const tree = await screen.findByRole("tree", { name: "Índice do documento" });
    const items = within(tree).getAllByRole("treeitem");
    expect(items).toHaveLength(3); // collapsed: only the top level
    expect(items.map((el) => el.getAttribute("aria-level"))).toEqual(["1", "1", "1"]);
    expect(items.map((el) => [el.getAttribute("aria-posinset"), el.getAttribute("aria-setsize")])).toEqual([
      ["1", "3"],
      ["2", "3"],
      ["3", "3"],
    ]);
    expect(within(items[0]).getByText("1 Introdução")).toBeInTheDocument();
    expect(within(items[0]).getByText("2")).toBeInTheDocument(); // starts on 0-based page 1 = page 2
    expect(within(items[1]).getByText("5")).toBeInTheDocument();
    expect(items[0]).toHaveAttribute("aria-expanded", "false");
    expect(items[2]).not.toHaveAttribute("aria-expanded"); // a leaf
  });

  it("expands and collapses with the chevron button", async () => {
    const user = userEvent.setup();
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    expect(screen.queryByText("1.1 Âmbito")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expandir 1 Introdução" }));
    expect(screen.getByText("1.1 Âmbito")).toBeInTheDocument();
    expect(screen.getByText("1.2 Definições")).toBeInTheDocument();
    expect(rowByTitle("1 Introdução")).toHaveAttribute("aria-expanded", "true");
    expect(rowByTitle("1.1 Âmbito")).toHaveAttribute("aria-level", "2");

    await user.click(screen.getByRole("button", { name: "Recolher 1 Introdução" }));
    expect(screen.queryByText("1.1 Âmbito")).toBeNull();
  });

  it("does not navigate when only expanding", async () => {
    const user = userEvent.setup();
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    await user.click(screen.getByRole("button", { name: "Expandir 2 Cessação do contrato" }));
    expect(currentPageOf()).toBe(0);
    expect(useViewerStore.getState().tabs[0].pendingScrollTo).toBeNull();
  });
});

describe("navigation", () => {
  it("clicking an entry scrolls the viewer to its page", async () => {
    const user = userEvent.setup();
    render(<OutlinePanel docId={docId} />);
    await user.click(await screen.findByText("2 Cessação do contrato"));
    const tab = useViewerStore.getState().tabs[0];
    expect(tab.pendingScrollTo).toBe(4);
    expect(tab.currentPage).toBe(4);
  });

  it("Enter and Space navigate from the keyboard", async () => {
    const user = userEvent.setup();
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    rowByTitle("3 Disposições finais").focus();
    await user.keyboard("{Enter}");
    expect(useViewerStore.getState().tabs[0].pendingScrollTo).toBe(9);
    act(() => useViewerStore.getState().clearPendingScroll(docId));
    rowByTitle("1 Introdução").focus();
    await user.keyboard(" ");
    expect(useViewerStore.getState().tabs[0].pendingScrollTo).toBe(1);
  });

  it("an entry without a page is shown ('sem página') but not clickable", async () => {
    const user = userEvent.setup();
    const items: OutlineItem[] = [
      { id: "0", title: "Capa", page: null, pageEnd: null, depth: 0, children: [] },
      { id: "1", title: "Corpo", page: 3, pageEnd: 5, depth: 0, children: [] },
    ];
    useOutlineStore.setState({ byKey: { [`${docId}@0`]: { status: "ready", items } } });
    render(<OutlinePanel docId={docId} />);
    const capa = await screen.findByRole("treeitem", { name: /Capa/ });
    expect(within(capa).getByText("sem página")).toBeInTheDocument();
    expect(capa).toHaveAttribute("aria-disabled", "true");
    await user.click(capa);
    await user.click(screen.getByText("Capa"));
    expect(useViewerStore.getState().tabs[0].pendingScrollTo).toBeNull();
    await user.click(screen.getByText("Corpo"));
    expect(useViewerStore.getState().tabs[0].pendingScrollTo).toBe(3);
  });
});

describe("current entry", () => {
  it("highlights the deepest entry that contains the visible page and follows currentPage", async () => {
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    expect(screen.queryAllByRole("treeitem", { selected: true })).toHaveLength(0); // page 0 is in no entry

    setPage(7); // inside "2.2.1 Incumprimento definitivo" (page 8 shown)
    const deepest = rowByTitle("2.2.1 Incumprimento definitivo");
    expect(deepest).toHaveAttribute("aria-selected", "true");
    expect(deepest).toHaveAttribute("data-current", "true");
    expect(within(deepest).getByText("Secção atual")).toBeInTheDocument();
    // not the top-level entry, not the parent
    expect(rowByTitle("2 Cessação do contrato")).toHaveAttribute("aria-selected", "false");
    expect(rowByTitle("2.2 Por incumprimento")).toHaveAttribute("aria-selected", "false");

    setPage(8); // "2.3 Efeitos"
    expect(rowByTitle("2.3 Efeitos")).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(1);

    setPage(10); // "3 Disposições finais" (leaf, top level); chapter 2 folds away again
    expect(rowByTitle("3 Disposições finais")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("2.3 Efeitos")).toBeNull();
  });

  it("opens the path to the current entry and follows the scroll until the user toggles something", async () => {
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    setPage(5);
    expect(screen.getByText("2.2 Por incumprimento")).toBeInTheDocument();
    expect(screen.getByText("2.1 Por acordo")).toBeInTheDocument();
    expect(screen.queryByText("1.1 Âmbito")).toBeNull();
    setPage(2);
    expect(screen.getByText("1.2 Definições")).toBeInTheDocument();
    expect(screen.queryByText("2.1 Por acordo")).toBeNull();
  });

  it("when the user collapses the chapter, the marker moves to the collapsed ancestor", async () => {
    const user = userEvent.setup();
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    setPage(7);
    await user.click(screen.getByRole("button", { name: "Recolher 2 Cessação do contrato" }));
    expect(screen.queryByText("2.2.1 Incumprimento definitivo")).toBeNull();
    const chapter = rowByTitle("2 Cessação do contrato");
    expect(chapter).toHaveAttribute("data-current", "contains");
    expect(chapter).toHaveAttribute("aria-selected", "false");
    // the user's choice sticks while the page changes inside the chapter
    setPage(8);
    expect(screen.queryByText("2.3 Efeitos")).toBeNull();
  });
});

describe("search counts", () => {
  beforeEach(() => {
    search.hasResults = true;
    // hits per DEEPEST entry (what useHitCountsByOutlineItem returns)
    search.counts = new Map([
      ["0.0", 2], // 1.1 Âmbito
      ["1.0", 3], // 2.1 Por acordo
      ["1.1", 1], // 2.2 Por incumprimento
      ["1.1.0", 2], // 2.2.1 Incumprimento definitivo
    ]);
  });

  const countOf = (row: HTMLElement) => within(row).queryByTestId("outline-hit-count");

  it("shows, per entry, the sum over itself and its descendants", async () => {
    const user = userEvent.setup();
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    expect(countOf(rowByTitle("1 Introdução"))).toHaveTextContent("2");
    expect(countOf(rowByTitle("2 Cessação do contrato"))).toHaveTextContent("6"); // 3 + 1 + 2
    expect(countOf(rowByTitle("3 Disposições finais"))).toBeNull(); // no hits, no pill

    await user.click(screen.getByRole("button", { name: "Expandir 2 Cessação do contrato" }));
    await user.click(screen.getByRole("button", { name: "Expandir 2.2 Por incumprimento" }));
    expect(countOf(rowByTitle("2.1 Por acordo"))).toHaveTextContent("3");
    expect(countOf(rowByTitle("2.2 Por incumprimento"))).toHaveTextContent("3"); // 1 + 2
    expect(countOf(rowByTitle("2.2.1 Incumprimento definitivo"))).toHaveTextContent("2");
    expect(countOf(rowByTitle("2.3 Efeitos"))).toBeNull();
  });

  it("spells the count out for assistive technology", async () => {
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    expect(within(rowByTitle("2 Cessação do contrato")).getByText("6 resultados")).toBeInTheDocument();
    expect(within(rowByTitle("1 Introdução")).getByText("2 resultados")).toBeInTheDocument();
  });

  it("shows no counts when the search has no results", async () => {
    search.hasResults = false;
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    expect(screen.queryByTestId("outline-hit-count")).toBeNull();
  });
});

describe("keyboard", () => {
  it("has a single tab stop that starts on the current entry (or the first one)", async () => {
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    expect(screen.getAllByRole("treeitem").map((el) => el.tabIndex)).toEqual([0, -1, -1]);
    setPage(9);
    expect(screen.getAllByRole("treeitem").map((el) => el.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("Up/Down/Home/End move focus; Right expands then enters; Left collapses then goes to the parent", async () => {
    const user = userEvent.setup();
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    rowByTitle("1 Introdução").focus();

    await user.keyboard("{ArrowDown}");
    expect(rowByTitle("2 Cessação do contrato")).toHaveFocus();
    await user.keyboard("{End}");
    expect(rowByTitle("3 Disposições finais")).toHaveFocus();
    await user.keyboard("{ArrowDown}"); // stays on the last one
    expect(rowByTitle("3 Disposições finais")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(rowByTitle("1 Introdução")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(rowByTitle("1 Introdução")).toHaveFocus();

    await user.keyboard("{ArrowDown}{ArrowRight}"); // expand "2 Cessação do contrato"
    expect(rowByTitle("2 Cessação do contrato")).toHaveAttribute("aria-expanded", "true");
    expect(rowByTitle("2 Cessação do contrato")).toHaveFocus();
    await user.keyboard("{ArrowRight}"); // already open: first child
    expect(rowByTitle("2.1 Por acordo")).toHaveFocus();
    await user.keyboard("{ArrowLeft}"); // a leaf: parent
    expect(rowByTitle("2 Cessação do contrato")).toHaveFocus();
    await user.keyboard("{ArrowLeft}"); // open: collapse
    expect(rowByTitle("2 Cessação do contrato")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("2.1 Por acordo")).toBeNull();
    await user.keyboard("{ArrowLeft}"); // closed top-level: nothing to do
    expect(rowByTitle("2 Cessação do contrato")).toHaveFocus();
  });

  it("moves the tab stop with the focus", async () => {
    const user = userEvent.setup();
    render(<OutlinePanel docId={docId} />);
    await screen.findByRole("tree");
    await user.tab(); // lands on the tab stop
    expect(rowByTitle("1 Introdução")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("treeitem").map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
  });
});

describe("states", () => {
  it("shows the empty state when the PDF has no outline", async () => {
    useOutlineStore.setState({ byKey: { [`${docId}@0`]: { status: "ready", items: [] } } });
    render(<OutlinePanel docId={docId} />);
    expect(await screen.findByText("Este PDF não tem índice (marcadores).")).toBeInTheDocument();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("shows a loading state while the outline is being read", () => {
    vi.spyOn(commands, "docOutline").mockImplementation(() => new Promise(() => {}));
    render(<OutlinePanel docId={docId} />);
    expect(screen.getByText("A carregar o índice…")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("shows an error state when the outline cannot be read", async () => {
    vi.spyOn(commands, "docOutline").mockResolvedValue({ status: "error", error: { code: "INTERNAL", message: "x", details: null } } as never);
    render(<OutlinePanel docId={docId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível ler o índice.");
    vi.restoreAllMocks();
  });

  it("works on a document without bookmarks (mock text document)", async () => {
    const result = await commands.docOpen("text");
    if (result.status !== "ok") throw new Error("docOpen failed");
    useViewerStore.getState().openTab(result.data);
    render(<OutlinePanel docId={result.data.docId} />);
    expect(await screen.findByText("Este PDF não tem índice (marcadores).")).toBeInTheDocument();
    await commands.docClose(result.data.docId);
  });
});
