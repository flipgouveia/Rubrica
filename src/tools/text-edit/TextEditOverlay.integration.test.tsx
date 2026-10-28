// Mock-driven integration test (R6 brief item 8): exercises `TextEditOverlay`
// against the REAL mock IPC (`commands` from `../../ipc`, not a stub) —
// selecting and editing a run, deleting one, adding a new text box by
// dragging on the overlay, and a font-substitution round trip, each with an
// undo/redo check against the actual mock engine's document state
// (mirroring `AnnotationLayer.integration.test.tsx` / `FieldOverlay.
// integration.test.tsx`'s own shape).
import "@testing-library/jest-dom/vitest";
import "../../i18n";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePageViewport } from "../../chrome/tool-api";
import { commands } from "../../ipc";
import { Tooltip } from "../../tokens/components";
import { deleteSelectedTextObject } from "./actions";
import { useTextEditStore } from "./model";
import { substitutionKey, useSubstitutionStore } from "./substitutionStore";
import { TextEditOverlay } from "./TextEditOverlay";

/** See `AnnotationLayer.integration.test.tsx`'s identical helper for why this builds pointer-shaped events on top of `MouseEvent` rather than fighting jsdom for a real `PointerEvent` (jsdom has none — https://github.com/jsdom/jsdom/issues/2527). */
function firePointerEvent(target: Element, type: string, init: { clientX: number; clientY: number; pointerId: number; button?: number }): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, clientY: init.clientY, button: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  target.dispatchEvent(event);
}

/** The badge's Tooltip.Root needs an ambient Tooltip.Provider — in the real app that's `AppShell.tsx`'s single top-level one; this test provides its own, scoped to just the render. */
function renderOverlay(props: Parameters<typeof TextEditOverlay>[0]): ReturnType<typeof render> {
  return render(
    <Tooltip.Provider>
      <TextEditOverlay {...props} />
    </Tooltip.Provider>,
  );
}

function resetStores(): void {
  useTextEditStore.setState({ mode: "select", selection: null, imagePath: "", newTextStyle: { fontSize: 12, color: "#000000" } });
  useSubstitutionStore.setState({ substitutedKeys: new Set() });
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
});

