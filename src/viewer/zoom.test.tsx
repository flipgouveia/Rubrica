// Keyboard zoom: Ctrl + / Ctrl = / Ctrl - / Ctrl 0 on every keyboard variant (US, Portuguese, numpad).
import "../i18n";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppViewStore } from "../chrome/appViewStore";
import { useGlobalShortcuts } from "../chrome/shortcuts";
import type { DocInfo } from "../ipc/bindings";
import { useViewerStore } from "./store";
import { ZOOM_STEP, useZoomShortcuts } from "./zoom";

const info: DocInfo = {
  docId: "zoom-doc",
  path: "zoom.pdf",
  pageCount: 1,
  pages: [{ width: 612, height: 792 }],
  encrypted: false,
  dirty: false,
  revision: 0,
  hasForm: false,
};

function Harness() {
  useGlobalShortcuts();
  useZoomShortcuts("zoom-doc");
  return <input data-testid="field" />;
}

const zoom = () => useViewerStore.getState().tabs[0].zoom;

/** Dispatches a real keydown and returns it, so the test can check whether it was handled (`defaultPrevented`). */
function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { ctrlKey: true, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useViewerStore.getState().openTab(info);
  useViewerStore.getState().setZoom("zoom-doc", 1, "fit-width");
  useAppViewStore.setState({ view: "viewer" });
  render(<Harness />);
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({ tabs: [], activeTabId: null });
  useAppViewStore.setState({ view: "home" });
});

describe("zoom in", () => {
  it.each([
    ["US '=' key", { key: "=", code: "Equal" }],
    ["US Shift+'=' (types '+')", { key: "+", code: "Equal", shiftKey: true }],
    ["Portuguese '+' key (no Shift)", { key: "+", code: "BracketRight" }],
    ["numpad +", { key: "+", code: "NumpadAdd" }],
    ["numpad + with Shift held", { key: "+", code: "NumpadAdd", shiftKey: true }],
  ])("steps up on %s", (_name, init) => {
    const event = press(init);
    expect(event.defaultPrevented).toBe(true);
    expect(zoom()).toBeCloseTo(ZOOM_STEP, 5);
    expect(useViewerStore.getState().tabs[0].zoomMode).toBe("custom");
  });

  it("stops at the maximum zoom", () => {
    for (let i = 0; i < 20; i += 1) press({ key: "=", code: "Equal" });
    expect(zoom()).toBe(5);
  });
});

describe("zoom out", () => {
  it.each([
    ["'-' key", { key: "-", code: "Minus" }],
    ["Portuguese '-' key", { key: "-", code: "Slash" }],
    ["US Shift+'-' (types '_')", { key: "_", code: "Minus", shiftKey: true }],
    ["numpad -", { key: "-", code: "NumpadSubtract" }],
  ])("steps down on %s", (_name, init) => {
    const event = press(init);
    expect(event.defaultPrevented).toBe(true);
    expect(zoom()).toBeCloseTo(1 / ZOOM_STEP, 5);
  });

  it("stops at the minimum zoom", () => {
    for (let i = 0; i < 20; i += 1) press({ key: "-", code: "Minus" });
    expect(zoom()).toBe(0.25);
  });
});

describe("reset", () => {
  it.each([
    ["the digit row", { key: "0", code: "Digit0" }],
    ["the numpad", { key: "0", code: "Numpad0" }],
  ])("returns to 100%% on %s, whatever the zoom mode was", (_name, init) => {
    useViewerStore.getState().setZoom("zoom-doc", 2.4, "fit-width");
    expect(press(init).defaultPrevented).toBe(true);
    expect(zoom()).toBe(1);
    expect(useViewerStore.getState().tabs[0].zoomMode).toBe("custom");
  });
});

describe("zoom shortcuts are not triggered by", () => {
  it("a plain '+' / '-' / '0' without Ctrl", () => {
    for (const init of [{ key: "+", code: "NumpadAdd" }, { key: "-", code: "Minus" }, { key: "0", code: "Digit0" }]) {
      expect(press({ ...init, ctrlKey: false }).defaultPrevented).toBe(false);
    }
    expect(zoom()).toBe(1);
  });

  it("Ctrl+Shift+0 on a Portuguese keyboard (types '=')", () => {
    expect(press({ key: "=", code: "Digit0", shiftKey: true }).defaultPrevented).toBe(false);
    expect(zoom()).toBe(1);
  });

  it("Ctrl+Alt combinations (AltGr)", () => {
    expect(press({ key: "+", code: "BracketRight", altKey: true }).defaultPrevented).toBe(false);
    expect(zoom()).toBe(1);
  });

  it("anything while Home or Settings is showing", () => {
    useAppViewStore.setState({ view: "settings" });
    press({ key: "=", code: "Equal" });
    expect(zoom()).toBe(1);
  });
});

describe("in a text field", () => {
  it("still zooms (these chords type nothing, and the search box is usually focused)", () => {
    const field = document.querySelector("input") as HTMLInputElement;
    field.focus();
    press({ key: "=", code: "Equal" }, field);
    expect(zoom()).toBeCloseTo(ZOOM_STEP, 5);
  });
});
