// Layout contract of the viewer with the density map mounted (search v2): the strip sits next to
// the scroller, never inside it (so it does not scroll), and its 30px are reserved with or
// without results so the fit-width zoom is a function of the scroller alone.
import "../i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/bindings";
import { useViewerStore } from "./store";
import { ViewerSurface } from "./ViewerSurface";

const info: DocInfo = {
  docId: "layout-doc",
  path: "layout.pdf",
  pageCount: 3,
  pages: Array.from({ length: 3 }, () => ({ width: 612, height: 792 })),
  encrypted: false,
  dirty: false,
  revision: 0,
  hasForm: false,
};

beforeEach(() => {
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useViewerStore.getState().openTab(info);
});

afterEach(async () => {
  // let the mock tile renderer settle so nothing is still running when the environment is torn down
  await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  cleanup();
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

describe("ViewerSurface layout", () => {
  it("reserves a 30px gutter beside the scroller, outside the scrolling element", () => {
    render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    const scroller = screen.getByTestId("viewer-scroll");
    const gutter = screen.getByTestId("density-gutter");
    expect(scroller.contains(gutter)).toBe(false);
    expect(gutter.parentElement).toBe(scroller.parentElement);
    expect(gutter).toHaveClass("w-[30px]", "shrink-0");
    expect(scroller).toHaveClass("flex-1", "min-w-0");
  });

  it("fits the width to the scroller's own width (the gutter is not part of it)", () => {
    render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    expect(useViewerStore.getState().tabs[0].zoom).toBeCloseTo((1200 - 48) / 612, 3);
  });
});

describe("ViewerSurface Ctrl+wheel zoom", () => {
  const zoom = () => useViewerStore.getState().tabs[0].zoom;
  const wheel = (scroller: HTMLElement, init: WheelEventInit): WheelEvent => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    act(() => {
      scroller.dispatchEvent(event);
    });
    return event;
  };

  it("registers a non-passive native listener (React's onWheel is passive, so its preventDefault is ignored)", () => {
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    try {
      render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
      const scroller = screen.getByTestId("viewer-scroll");
      const wheelCalls = add.mock.calls.filter(([type], i) => type === "wheel" && add.mock.contexts[i] === scroller);
      expect(wheelCalls).toHaveLength(1);
      expect(wheelCalls[0][2]).toMatchObject({ passive: false });
    } finally {
      add.mockRestore();
    }
  });

  it("zooms in and cancels the event on Ctrl+wheel up", () => {
    render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    const before = zoom();
    const event = wheel(screen.getByTestId("viewer-scroll"), { ctrlKey: true, deltaY: -100 });
    expect(event.defaultPrevented).toBe(true);
    expect(zoom()).toBeGreaterThan(before);
    expect(useViewerStore.getState().tabs[0].zoomMode).toBe("custom");
  });

  it("zooms out on Ctrl+wheel down, symmetrically", () => {
    render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    const before = zoom();
    wheel(screen.getByTestId("viewer-scroll"), { ctrlKey: true, deltaY: -100 });
    wheel(screen.getByTestId("viewer-scroll"), { ctrlKey: true, deltaY: 100 });
    expect(zoom()).toBeCloseTo(before, 6);
    wheel(screen.getByTestId("viewer-scroll"), { ctrlKey: true, deltaY: 100 });
    expect(zoom()).toBeLessThan(before);
  });

  it("leaves a plain wheel alone (it scrolls)", () => {
    render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    const before = zoom();
    const event = wheel(screen.getByTestId("viewer-scroll"), { deltaY: -100 });
    expect(event.defaultPrevented).toBe(false);
    expect(zoom()).toBe(before);
  });

  it("never goes past the zoom limits", () => {
    render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    for (let i = 0; i < 40; i += 1) wheel(screen.getByTestId("viewer-scroll"), { ctrlKey: true, deltaY: -100 });
    expect(zoom()).toBe(5);
    for (let i = 0; i < 80; i += 1) wheel(screen.getByTestId("viewer-scroll"), { ctrlKey: true, deltaY: 100 });
    expect(zoom()).toBe(0.25);
  });
});

describe("ViewerSurface zoom anchoring", () => {
  it("keeps the page at the top of the viewport at the top when the zoom changes", async () => {
    const pages = Array.from({ length: 20 }, () => ({ width: 612, height: 792 }));
    useViewerStore.setState({ tabs: [], activeTabId: null });
    useViewerStore.getState().openTab({ ...info, docId: "anchor-doc", pageCount: 20, pages });
    useViewerStore.getState().setZoom("anchor-doc", 1, "custom");
    const view = render(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    const scroller = screen.getByTestId("viewer-scroll");
    await act(async () => {
      scroller.scrollTop = 5 * (792 + 16) + 100; // 100px into page 5; the list starts 24px below the padding edge
      scroller.dispatchEvent(new Event("scroll"));
    });
    await act(async () => {
      useViewerStore.getState().setZoom("anchor-doc", 2, "custom");
      view.rerender(<ViewerSurface tab={useViewerStore.getState().tabs[0]} />);
    });
    // listY = scrollTop - 24 = 5 * 808 + 76 at 100%  ->  5 * (2 * 792 + 16) + 152 at 200%, then + 24 again
    expect(scroller.scrollTop).toBeCloseTo(5 * (2 * 792 + 16) + 152 + 24, 3);
  });
});

describe("ViewerSurface current page", () => {
  it("is the page at the top of the screen, not the first overscanned row", async () => {
    const pages = Array.from({ length: 20 }, () => ({ width: 612, height: 792 }));
    useViewerStore.setState({ tabs: [], activeTabId: null });
    useViewerStore.getState().openTab({ ...info, docId: "long-doc", pageCount: 20, pages });
    const tab = useViewerStore.getState().tabs[0]; // the component lays out with this snapshot's zoom (1)
    render(<ViewerSurface tab={tab} />);
    const scroller = screen.getByTestId("viewer-scroll");
    const pageStride = 792 * tab.zoom + 16;

    await act(async () => {
      scroller.scrollTop = 5 * pageStride + 100;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(useViewerStore.getState().tabs[0].currentPage).toBe(5); // with 2 rows of overscan this used to read 3
  });
});
