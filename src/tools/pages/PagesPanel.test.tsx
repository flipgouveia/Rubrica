// Mock-driven integration test for the pages tool (R4 brief item 5: "a
// mock-driven integration test per tool"). This renders `PagesPanel` wired
// to the REAL mock IPC (`commands`/`events` from `../../ipc`, exactly what
// the component itself imports) — nothing here is mocked out, so every
// assertion below is proof the real `pages_*` mock commands (CONTRACTS §3)
// get called correctly and that the UI reflects their results.
//
// The tests intentionally run as ONE ordered narrative sharing a single
// document instance (`mock/state.ts` keeps its two fake documents as
// module-level singletons for the lifetime of the module — i.e. this whole
// test file — by design; see that file's header comment). Vitest runs
// `it()` blocks within a `describe` in declaration order, and each test
// file gets its own fresh module graph, so this is safe and deterministic:
// each step's assertions are written against the document state left by
// the previous step, mirroring how a person would actually use this panel
// over time (open once, keep editing). `beforeEach`/`afterEach` only reset
// *UI* concerns (unmounting the previously rendered tree, restoring the
// `getBoundingClientRect` stub) — never the backend document itself.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import i18n from "../../i18n";
import { commands } from "../../ipc";
import type { DocInfo } from "../../ipc/bindings";
import { PagesPanel } from "./PagesPanel";

const DOC_PATH = "demo-text.pdf"; // mock/state.ts: any path containing "text" opens the fake 5-page text doc.
let docId: string;

/**
 * jsdom performs no real layout, so every element's `getBoundingClientRect()`
 * is all-zero by default — useless for exercising `computeDropIndex`
 * end-to-end through real pointer events. This stub gives each thumbnail
 * wrapper (identified by its own `data-page-index`, exactly what
 * `PagesPanel` renders) a synthetic single-row rect, 180px pitch/160px
 * wide, matching the geometry `dnd.test.ts` already exercises in isolation.
 */
function installRectStub(): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function stubbedRect(this: HTMLElement) {
    const el = this.closest("[data-page-index]");
    if (el instanceof HTMLElement) {
      const index = Number(el.getAttribute("data-page-index"));
      const left = index * 180;
      return {
        left,
        right: left + 160,
        top: 0,
        bottom: 220,
        width: 160,
        height: 220,
        x: left,
        y: 0,
        toJSON() {
          return this;
        },
      } as DOMRect;
    }
    return original.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

async function currentDocInfo(): Promise<DocInfo> {
  const result = await commands.docListOpen();
  if (result.status !== "ok") throw new Error(`docListOpen failed: ${result.error.message}`);
  const doc = result.data.find((d) => d.docId === docId);
  if (!doc) throw new Error(`document ${docId} is not open`);
  return doc;
}

/**
 * jsdom (26.x, as pinned in package.json) has no global `PointerEvent`
 * class at all — confirmed empirically: `new PointerEvent(...)` throws
 * `ReferenceError`, and `fireEvent.pointerMove(el, { clientX, clientY })`
 * silently produces an event with `clientX`/`clientY` both `undefined`
 * (its fallback event construction isn't a `MouseEvent`, so those
 * properties don't exist on it). Per the brief's own escape hatch ("if
 * simulating full pointer drag in jsdom is impractical..."), this
 * hand-builds a plain `MouseEvent` — which DOES carry `clientX`/`clientY`
 * in jsdom — typed with the pointer event's name (the DOM `Event`
 * constructor takes an arbitrary string as its type, so React's delegated
 * `onPointerDown`/`onPointerMove`/`onPointerUp` listeners, which key off
 * the native event *name* rather than its concrete class, still receive
 * it) and bolts on a `pointerId` own-property `PagesPanel`'s handlers also
 * read. This keeps the test driving the REAL `onPointerDown`/`onPointerMove`/
 * `onPointerUp` props end to end, only working around jsdom's missing
 * constructor rather than bypassing the component's event handling.
 */
function firePointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { pointerId: number; clientX: number; clientY: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId, configurable: true });
  fireEvent(target, event);
}

let restoreRectStub: () => void;

beforeAll(async () => {
  // The app defaults to pt-PT (CONTRACTS §7); force English here so test
  // assertions read naturally and stay stable regardless of the default
  // locale or future pt-PT wording tweaks.
  await i18n.changeLanguage("en");
  restoreRectStub = installRectStub();

  const opened = await commands.docOpen(DOC_PATH);
  if (opened.status !== "ok") throw new Error(`failed to open ${DOC_PATH}: ${opened.error.message}`);
  docId = opened.data.docId;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  restoreRectStub();
});

