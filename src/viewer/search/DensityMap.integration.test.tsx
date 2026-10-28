// Real round-trip, nothing mocked: the full AppShell on the mock engine's "book" document, a real
// search typed into the compact bar, and the density map + outline counts that appear because of it.
import "../../i18n";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppShell } from "../../chrome/AppShell";
import { useAppViewStore } from "../../chrome/appViewStore";
import { commands } from "../../ipc";
import { useOutlineStore } from "../outline/outlineStore";
import { useSidePanelTabStore } from "../outline/sidePanelTabStore";
import { useViewerStore } from "../store";

const BOOK_PAGES = 12;
let docId = "";

async function openBook() {
  const result = await commands.docOpen("book");
  if (result.status !== "ok") throw new Error("docOpen failed");
  docId = result.data.docId;
  useViewerStore.getState().openTab(result.data);
  useAppViewStore.setState({ view: "viewer" });
}

async function searchFor(user: ReturnType<typeof userEvent.setup>, query: string) {
  await user.keyboard("{Control>}f{/Control}");
  const input = await screen.findByPlaceholderText("Localizar no documento");
  await user.clear(input);
  await user.type(input, query);
  await waitFor(() => expect(screen.getByTestId("search-count")).toHaveAttribute("data-done", "true"), { timeout: 5000 });
}

const totalHits = () => Number(screen.getByTestId("search-count").getAttribute("data-total"));

beforeEach(async () => {
  localStorage.clear();
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useOutlineStore.setState({ byKey: {} });
  useSidePanelTabStore.setState({ tab: "thumbnails", settled: false });
  await openBook();
});

afterEach(async () => {
  cleanup();
  await commands.docClose(docId);
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useAppViewStore.setState({ view: "home" });
});

describe("density map + outline counts on a real mock search", () => {
  it("has no map before searching, then shows buckets, ticks and a summary that match the results", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    expect(screen.queryByTestId("density-strip")).toBeNull();
    expect(screen.getByTestId("density-gutter")).toBeInTheDocument();

    await searchFor(user, "contrato");
    const total = totalHits();
    expect(total).toBeGreaterThan(5);

    const strip = await screen.findByTestId("density-strip");
    expect(screen.queryByTestId("density-gutter")).toBeNull();
    const map = within(strip).getByRole("img");
    expect(map.getAttribute("aria-label")).toMatch(/^Mapa de densidade: \d+ resultados nas páginas \d+ a \d+, a mais densa na página \d+$/);

    const buckets = within(strip).getAllByTestId("density-bucket");
    expect(buckets.length).toBeGreaterThan(1);
    expect(buckets.length).toBeLessThanOrEqual(BOOK_PAGES);
    expect(buckets.reduce((sum, b) => sum + Number(b.getAttribute("data-count")), 0)).toBe(total);
    expect(map.getAttribute("aria-label")).toContain(`${total} resultados`);

    // the book has 3 chapters; the first starts on 0-based page 1, so 3 ticks
    expect(within(strip).getAllByTestId("density-tick")).toHaveLength(3);
    expect(within(strip).getByTestId("density-active")).toBeInTheDocument(); // the first hit is active
  });

  it("clicking a bucket activates the first hit from that page and moves the marker there", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await searchFor(user, "contrato");
    const strip = await screen.findByTestId("density-strip");
    const buckets = within(strip).getAllByTestId("density-bucket");
    const target = buckets[buckets.length - 1];
    const page = Number(target.getAttribute("data-from-page"));
    expect(page).toBeGreaterThan(Number(buckets[0].getAttribute("data-from-page")));

    const jumps = within(strip).getAllByTestId("density-jump");
    await user.click(jumps[jumps.length - 1]);

    await waitFor(() => {
      const top = within(strip).getByTestId("density-active").style.top; // calc(<n>% - 5px)
      expect(parseFloat(top.slice("calc(".length))).toBeCloseTo(((page + 0.5) / BOOK_PAGES) * 100, 3);
    });
    expect(jumps[jumps.length - 1]).toHaveAttribute("aria-current", "true");
  });

  it("the map goes away when the search is closed", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await searchFor(user, "contrato");
    expect(await screen.findByTestId("density-strip")).toBeInTheDocument();
    await user.click(screen.getByTestId("search-close"));
    await waitFor(() => expect(screen.queryByTestId("density-strip")).toBeNull());
    expect(screen.getByTestId("density-gutter")).toBeInTheDocument();
  });

  it("the Índice tab counts the results per chapter, summing sub-entries", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    await user.click(screen.getByRole("tab", { name: "Índice" }));
    const tree = await screen.findByRole("tree", { name: "Índice do documento" });
    expect(within(tree).queryByTestId("outline-hit-count")).toBeNull(); // no search yet

    await searchFor(user, "contrato");
    const total = totalHits();
    await waitFor(() => expect(within(tree).getAllByTestId("outline-hit-count").length).toBeGreaterThan(0));
    // Top-level entries partition the document pages that have an entry (the cover has none), so
    // their counts add up to the results minus the ones on the cover page.
    const topLevel = within(tree)
      .getAllByRole("treeitem")
      .filter((row) => row.getAttribute("aria-level") === "1");
    const visibleCount = (row: HTMLElement) => Number(within(row).queryByTestId("outline-hit-count")?.querySelector("[aria-hidden]")?.textContent ?? 0);
    const sum = topLevel.reduce((acc, row) => acc + visibleCount(row), 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(total);
  });
});
