// Mock-driven integration test (brief item 7): exercises `RedactOverlay` + `apply.ts` against the
// REAL mock IPC (`commands` from `../../ipc`) rather than a mocked-out stand-in — the point is
// proving the actual mock engine round-trips a UI-driven redaction (drag a mark, apply it, confirm
// the underlying text run is genuinely gone via `textObjects`, then undo/redo it back), not just
// that our own code calls the right functions. Drives the drag directly (pointerdown/move/up on
// the overlay's SVG), matching `tools/annotate/AnnotationLayer.integration.test.tsx`'s approach.
import "@testing-library/jest-dom/vitest";
import "../../i18n";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makePageViewport } from "../../chrome/tool-api";
import { commands } from "../../ipc";
import { applyPendingMarks } from "./apply";
import { useRedactStore } from "./model";
import { RedactOverlay } from "./RedactOverlay";

const PAGE = 0;

/**
 * jsdom has no global `PointerEvent` constructor — see
 * `tools/annotate/AnnotationLayer.integration.test.tsx`'s identical helper for the full
 * explanation of why this builds pointer-shaped events on top of `MouseEvent` instead.
 */
function firePointerEvent(target: Element, type: string, init: { clientX: number; clientY: number; pointerId: number; button?: number }): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, clientY: init.clientY, button: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  target.dispatchEvent(event);
}

async function headingRunExists(docId: string): Promise<boolean> {
  const result = await commands.textObjects(docId, PAGE);
  if (result.status !== "ok") throw new Error(result.error.message);
  return result.data.some((run) => run.text.includes("heading"));
}

describe("RedactOverlay + apply.ts + mock engine integration", () => {
  it("marks a rect by dragging, applies it, removes the underlying text run, and survives undo/redo", async () => {
    const openResult = await commands.docOpen("demo-text.pdf");
    expect(openResult.status).toBe("ok");
    if (openResult.status !== "ok") return;
    const docId = openResult.data.docId;
    const widthPt = openResult.data.pages[PAGE].width ?? 612;
    const heightPt = openResult.data.pages[PAGE].height ?? 792;
    const viewport = makePageViewport(docId, PAGE, widthPt, heightPt, 1, 0);

    // The mock's fixed page-0 heading text run sits at PDF rect {x:72, y:700, width:300,
    // height:20} (mock/state.ts's `createTextDocState`), which at zoom 1 / page height 792 is
    // screen rect {x:72, y:72, width:300, height:20} (y flips: 792-720=72). Confirm it's there
    // before touching anything, so a later "gone" assertion is meaningful.
    expect(await headingRunExists(docId)).toBe(true);

    const { container } = render(<RedactOverlay viewport={viewport} isActive />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    if (!svg) return;

    // Drag a rect from (60,60) to (390,100) — comfortably contains the heading run's screen rect
    // (jsdom's getBoundingClientRect is all zeros, so clientX/Y map directly to container-local
    // coordinates, same as the annotate integration test).
    await act(async () => {
      firePointerEvent(svg, "pointerdown", { clientX: 60, clientY: 60, pointerId: 1 });
      firePointerEvent(svg, "pointermove", { clientX: 390, clientY: 100, pointerId: 1 });
      firePointerEvent(svg, "pointerup", { clientX: 390, clientY: 100, pointerId: 1 });
    });

    const marksAfterDrag = useRedactStore.getState().marksByDoc[docId] ?? [];
    expect(marksAfterDrag).toHaveLength(1);
    expect(marksAfterDrag[0].page).toBe(PAGE);

    // Apply — this is the real `redact_apply` IPC call, not a stand-in.
    const applyResult = await applyPendingMarks(docId, marksAfterDrag);
    expect(applyResult.error).toBeUndefined();
    expect(applyResult.appliedMarkIds).toEqual([marksAfterDrag[0].id]);
    useRedactStore.getState().removeMarks(docId, applyResult.appliedMarkIds);
    expect(useRedactStore.getState().marksByDoc[docId] ?? []).toHaveLength(0);

    await waitFor(async () => {
      expect(await headingRunExists(docId)).toBe(false);
    });

    // Undo: the redaction is a real Command on the same undo stack as everything else.
    await commands.historyUndo(docId);
    await waitFor(async () => {
      expect(await headingRunExists(docId)).toBe(true);
    });

    // Redo: back to redacted.
    await commands.historyRedo(docId);
    await waitFor(async () => {
      expect(await headingRunExists(docId)).toBe(false);
    });
  });
});