describe("PagesPanel (mock-driven integration)", () => {
  it("renders all 5 pages of the freshly opened mock document", async () => {
    render(<PagesPanel docId={docId} />);
    const thumbnails = await screen.findAllByRole("button", { name: /^Select page \d+$/ });
    expect(thumbnails).toHaveLength(5);
  });

  it("shift-click range-selects pages and reports the selected count", async () => {
    render(<PagesPanel docId={docId} />);
    const thumbnails = await screen.findAllByRole("button", { name: /^Select page \d+$/ });

    fireEvent.click(thumbnails[0]);
    expect(await screen.findByText("1 page selected")).toBeInTheDocument();

    fireEvent.click(thumbnails[4], { shiftKey: true });
    expect(await screen.findByText("5 pages selected")).toBeInTheDocument();
    thumbnails.forEach((thumb) => expect(thumb).toHaveAttribute("aria-pressed", "true"));
  });

  it("ctrl-click toggles a single page in/out of the selection", async () => {
    render(<PagesPanel docId={docId} />);
    const thumbnails = await screen.findAllByRole("button", { name: /^Select page \d+$/ });

    fireEvent.click(thumbnails[1]);
    fireEvent.click(thumbnails[3], { ctrlKey: true });
    expect(await screen.findByText("2 pages selected")).toBeInTheDocument();

    fireEvent.click(thumbnails[3], { ctrlKey: true });
    expect(await screen.findByText("1 page selected")).toBeInTheDocument();
  });

  it("cancel closes the delete dialog without calling pagesDelete", async () => {
    const beforeCount = (await currentDocInfo()).pageCount;
    const deleteSpy = vi.spyOn(commands, "pagesDelete");

    render(<PagesPanel docId={docId} />);
    const thumbnails = await screen.findAllByRole("button", { name: /^Select page \d+$/ });
    fireEvent.click(thumbnails[0]);

    fireEvent.click(screen.getByRole("button", { name: "Delete selected pages" }));
    expect(await screen.findByText("Delete page?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Delete page?")).not.toBeInTheDocument());

    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();
    expect((await currentDocInfo()).pageCount).toBe(beforeCount);
  });

  it("confirming a delete of every page surfaces the mock's INVALID_ARG guard instead of crashing", async () => {
    const before = await currentDocInfo();
    expect(before.pageCount).toBe(5);

    render(<PagesPanel docId={docId} />);
    const thumbnails = await screen.findAllByRole("button", { name: /^Select page \d+$/ });
    fireEvent.click(thumbnails[0]);
    fireEvent.click(thumbnails[4], { shiftKey: true });
    expect(await screen.findByText("5 pages selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete selected pages" }));
    expect(await screen.findByText("Delete 5 pages?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/can't delete every page/i);

    // The document survives untouched — the guard rejected the mutation.
    expect((await currentDocInfo()).pageCount).toBe(5);
  });

  it("drags the first page to the end via real pointer events, driving the real pagesReorder IPC", async () => {
    // Identity check via each page's text-run heading (`Page N heading`,
    // set once at fixture creation and never rewritten) — the mock's
    // placeholder thumbnails/labels are purely positional, so this is the
    // only way to confirm *content*, not just count, actually moved.
    const before = await commands.textObjects(docId, 0);
    expect(before.status).toBe("ok");
    if (before.status === "ok") expect(before.data[0]?.text).toBe("Page 1 heading");

    render(<PagesPanel docId={docId} />);
    await screen.findAllByRole("button", { name: /^Select page \d+$/ });

    const handle = screen.getByRole("button", { name: "Drag to reorder page 1" });
    firePointerEvent(handle, "pointerdown", { pointerId: 7, clientX: 80, clientY: 110 });

    const grid = screen.getByTestId("pages-grid");
    // Stubbed rects: index 3 spans [540, 700], center 620 — landing right on
    // its center resolves (per computeDropIndex) to "after index 3" == gap 4.
    firePointerEvent(grid, "pointermove", { pointerId: 7, clientX: 620, clientY: 110 });
    expect(screen.getByTestId("pages-drop-indicator")).toBeInTheDocument();

    firePointerEvent(grid, "pointerup", { pointerId: 7, clientX: 620, clientY: 110 });

    // Expected permutation: buildReorderedIndices([0,1,2,3,4], 0, 4) => [1,2,3,0,4].
    await waitFor(async () => {
      const run3 = await commands.textObjects(docId, 3);
      expect(run3.status).toBe("ok");
      if (run3.status === "ok") expect(run3.data[0]?.text).toBe("Page 1 heading");
    });

    const run0 = await commands.textObjects(docId, 0);
    if (run0.status === "ok") expect(run0.data[0]?.text).toBe("Page 2 heading");
    const run4 = await commands.textObjects(docId, 4);
    if (run4.status === "ok") expect(run4.data[0]?.text).toBe("Page 5 heading");

    expect((await currentDocInfo()).pageCount).toBe(5);
  });

  it("rotates the selected page 90 degrees, swapping its reported width/height", async () => {
    render(<PagesPanel docId={docId} />);
    const thumbnails = await screen.findAllByRole("button", { name: /^Select page \d+$/ });

    // Position 3 currently holds the page moved there by the drag test
    // above ("Page 1 heading") — any position works, this just keeps the
    // narrative coherent.
    fireEvent.click(thumbnails[3]);
    expect(await screen.findByText("1 page selected")).toBeInTheDocument();

    const before = (await currentDocInfo()).pages[3];

    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));

    await waitFor(async () => {
      const after = (await currentDocInfo()).pages[3];
      expect(after.width).toBe(before.height);
      expect(after.height).toBe(before.width);
    });
  });

  it("deletes one page through the confirm dialog, and historyUndo reverts it", async () => {
    const beforeCount = (await currentDocInfo()).pageCount;

    render(<PagesPanel docId={docId} />);
    const thumbnails = await screen.findAllByRole("button", { name: /^Select page \d+$/ });
    fireEvent.click(thumbnails[0]);

    fireEvent.click(screen.getByRole("button", { name: "Delete selected pages" }));
    expect(await screen.findByText("Delete page?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(async () => expect((await currentDocInfo()).pageCount).toBe(beforeCount - 1));

    const undoResult = await commands.historyUndo(docId);
    expect(undoResult.status).toBe("ok");

    await waitFor(async () => expect((await currentDocInfo()).pageCount).toBe(beforeCount));
  });

  it("inserts a blank page at the end when nothing is selected", async () => {
    const beforeCount = (await currentDocInfo()).pageCount;

    render(<PagesPanel docId={docId} />);
    await screen.findAllByRole("button", { name: /^Select page \d+$/ });

    fireEvent.click(screen.getByRole("button", { name: "Insert blank page" }));

    await waitFor(async () => expect((await currentDocInfo()).pageCount).toBe(beforeCount + 1));
  });
});
