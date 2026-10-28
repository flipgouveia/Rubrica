// R8 deliverable 1: "edit a text run" against the real engine, then "save → reopen → assert
// everything survived". Edits the first real text run PDFium reports for page 0 (its exact
// content/boundaries differ from the mock's single synthetic "Page N heading" run, so this
// doesn't assume anything about which specific words end up in that run) to a unique marker
// string, then confirms that marker is findable via search after a real save + reopen.
import { activateTool, openByPath, saveAs } from "../lib/actions.mjs";
import { fixture, scratchPath } from "../lib/paths.mjs";
import { searchAndCountHits, closeSearch } from "../lib/search.mjs";

const LNG = "pt-PT";
const path = fixture("text.pdf");
const savedPath = scratchPath("textedit.pdf");
const MARKER = "E2E-MARKER-TEXTEDIT";

describe("text-edit: an edited run survives save + reopen", () => {
  it("opens text.pdf, activates Text Edit, edits the first run", async () => {
    await openByPath(LNG, path);
    await activateTool(LNG, "tools-textedit:tools-textedit.toolbar.label");
    const run = await $('[data-testid^="text-edit-run-"]');
    await run.waitForExist({ timeout: 10000 });
    await run.click(); // first click: select
    // A pause here matters: TextEditOverlay.tsx's handleRunClick decides select-vs-edit by
    // checking whether THIS run is already the selected one — two clicks fired back-to-back
    // faster than React re-renders the selection state can both be seen as "not yet selected",
    // so the second click selects again instead of opening the editor (confirmed by hand: without
    // this pause, the inline editor's <input> never appears at all).
    await browser.pause(500);
    await run.click(); // second click (already selected): opens the inline editor
    const editor = await $('[data-testid="text-edit-overlay"] input');
    await editor.waitForExist({ timeout: 5000 });
    // Not editor.setValue()/editor.click() here: re-querying this element to invoke a remote
    // "clear + focus + send keys" on it is what was going stale (InlineTextEditor.tsx mounts the
    // input already focused via its own useEffect — confirmed by hand: document.activeElement is
    // already this <input> the instant it appears). Driving it via plain global keys instead avoids
    // ever re-resolving the element handle a second time.
    await browser.keys(["Control", "a"]); // select the pre-filled initialValue (the run's own text)
    await browser.keys(MARKER.split(""));
    await browser.keys(["Enter"]);
    await browser.pause(1000);
  });

  it("saves (Save As, to a scratch copy), reopens, and the edited text is findable", async () => {
    await browser.keys(["Escape"]);
    await saveAs(LNG, savedPath);
    // Save As doesn't rebind the tab's displayed filename (see 01-annotate's note / docs/BACKLOG.md) — it still shows "text.pdf".
    const closeButton = await $('button[aria-label*="text.pdf"]');
    if (await closeButton.isExisting()) await closeButton.click();
    await openByPath(LNG, savedPath);
    const hits = await searchAndCountHits(MARKER);
    expect(hits).toBeGreaterThan(0);
    await closeSearch();
  });
});
