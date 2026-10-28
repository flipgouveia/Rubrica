// Mock-driven integration test (R4 brief item 5): wired against the REAL
// mock IPC (`commands`/`events` from `../../ipc`, not a stub), exercising
// the forms tool end to end against the fixture's actual 2-page form
// document — open, fill every field kind, confirm document-order Tab
// navigation across two separately-mounted `FieldOverlay` instances, then
// undo and confirm a value reverts.
import "../../i18n";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { commands } from "../../ipc";
import { FieldOverlay } from "./FieldOverlay";
import type { PageViewport } from "../shared/coords";

const VIEWPORT: PageViewport = { pageWidthPt: 612, pageHeightPt: 792, scale: 1 };

describe("FieldOverlay (mock-driven integration)", () => {
  it("fills every field kind via the real mock engine, honors document-order Tab navigation across page instances, and reverts on undo", async () => {
    const user = userEvent.setup();

    const openResult = await commands.docOpen("demo-form.pdf");
    if (openResult.status !== "ok") throw new Error(`setup: docOpen failed: ${openResult.error.message}`);
    const docId = openResult.data.docId;

    const setValueSpy = vi.spyOn(commands, "formSetValue");

    // Page 1's overlay mounts BEFORE page 0's in the DOM, deliberately: this
    // is what proves cross-instance tab order comes from the explicit,
    // globally-computed `tabIndex` (`useFormFields.tabIndexFor`, driven by
    // `sortFieldsInDocumentOrder`) rather than from incidental DOM/mount
    // order, which two sibling `FieldOverlay` instances have no control
    // over in the real chrome-hosted app either.
    render(
      <>
        <FieldOverlay docId={docId} page={1} viewport={VIEWPORT} />
        <FieldOverlay docId={docId} page={0} viewport={VIEWPORT} />
      </>,
    );

    const nameInput = await screen.findByRole("textbox");
    const subscribeCheckbox = screen.getByRole("checkbox");
    // Nothing is selected yet in the fixture (`field-plan.value === ""`),
    // so "Basic" (the first option) is the group's native tab stop.
    const basicRadio = screen.getByLabelText("Basic");
    const countrySelect = screen.getByRole("combobox");
    const languageListbox = screen.getByRole("listbox");

    // --- Focus + Tab navigation in document order (brief item 3) ---
    await user.tab();
    expect(nameInput).toHaveFocus();
    await user.tab();
    expect(subscribeCheckbox).toHaveFocus();
    await user.tab();
    expect(basicRadio).toHaveFocus();
    await user.tab();
    expect(countrySelect).toHaveFocus();
    await user.tab();
    expect(languageListbox).toHaveFocus();

    // Shift+Tab walks the same order backward.
    await user.tab({ shift: true });
    expect(countrySelect).toHaveFocus();

    // --- Per-kind editors + "next field" flow (Enter commits & advances) ---
    nameInput.focus();
    await user.keyboard("Ada Lovelace{Enter}");
    expect(setValueSpy).toHaveBeenCalledWith(docId, "field-name", "Ada Lovelace");
    // Enter advanced focus to the NEXT field in document order, not DOM order.
    expect(subscribeCheckbox).toHaveFocus();

    await user.click(subscribeCheckbox);
    expect(setValueSpy).toHaveBeenCalledWith(docId, "field-subscribe", "On");

    await user.click(screen.getByLabelText("Enterprise"));
    expect(setValueSpy).toHaveBeenCalledWith(docId, "field-plan", "Enterprise");

    await user.selectOptions(countrySelect, "France");
    expect(setValueSpy).toHaveBeenCalledWith(docId, "field-country", "France");

    await user.selectOptions(languageListbox, "es");
    expect(setValueSpy).toHaveBeenCalledWith(docId, "field-language", "es");

    // Every value actually landed in the real mock engine's document state.
    const afterFill = await commands.formFields(docId);
    if (afterFill.status !== "ok") throw new Error("formFields failed");
    const valuesAfterFill = Object.fromEntries(afterFill.data.map((f) => [f.id, f.value]));
    expect(valuesAfterFill).toMatchObject({
      "field-name": "Ada Lovelace",
      "field-subscribe": "On",
      "field-plan": "Enterprise",
      "field-country": "France",
      "field-language": "es",
    });

    // --- Undo reverts the most recent committed mutation only ---
    await act(async () => {
      await commands.historyUndo(docId);
    });
    const afterUndo = await commands.formFields(docId);
    if (afterUndo.status !== "ok") throw new Error("formFields failed");
    const valuesAfterUndo = Object.fromEntries(afterUndo.data.map((f) => [f.id, f.value]));
    expect(valuesAfterUndo["field-language"]).toBe("pt-PT"); // reverted to the fixture's original value
    expect(valuesAfterUndo["field-country"]).toBe("France"); // earlier mutations stay committed

    // The DOM reflects the revert too, driven by the real `doc_state_changed` event.
    expect(await screen.findByRole("listbox")).toHaveValue("pt-PT");
  });
});
