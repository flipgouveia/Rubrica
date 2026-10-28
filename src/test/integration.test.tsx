// Mock-driven integration test (R3 brief item 7): open -> scroll -> search -> copy -> close,
// driven through the real component tree against the real mock engine (src/ipc/mock) — nothing
// here is stubbed or spied, exactly what "VITE_MOCK_ENGINE" development is meant to prove works
// end-to-end. jsdom has no real layout engine, so the virtualized page/thumbnail lists always
// measure a zero-size viewport; assertions route around that (e.g. driving "scroll" through the
// thumbnail rail's click handler rather than asserting on which page tiles happen to be
// virtualized into the DOM) rather than asserting on real pixel positions.
import "../i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { commands } from "../ipc";
import { useViewerStore } from "../viewer/store";

afterEach(() => {
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

describe("open -> scroll -> search -> copy -> close", () => {
  it("drives the whole flow through the real UI against the mock engine", async () => {
    const user = userEvent.setup();
    render(<App />);

    // --- open ---
    const openButton = await screen.findByRole("button", { name: "Documento de texto de exemplo" });
    await user.click(openButton);

    const tab = await screen.findByRole("tab", { name: /demo-text\.pdf/ });
    expect(tab).toHaveAttribute("aria-selected", "true");

    // --- scroll (via the thumbnail rail, exercising the same `scrollToPage` path real
    // scrolling reports through) ---
    const rail = screen.getByLabelText("Miniaturas das páginas");
    const page3Thumb = await within(rail).findByAltText("Página 3");
    await user.click(page3Thumb.closest("button")!);

    await waitFor(() => {
      const activeTab = useViewerStore.getState().tabs.find((t) => t.docId === "mock-text-doc");
      expect(activeTab?.currentPage).toBe(2); // 0-based
    });

    // --- search ---
    await user.click(screen.getByRole("button", { name: "Pesquisar" }));
    const searchInput = await screen.findByPlaceholderText("Localizar no documento");
    await user.type(searchInput, "Rubrica");

    await waitFor(
      () => {
        expect(screen.getByText(/de 10/)).toBeInTheDocument(); // 2 hits/page x 5 pages
      },
      { timeout: 3000 },
    );
    // The one-line bar has no result list: expand to the docked panel to see the hits with context.
    await user.click(screen.getByRole("button", { name: "Pesquisa avançada (painel)" }));
    expect(screen.getAllByRole("button", { name: /Página \d/ }).length).toBeGreaterThan(0);

    // --- copy (via the same IPC call Ctrl+C drives — see useSelectionShortcuts.ts) ---
    const extracted = await commands.textExtractRange("mock-text-doc", { page: 0, start: 0, end: 21 });
    expect(extracted.status).toBe("ok");
    if (extracted.status === "ok") expect(extracted.data).toBe("Rubrica mock document");

    // --- close ---
    await user.click(screen.getByRole("button", { name: /Fechar demo-text\.pdf/ }));

    await waitFor(async () => {
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
      const openDocs = await commands.docListOpen();
      expect(openDocs.status === "ok" && openDocs.data).toEqual([]);
    });
    expect(await screen.findByRole("button", { name: "Documento de texto de exemplo" })).toBeInTheDocument();
  });
});
