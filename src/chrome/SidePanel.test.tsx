// Side panel tabs ("Miniaturas" / "Índice") against the mock engine's book document.
import "../i18n";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../ipc";
import type { DocInfo } from "../ipc/bindings";
import { useOutlineStore } from "../viewer/outline/outlineStore";
import { SIDE_PANEL_TAB_KEY, useSidePanelTabStore } from "../viewer/outline/sidePanelTabStore";
import { useViewerStore } from "../viewer/store";
import { SidePanel } from "./SidePanel";

let info: DocInfo;

function mount() {
  const tab = useViewerStore.getState().tabs[0];
  return render(<SidePanel docId={tab.docId} pageCount={tab.info.pageCount} currentPage={tab.currentPage} revision={tab.info.revision} pages={tab.info.pages} />);
}

const thumbnailsTab = () => screen.getByRole("tab", { name: "Miniaturas" });
const outlineTab = () => screen.getByRole("tab", { name: "Índice" });

beforeEach(async () => {
  localStorage.clear();
  useSidePanelTabStore.setState({ tab: "thumbnails", settled: false });
  useOutlineStore.setState({ byKey: {} });
  useViewerStore.setState({ tabs: [], activeTabId: null });
  const result = await commands.docOpen("book");
  if (result.status !== "ok") throw new Error("docOpen failed");
  info = result.data;
  useViewerStore.getState().openTab(info);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await commands.docClose(info.docId);
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

describe("SidePanel", () => {
  it("is an accessible tablist with Miniaturas selected by default", () => {
    mount();
    const list = screen.getByRole("tablist", { name: "Painel lateral" });
    expect(within(list).getAllByRole("tab")).toHaveLength(2);
    expect(thumbnailsTab()).toHaveAttribute("aria-selected", "true");
    expect(outlineTab()).toHaveAttribute("aria-selected", "false");
    expect(thumbnailsTab().tabIndex).toBe(0);
    expect(outlineTab().tabIndex).toBe(-1);
    // the selected tab controls the visible panel, which it also labels
    const panel = screen.getByRole("tabpanel", { name: "Miniaturas" });
    expect(thumbnailsTab().getAttribute("aria-controls")).toBe(panel.id);
    expect(within(panel).getByLabelText("Miniaturas das páginas")).toBeInTheDocument(); // the unchanged ThumbnailRail
    expect(screen.queryByRole("tree")).toBeNull(); // the outline panel is hidden
  });

  it("switches to the outline tree and back on click", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(outlineTab());
    expect(outlineTab()).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("tree", { name: "Índice do documento" })).toBeInTheDocument();
    expect(screen.getByLabelText("Miniaturas das páginas").closest("[hidden]")).not.toBeNull(); // hidden, not unmounted
    await user.click(thumbnailsTab());
    expect(screen.getByLabelText("Miniaturas das páginas").closest("[hidden]")).toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("keeps the thumbnail rail mounted while the outline shows", async () => {
    const user = userEvent.setup();
    mount();
    const rail = screen.getByLabelText("Miniaturas das páginas");
    await user.click(outlineTab());
    expect(rail.isConnected).toBe(true);
    expect(rail.closest("[hidden]")).not.toBeNull();
  });

  it("is wider on the outline tab, where titles need room", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("w-36");
    await user.click(outlineTab());
    expect(root).toHaveClass("w-60");
    expect(root).not.toHaveClass("w-36");
  });

  it("moves between tabs with the arrow keys, Home and End (roving tabindex)", async () => {
    const user = userEvent.setup();
    mount();
    thumbnailsTab().focus();
    await user.keyboard("{ArrowRight}");
    expect(outlineTab()).toHaveAttribute("aria-selected", "true");
    expect(outlineTab()).toHaveFocus();
    expect(outlineTab().tabIndex).toBe(0);
    expect(thumbnailsTab().tabIndex).toBe(-1);
    await user.keyboard("{ArrowRight}"); // wraps
    expect(thumbnailsTab()).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(outlineTab()).toHaveFocus();
    await user.keyboard("{Home}");
    expect(thumbnailsTab()).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(outlineTab()).toHaveAttribute("aria-selected", "true");
  });

  it("remembers the last tab: saved under ui.sidePanelTab and restored for the next panel", async () => {
    const user = userEvent.setup();
    const { unmount } = mount();
    await user.click(outlineTab());
    await waitFor(async () => expect(await commands.prefsGet(SIDE_PANEL_TAB_KEY)).toEqual({ status: "ok", data: "outline" }));
    unmount();

    // another tab's panel (same app session) starts on the remembered tab
    mount();
    expect(outlineTab()).toHaveAttribute("aria-selected", "true");
    cleanup();

    // and so does a fresh launch, which reads it back through prefs_get
    useSidePanelTabStore.setState({ tab: "thumbnails", settled: false });
    mount();
    await waitFor(() => expect(outlineTab()).toHaveAttribute("aria-selected", "true"));
  });

  it("falls back to Miniaturas for an unknown stored value", async () => {
    await commands.prefsSet(SIDE_PANEL_TAB_KEY, "bogus");
    mount();
    await waitFor(() => expect(useSidePanelTabStore.getState().settled).toBe(true));
    expect(thumbnailsTab()).toHaveAttribute("aria-selected", "true");
  });

  it("a tab picked before the stored value arrives wins over it", async () => {
    const user = userEvent.setup();
    await commands.prefsSet(SIDE_PANEL_TAB_KEY, "outline");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = commands.prefsGet;
    vi.spyOn(commands, "prefsGet").mockImplementation(async (key) => {
      await gate;
      return original(key);
    });
    mount();
    await user.click(thumbnailsTab());
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thumbnailsTab()).toHaveAttribute("aria-selected", "true");
  });
});