describe("TextEditOverlay + mock engine integration", () => {
  it("selects and edits a run, deletes another, and adds a new text box by dragging — each surviving undo/redo", async () => {
    const user = userEvent.setup();

    const openResult = await commands.docOpen("demo-text.pdf");
    expect(openResult.status).toBe("ok");
    if (openResult.status !== "ok") return;
    const docId = openResult.data.docId;
    const page = 0;
    const pageSize = openResult.data.pages[page];
    const viewport = makePageViewport(docId, page, pageSize.width ?? 612, pageSize.height ?? 792, 1, 0);

    const before = await commands.textObjects(docId, page);
    expect(before.status).toBe("ok");
    const run = before.status === "ok" ? before.data[0] : undefined;
    expect(run).toBeTruthy();
    if (!run) return;
    const originalText = run.text;

    renderOverlay({ viewport, isActive: true });

    const runHitTarget = await screen.findByTestId(`text-edit-run-${run.objectId}`);

    // --- Click to select, click again (now selected) to open the inline editor ---
    await user.click(runHitTarget);
    expect(useTextEditStore.getState().selection).toEqual({ docId, page, objectId: run.objectId });
    await user.click(runHitTarget);

    const editor = await screen.findByRole("textbox");
    expect(editor).toHaveValue(originalText);
    await user.clear(editor);
    await user.type(editor, "Edited heading{Enter}");

    await waitFor(async () => {
      const result = await commands.textObjects(docId, page);
      if (result.status === "ok") expect(result.data.find((r) => r.objectId === run.objectId)?.text).toBe("Edited heading");
    });
    // The run stays selected after a successful edit (TextEditOverlay's commitRunEdit).
    expect(useTextEditStore.getState().selection).toEqual({ docId, page, objectId: run.objectId });

    await act(async () => {
      await commands.historyUndo(docId);
    });
    await waitFor(async () => {
      const result = await commands.textObjects(docId, page);
      if (result.status === "ok") expect(result.data.find((r) => r.objectId === run.objectId)?.text).toBe(originalText);
    });

    await act(async () => {
      await commands.historyRedo(docId);
    });
    await waitFor(async () => {
      const result = await commands.textObjects(docId, page);
      if (result.status === "ok") expect(result.data.find((r) => r.objectId === run.objectId)?.text).toBe("Edited heading");
    });

    // --- Delete the (still-selected) run via the same action the panel's delete button calls ---
    await act(async () => {
      const deleted = await deleteSelectedTextObject();
      expect(deleted).toBe(true);
    });
    await waitFor(async () => {
      const result = await commands.textObjects(docId, page);
      if (result.status === "ok") expect(result.data.find((r) => r.objectId === run.objectId)).toBeUndefined();
    });
    expect(useTextEditStore.getState().selection).toBeNull();

    await act(async () => {
      await commands.historyUndo(docId); // brings the run back (with its edited text — undo/redo are per-mutation, not per-tool)
    });
    await waitFor(async () => {
      const result = await commands.textObjects(docId, page);
      if (result.status === "ok") expect(result.data.find((r) => r.objectId === run.objectId)?.text).toBe("Edited heading");
    });

    // --- Add-text mode: drag out a new text box, type into it, and commit ---
    act(() => {
      useTextEditStore.setState({ mode: "addText" });
    });
    const beforeAddResult = await commands.textObjects(docId, page);
    const countBeforeAdd = beforeAddResult.status === "ok" ? beforeAddResult.data.length : 0;

    const overlay = screen.getByTestId("text-edit-overlay");
    await act(async () => {
      firePointerEvent(overlay, "pointerdown", { clientX: 40, clientY: 400, pointerId: 2 });
      firePointerEvent(overlay, "pointermove", { clientX: 220, clientY: 430, pointerId: 2 });
      firePointerEvent(overlay, "pointerup", { clientX: 220, clientY: 430, pointerId: 2 });
    });

    const newTextEditor = await screen.findByRole("textbox");
    await user.type(newTextEditor, "Brand new box{Enter}");

    let newRunId: string | undefined;
    await waitFor(async () => {
      const result = await commands.textObjects(docId, page);
      if (result.status === "ok") {
        expect(result.data.length).toBe(countBeforeAdd + 1);
        newRunId = result.data.find((r) => r.text === "Brand new box")?.objectId;
        expect(newRunId).toBeTruthy();
      }
    });

    await act(async () => {
      await commands.historyUndo(docId);
    });
    await waitFor(async () => {
      const result = await commands.textObjects(docId, page);
      if (result.status === "ok") expect(result.data.some((r) => r.objectId === newRunId)).toBe(false);
    });

    await act(async () => {
      await commands.historyRedo(docId);
    });
    await waitFor(async () => {
      const result = await commands.textObjects(docId, page);
      if (result.status === "ok") expect(result.data.some((r) => r.objectId === newRunId)).toBe(true);
    });
  });

  it("marks a run as font-substituted when the mock reports it, renders the badge, and clears the mark on delete", async () => {
    const user = userEvent.setup();

    const openResult = await commands.docOpen("demo-form.pdf");
    expect(openResult.status).toBe("ok");
    if (openResult.status !== "ok") return;
    const docId = openResult.data.docId;
    const page = 1; // mock/state.ts: the form doc's page-1 heading run has embeddedFontUsable: false
    const pageSize = openResult.data.pages[page];
    const viewport = makePageViewport(docId, page, pageSize.width ?? 612, pageSize.height ?? 792, 1, 0);

    const before = await commands.textObjects(docId, page);
    const run = before.status === "ok" ? before.data[0] : undefined;
    expect(run).toBeTruthy();
    if (!run) return;
    expect(run.embeddedFontUsable).toBe(false);

    renderOverlay({ viewport, isActive: true });

    const runHitTarget = await screen.findByTestId(`text-edit-run-${run.objectId}`);
    await user.click(runHitTarget);
    await user.click(runHitTarget);
    const editor = await screen.findByRole("textbox");
    await user.type(editor, " (edited){Enter}");

    await waitFor(() => {
      expect(useSubstitutionStore.getState().substitutedKeys.has(substitutionKey(docId, run.objectId))).toBe(true);
    });
    expect(await screen.findByTestId(`text-edit-font-substituted-badge-${run.objectId}`)).toBeInTheDocument();

    // Deleting the run — the same action the panel's delete button calls — clears the tracked flag too.
    await act(async () => {
      await deleteSelectedTextObject();
    });
    expect(useSubstitutionStore.getState().substitutedKeys.has(substitutionKey(docId, run.objectId))).toBe(false);

    // Leave this shared mock document undone back to its original state for any test that runs after this one.
    await act(async () => {
      await commands.historyUndo(docId);
    });
  });
});
