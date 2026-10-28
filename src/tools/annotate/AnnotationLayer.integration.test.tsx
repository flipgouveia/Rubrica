// Mock-driven integration test (brief item 5): exercises `AnnotationLayer`
// against the REAL mock IPC (`commands`/`events` from `../../ipc`) rather
// than a mocked-out stand-in — the point is proving the actual mock engine
// round-trips a UI-driven mutation, not just that our own code calls the
// right functions. Drives a `shape` drag directly (pointerdown/move/up on
// the SVG) since that's the simplest fully-synchronous "draw and commit on
// release" path (no inline text entry, no async id-diffing like `note`).
import "@testing-library/jest-dom/vitest";
import "../../i18n";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { commands } from "../../ipc";
import type { PageViewport } from "../shared/coords";
import { AnnotationLayer } from "./AnnotationLayer";
import { DEFAULT_ANNOTATION_STYLE } from "./model";

const PAGE = 0;

/**
 * jsdom has no global `PointerEvent` constructor (a known, long-standing
 * gap — https://github.com/jsdom/jsdom/issues/2527), which also means
 * `@testing-library/dom`'s `fireEvent.pointerDown` &co. silently fall back
 * to a bare `Event` that drops `clientX`/`clientY`/`button` entirely (its
 * `createEvent` only forwards init properties through a real event
 * constructor's own constructor, and `Event`'s ignores anything it doesn't
 * recognize). A real `MouseEvent` DOES support `clientX`/`clientY`/`button`
 * natively, and React's synthetic pointer-event wrapper reads those (plus
 * `pointerId`, added here as a plain extra property) directly off whatever
 * native event object fired the listener — it doesn't care about the
 * object's actual constructor, only that the property is there. So this
 * builds pointer-shaped events on top of `MouseEvent` rather than fighting
 * jsdom for a real `PointerEvent`.
 */
function firePointerEvent(target: Element, type: string, init: { clientX: number; clientY: number; pointerId: number; button?: number }): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, clientY: init.clientY, button: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  target.dispatchEvent(event);
}

async function countShapes(docId: string): Promise<number> {
  const result = await commands.annotList(docId, PAGE);
  if (result.status !== "ok") throw new Error(result.error.message);
  return result.data.filter((a) => a.kind === "shape").length;
}

async function shapeIds(docId: string): Promise<string[]> {
  const result = await commands.annotList(docId, PAGE);
  if (result.status !== "ok") throw new Error(result.error.message);
  return result.data.filter((a) => a.kind === "shape").map((a) => a.annotId);
}

describe("AnnotationLayer + mock engine integration", () => {
  it("adds a shape by dragging on the overlay, round-trips through annot_list, and survives undo/redo", async () => {
    const openResult = await commands.docOpen("demo-text.pdf");
    expect(openResult.status).toBe("ok");
    if (openResult.status !== "ok") return;
    const docId = openResult.data.docId;
    const viewport: PageViewport = {
      pageWidthPt: openResult.data.pages[PAGE].width ?? 612,
      pageHeightPt: openResult.data.pages[PAGE].height ?? 792,
      scale: 1,
    };

    const before = await countShapes(docId);

    const { container } = render(
      <AnnotationLayer
        docId={docId}
        page={PAGE}
        viewport={viewport}
        mode="shape"
        style={{ ...DEFAULT_ANNOTATION_STYLE, shapeKind: "rect" }}
        selectedId={null}
        onSelectedIdChange={() => {}}
      />,
    );

    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    if (!svg) return;

    // Drag out a 100x80 rect (jsdom's getBoundingClientRect is all zeros, so
    // clientX/Y map directly to container-local coordinates here).
    await act(async () => {
      firePointerEvent(svg, "pointerdown", { clientX: 50, clientY: 50, pointerId: 1 });
      firePointerEvent(svg, "pointermove", { clientX: 150, clientY: 130, pointerId: 1 });
      firePointerEvent(svg, "pointerup", { clientX: 150, clientY: 130, pointerId: 1 });
    });

    await waitFor(async () => {
      expect(await countShapes(docId)).toBe(before + 1);
    });
    const idsAfterAdd = await shapeIds(docId);
    const newId = idsAfterAdd[idsAfterAdd.length - 1];

    await commands.historyUndo(docId);
    await waitFor(async () => {
      expect(await countShapes(docId)).toBe(before);
    });
    expect(await shapeIds(docId)).not.toContain(newId);

    await commands.historyRedo(docId);
    await waitFor(async () => {
      expect(await countShapes(docId)).toBe(before + 1);
    });
    // Same id reappears — undo/redo restores the exact annotation, not a
    // freshly re-minted one (CONTRACTS mock-upkeep expectation: "ids
    // persist and survive undo/redo").
    expect(await shapeIds(docId)).toContain(newId);
  });
});
