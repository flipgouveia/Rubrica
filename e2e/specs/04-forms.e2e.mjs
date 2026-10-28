// R8 deliverable 1: "fill the government form" against the real engine, then "save → reopen →
// assert everything survived". Only checkbox fields actually persist in v1 (a verified
// pdfium-render 0.9.3 limitation — see agents/reports/r5-report.md and docs/BACKLOG.md), so this
// scenario exercises exactly that field: fixtures/form.pdf's "identificacao.aceitoTermos"
// checkbox, via the real field-name-derived accessible name (fields/fieldLabels.ts's
// `humanizeFieldId` — a real AcroForm field's `id` IS its PDF field name, unlike the mock's
// "field-*" placeholder ids).
import { activateTool, openByPath, saveAs } from "../lib/actions.mjs";
import { fixture, scratchPath } from "../lib/paths.mjs";

const LNG = "pt-PT";
const path = fixture("form.pdf");
const savedPath = scratchPath("forms.pdf");
const CHECKBOX_SELECTOR = 'input[type="checkbox"][aria-label*="aceitoTermos"]';

describe("forms: the one field kind that persists in v1 survives save + reopen", () => {
  it("opens form.pdf, activates Forms, finds the checkbox unchecked", async () => {
    await openByPath(LNG, path);
    // FieldOverlay only mounts while forms IS the active tool (no overlayAlwaysOn, unlike
    // annotate/redact — see src/chrome/tool-api.tsx's useOverlayTools) — the checkbox doesn't
    // exist in the DOM at all until this is clicked.
    await activateTool(LNG, "tools-forms:tools-forms.toolbar.label");
    const checkbox = await $(CHECKBOX_SELECTOR);
    await checkbox.waitForExist({ timeout: 10000 });
    await expect(checkbox).not.toBeSelected();
  });

  it("checks it", async () => {
    const checkbox = await $(CHECKBOX_SELECTOR);
    await checkbox.click();
    await browser.waitUntil(async () => checkbox.isSelected(), { timeout: 5000, timeoutMsg: "checkbox never reported checked after click" });
  });

  it("saves (Save As, to a scratch copy), reopens, and the checked state survived", async () => {
    await browser.keys(["Escape"]);
    await saveAs(LNG, savedPath);
    // Save As doesn't rebind the tab's displayed filename (see 01-annotate's note / docs/BACKLOG.md) — it still shows "form.pdf".
    const closeButton = await $('button[aria-label*="form.pdf"]');
    if (await closeButton.isExisting()) await closeButton.click();
    await openByPath(LNG, savedPath);
    await activateTool(LNG, "tools-forms:tools-forms.toolbar.label");
    const checkbox = await $(CHECKBOX_SELECTOR);
    await checkbox.waitForExist({ timeout: 10000 });
    await expect(checkbox).toBeSelected();
  });
});
