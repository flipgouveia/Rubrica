// R8 deliverable 1: "annotate (each type once)" against the real engine, then "save → reopen →
// assert everything survived". Ctrl+A (viewer.selection.selectPage, src/viewer/selection/
// useSelectionShortcuts.ts) selects all text on the current page — used instead of a raw mouse
// drag over specific text so this doesn't depend on exact glyph pixel positions, which differ
// between the mock and the real PDFium-rendered layout.
import { t } from "../lib/i18n.mjs";
import { activateTool, openByPath, saveAs } from "../lib/actions.mjs";
import { fixture, scratchPath } from "../lib/paths.mjs";

const LNG = "pt-PT";
const savedPath = scratchPath("annotate.pdf");

/** The FIRST visible page's annotation-layer svg — used only for pointer-coordinate math (ink/note/shape/freeText are drawn wherever the pointer lands within this element's own bounds, so it doesn't matter which page it is, as long as later drawing stays targeted at it). */
async function annotationLayerSvg() {
  const svg = await $(`svg[aria-label="${t(LNG, "tools-annotate:tools-annotate.layer.ariaLabel")}"]`);
  await svg.waitForExist({ timeout: 10000 });
  return svg;
}

/**
 * Total annotation-shape element count ACROSS EVERY visible page's annotation-layer svg, not just
 * the first — `overlayAlwaysOn` mounts one instance per visible page, and highlight/underline/
 * strikeout (created via Ctrl+A on "the current page") don't necessarily land on the same page a
 * mouse-drawn ink/shape/note/freeText annotation does if that drag's y-offset overflows past the
 * first page's screen height into the next page's overlay. Summing across every mounted instance
 * makes this count robust to exactly which page each annotation ended up on (confirmed via a
 * dedicated single-annotation before/after-reopen check that byte-for-byte per-tag counts DO
 * round-trip correctly — the flakiness this replaced was in this test's own counting, not in the
 * app).
 */
async function shapeCount() {
  const svgs = await $$(`svg[aria-label="${t(LNG, "tools-annotate:tools-annotate.layer.ariaLabel")}"]`);
  let total = 0;
  for (const svg of svgs) {
    const children = await svg.$$("polygon, line, polyline, ellipse, rect, foreignObject, g");
    total += children.length;
  }
  return total;
}

/** `element.getElementRect()` isn't a real webdriverio element command (its own error names the raw protocol signature `getElementRect(elementId)`, which needs binding webdriverio doesn't do implicitly) — `getLocation()` + `getSize()` are the real element commands that give the same {x,y,width,height} shape. */
async function elementRect(el) {
  const location = await el.getLocation();
  const size = await el.getSize();
  return { x: location.x, y: location.y, width: size.width, height: size.height };
}

/**
 * Clicks one of the annotate toolbar's plain mode buttons (highlight/underline/strikeout/ink/
 * note/freeText — each an `aria-pressed` toggle, mutually exclusive via the shared `mode` store)
 * and verifies it actually registered before returning, retrying once if not.
 *
 * A REAL, reproducible bug this found: a plain unverified `.click()` here can silently not
 * register (the exact same first-click race `actions.mjs`'s `activateTool` already guards against
 * for TOOL activation — confirmed by hand this is not a WebDriver quirk, since a second click
 * immediately after always works).
 *
 * NOT used for "Forma" (shape) — see "draws a rectangle shape" below for why that one needs a
 * different interaction entirely, not just a retry.
 */
async function clickModeButton(labelKey) {
  const button = await $(`aria/${t(LNG, labelKey)}`);
  await button.waitForExist({ timeout: 10000 });
  await button.click();
  await browser.pause(300);
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await browser.pause(300);
  }
  return button;
}

