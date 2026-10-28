// R8 deliverable 1: "redact a term" against the real engine, then "save → reopen → assert
// everything survived" — here specifically: the redacted text is actually gone (not just
// covered), and search itself still works for content that wasn't touched.
//
// Marks a rect by dragging directly on the redact overlay (RedactOverlay.tsx's own drag-to-mark
// gesture — the same mechanism 01-annotate.e2e.mjs's shape/ink/note steps already use), covering
// roughly the top slice of page 1 where "The Rubrica Field Guide" heading sits
// (fixtures/generate.mjs: PAGE_HEIGHT=792, MARGIN=72, so the heading starts about 72pt/9% of the
// page height down from the top).
//
// Two real, non-obvious selector-ambiguity bugs this scenario found (both in this test, not the
// app — recorded here since they're exactly the kind of thing anyone writing a similar spec would
// hit again):
//   1. "Redigir" is the accessible name of BOTH the toolbar's tool-activation toggle
//      (tools-redact.toolbar.label) AND the panel's own apply button
//      (tools-redact.actions.redact) — both exist simultaneously once the tool is active, and a
//      bare `$(aria/Redigir)` matches the FIRST one in DOM order, the toolbar TOGGLE, not the
//      panel's apply button. Clicking it just deactivates the tool (a real click, no error, no
//      exception) — confirmed by hand, over many iterations, as the actual reason "no dialog ever
//      opens" persisted: it looked exactly like a redact_apply/state bug (marks staying pending
//      with no visible error) until the true cause was found. `findApplyButton()` below picks the
//      LAST DOM match instead — the panel (mounted after the toolbar) is reliably later in tree
//      order.
//   2. Radix's Dialog keeps its content mounted in the DOM even while closed (for its own exit
//      animation bookkeeping) — `$('[role="dialog"]').isExisting()` is therefore NOT a reliable
//      "is it actually open" signal; `data-state="open"` is.
import { t } from "../lib/i18n.mjs";
import { activateTool, openByPath, saveAs } from "../lib/actions.mjs";
import { fixture, scratchPath } from "../lib/paths.mjs";
import { closeSearch, searchAndCountHits } from "../lib/search.mjs";

const LNG = "pt-PT";
const path = fixture("text.pdf");
const savedPath = scratchPath("redact.pdf");

async function redactOverlaySvg() {
  const svg = await $(`svg[aria-label="${t(LNG, "tools-redact:tools-redact.overlay.ariaLabel")}"]`);
  await svg.waitForExist({ timeout: 10000 });
  return svg;
}

/** The panel's own "Redigir" button — NOT the toolbar toggle sharing the same accessible name (see this file's header comment). The panel mounts after (and inside a different tree from) the toolbar, so it's reliably the LAST DOM match. */
async function findApplyButton() {
  const candidates = await $$(`aria/${t(LNG, "tools-redact:tools-redact.actions.redact")}`);
  return candidates[candidates.length - 1];
}

describe("redact: a real term is actually removed, search still works elsewhere", () => {
  let hitsBefore;

  it("opens text.pdf and confirms 'Rubrica' is found", async () => {
    await openByPath(LNG, path);
    hitsBefore = await searchAndCountHits("Rubrica");
    expect(hitsBefore).toBeGreaterThan(0);
    await closeSearch();
  });

  it("marks the heading area by dragging, and applies it", async () => {
    await activateTool(LNG, "tools-redact:tools-redact.toolbar.label");
    const svg = await redactOverlaySvg();
    const location = await svg.getLocation();
    const size = await svg.getSize();
    // Roughly the top 20% of the page, full width — comfortably covers the heading regardless of
    // exact zoom/scale (see this file's header comment for why that's where "Rubrica" is).
    const x0 = location.x + size.width * 0.05;
    const x1 = location.x + size.width * 0.95;
    const y0 = location.y + size.height * 0.03;
    const y1 = location.y + size.height * 0.2;
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: Math.round(x0), y: Math.round(y0) },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 100, x: Math.round(x1), y: Math.round(y1) },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.pause(500); // let the drag gesture's pointer-up fully settle before the next click

    const applyButton = await findApplyButton();
    await applyButton.waitForEnabled({ timeout: 10000 });
    await applyButton.click();
    const dialog = await $('[role="dialog"][data-state="open"]');
    await dialog.waitForExist({ timeout: 10000 });

    const confirmButton = await dialog.$(`aria/${t(LNG, "tools-redact:tools-redact.confirmDialog.confirm")}`);
    await confirmButton.waitForExist({ timeout: 5000 });
    await confirmButton.click();
    await $('[role="dialog"][data-state="open"]').waitForExist({ timeout: 10000, reverse: true });

    // Check the live, in-session document (before any save) — proves redact_apply itself
    // actually removed the term, isolating that from any later save/reopen round-trip issue.
    await browser.pause(2000);
    const hitsLiveAfterRedact = await searchAndCountHits("Rubrica");
    expect(hitsLiveAfterRedact).toBeLessThan(hitsBefore);
    await closeSearch();
  });

  it("saves (Save As, to a scratch copy) and reopens", async () => {
    await browser.keys(["Escape"]);
    await saveAs(LNG, savedPath);
    // Save As doesn't rebind the tab's displayed filename (see 01-annotate's note / docs/BACKLOG.md) — it still shows "text.pdf".
    const closeButton = await $('button[aria-label*="text.pdf"]');
    if (await closeButton.isExisting()) await closeButton.click();
    await openByPath(LNG, savedPath);
  });

  it("no longer finds the redacted term", async () => {
    const hitsAfter = await searchAndCountHits("Rubrica");
    expect(hitsAfter).toBeLessThan(hitsBefore);
    await closeSearch();
  });

  it("still finds unrelated content — search itself wasn't broken by the redaction", async () => {
    const hits = await searchAndCountHits("the");
    expect(hits).toBeGreaterThan(0);
    await closeSearch();
  });
});
