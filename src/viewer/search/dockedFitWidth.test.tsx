// B12: the docked panel shrinks the viewer instead of overlaying it, so "fit to width" must
// recompute for the narrower scroller. ViewerSurface does that through a ResizeObserver; this
// pins that behaviour (jsdom has no layout, so the observer and the scroller width are driven by hand).
import "../../i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocInfo } from "../../ipc/bindings";
import { useViewerStore } from "../store";
import { ViewerSurface } from "../ViewerSurface";

const callbacks: Array<(entries: unknown[]) => void> = [];
const originalResizeObserver = globalThis.ResizeObserver;

class CapturingResizeObserver {
  constructor(callback: (entries: unknown[]) => void) {
    callbacks.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const info: DocInfo = {
  docId: "fit-doc",
  path: "fit.pdf",
  pageCount: 2,
  pages: [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
  ],
  encrypted: false,
  dirty: false,
  revision: 0,
  hasForm: false,
};

beforeEach(() => {
  callbacks.length = 0;
  globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useViewerStore.getState().openTab(info);
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

describe("docked panel -> fit to width", () => {
  it("recomputes the zoom when the viewer gets narrower", async () => {
    render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    const zoomBefore = useViewerStore.getState().tabs[0].zoom;
    expect(zoomBefore).toBeCloseTo((1200 - 48) / 612, 3); // test setup: every element is 1200px wide

    // The docked panel takes 370px: the scroller is now 830px wide and the observer fires.
    Object.defineProperty(screen.getByTestId("viewer-scroll"), "clientWidth", { configurable: true, value: 830 });
    act(() => callbacks.forEach((callback) => callback([])));

    const tab = useViewerStore.getState().tabs[0];
    expect(tab.zoomMode).toBe("fit-width");
    expect(tab.zoom).toBeCloseTo((830 - 48) / 612, 3);
    expect(tab.zoom).toBeLessThan(zoomBefore);
    // let the mock tile renderer settle so nothing is still running when the environment is torn down
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  });
});