describe("annotate: every kind, once, survives save + reopen", () => {
  const path = fixture("text.pdf");

  it("opens text.pdf", async () => {
    await openByPath(LNG, path);
  });

  it("activates the Annotate tool", async () => {
    await activateTool(LNG, "tools-annotate:tools-annotate.toolbar.label");
  });

  it("creates a highlight from a real page selection", async () => {
    const before = await shapeCount();
    await browser.keys(["Control", "a"]);
    await clickModeButton("tools-annotate:tools-annotate.toolbar.highlight");
    const applyButton = await $(`aria/${t(LNG, "tools-annotate:tools-annotate.toolbar.applyToSelection")}`);
    await applyButton.waitForEnabled({ timeout: 10000 });
    await applyButton.click();
    await browser.waitUntil(async () => (await shapeCount()) > before, { timeout: 10000, timeoutMsg: "highlight annotation never appeared" });
  });

  it("creates an underline from a real page selection", async () => {
    const before = await shapeCount();
    await browser.keys(["Control", "a"]);
    await clickModeButton("tools-annotate:tools-annotate.toolbar.underline");
    const applyButton = await $(`aria/${t(LNG, "tools-annotate:tools-annotate.toolbar.applyToSelection")}`);
    await applyButton.waitForEnabled({ timeout: 10000 });
    await applyButton.click();
    await browser.waitUntil(async () => (await shapeCount()) > before, { timeout: 10000, timeoutMsg: "underline annotation never appeared" });
  });

  it("creates a strikeout from a real page selection", async () => {
    const before = await shapeCount();
    await browser.keys(["Control", "a"]);
    await clickModeButton("tools-annotate:tools-annotate.toolbar.strikeout");
    const applyButton = await $(`aria/${t(LNG, "tools-annotate:tools-annotate.toolbar.applyToSelection")}`);
    await applyButton.waitForEnabled({ timeout: 10000 });
    await applyButton.click();
    await browser.waitUntil(async () => (await shapeCount()) > before, { timeout: 10000, timeoutMsg: "strikeout annotation never appeared" });
  });

  it("draws an ink stroke", async () => {
    const before = await shapeCount();
    await clickModeButton("tools-annotate:tools-annotate.toolbar.ink");
    const svg = await annotationLayerSvg();
    const rect = await elementRect(svg);
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: rect.x + 40, y: rect.y + 400 },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 100, x: rect.x + 80, y: rect.y + 420 },
          { type: "pointerMove", duration: 100, x: rect.x + 120, y: rect.y + 400 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () => (await shapeCount()) > before, { timeout: 10000, timeoutMsg: "ink annotation never appeared" });
  });

  it("places a sticky note", async () => {
    const before = await shapeCount();
    await clickModeButton("tools-annotate:tools-annotate.toolbar.note");
    const svg = await annotationLayerSvg();
    const rect = await elementRect(svg);
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: rect.x + 200, y: rect.y + 300 },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () => (await shapeCount()) > before, { timeout: 10000, timeoutMsg: "note annotation never appeared" });
    // The note popover opens immediately after placing — close it (Escape) so it doesn't block
    // the next scenario's own interactions with the page.
    await browser.keys(["Escape"]);
  });

  it("draws a rectangle shape", async () => {
    const before = await shapeCount();
    // A REAL, reproducible bug this found (confirmed by hand, both via aria-pressed and via the
    // engine's own `mode` value at pointer-down time): unlike every other mode button in this
    // toolbar (plain buttons — see `clickModeButton`), "Forma" is ALSO a Radix `Menu.Trigger`
    // (its shape-kind dropdown: Retângulo/Elipse/Linha/Seta). Under WebDriver automation, clicking
    // it reliably opens the dropdown (confirmed via `aria-expanded="true"`) but its own `onClick`
    // handler — the one that calls `onModeChange("shape")` — never fires, no matter how many times
    // it's clicked; `mode` stays whatever it was before. This is a Radix Trigger/asChild
    // interaction quirk under automated clicks, not an app bug reachable from a real mouse click —
    // but it means this scenario can't just click the toolbar button and go, unlike every sibling
    // tool. The reliable path: click it to open the dropdown, then pick "Retângulo" from the menu
    // — that item's own `onSelect` calls the SAME `onModeChange("shape")`, and clicking a plain
    // `Menu.Item` (not a `Menu.Trigger`) doesn't have this quirk.
    const shapeToggle = await $(`aria/${t(LNG, "tools-annotate:tools-annotate.toolbar.shape")}`);
    await shapeToggle.waitForExist({ timeout: 10000 });
    await shapeToggle.click();
    const rectOption = await $(`aria/${t(LNG, "tools-annotate:tools-annotate.shapes.rect")}`);
    await rectOption.waitForExist({ timeout: 5000 });
    await rectOption.click();
    await browser.pause(300);
    const svg = await annotationLayerSvg();
    const rect = await elementRect(svg);
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: rect.x + 250, y: rect.y + 150 },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 100, x: rect.x + 320, y: rect.y + 200 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () => (await shapeCount()) > before, { timeout: 10000, timeoutMsg: "shape annotation never appeared" });
  });

  it("adds a free text box", async () => {
    const before = await shapeCount();
    await clickModeButton("tools-annotate:tools-annotate.toolbar.freeText");
    const svg = await annotationLayerSvg();
    const rect = await elementRect(svg);
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: rect.x + 60, y: rect.y + 500 },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 100, x: rect.x + 200, y: rect.y + 530 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    const editor = await $("textarea, input[type=text]");
    await editor.waitForExist({ timeout: 5000 });
    await editor.setValue("e2e free text");
    // FreeTextEditor.tsx commits on blur or Ctrl+Enter specifically — a plain Enter just inserts
    // a newline (it's a <textarea>), so the annotation never got created until this was fixed.
    await browser.keys(["Control", "Enter"]);
    await browser.waitUntil(async () => (await shapeCount()) > before, { timeout: 10000, timeoutMsg: "free text annotation never appeared" });
  });

  let countBeforeReopen;

  it("saves the document (Save As, to a scratch copy — never overwrite the checked-in fixture)", async () => {
    countBeforeReopen = await shapeCount();
    await browser.keys(["Escape"]); // dismiss any lingering popover/menu before opening the File menu
    await saveAs(LNG, savedPath);
  });

  it("reopens the saved file and finds all annotations still there", async () => {
    await browser.keys(["Escape"]); // dismiss any lingering popover/menu/editor before closing the tab
    // A real, if minor, product gap found here: Save As does NOT update the open tab's displayed
    // filename back to "text.pdf" — CONTRACTS' doc_state_changed event carries no `path` field at
    // all, so the frontend has no way to learn of the rebind short of an explicit DocInfo refetch
    // TabsBar.tsx never does after Save As. Matching the still-displayed original name here
    // (not the saved-as one) until that's fixed — see docs/BACKLOG.md.
    const closeButton = await $('button[aria-label*="text.pdf"]');
    if (await closeButton.isExisting()) await closeButton.click();
    await openByPath(LNG, savedPath);
    await activateTool(LNG, "tools-annotate:tools-annotate.toolbar.label");
    await browser.waitUntil(async () => (await shapeCount()) >= countBeforeReopen, {
      timeout: 30000,
      interval: 1000,
      timeoutMsg: `expected at least ${countBeforeReopen} annotation elements after reopen`,
    });
  });
});
