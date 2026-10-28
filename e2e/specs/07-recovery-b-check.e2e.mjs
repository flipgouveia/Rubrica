// R8 deliverable 1: "recovery (kill mid-edit, journal replay)", part 2/2 — see
// 06-recovery-a-kill.e2e.mjs's header comment for why this is a separate spec file rather than a
// second `it()` there. WebdriverIO gives this file its own fresh session, which launches a brand
// new rubrica.exe — exactly the "next launch" CONTRACTS §4's `recovery_available` startup scan
// needs to find the journal the previous spec file left behind.
import { t } from "../lib/i18n.mjs";
import { activateTool } from "../lib/actions.mjs";
import { clearJournals } from "../lib/process.mjs";

const LNG = "pt-PT";

describe("recovery (2/2): the next launch offers to replay it", () => {
  // CONTRACTS §8: a journal is deleted only by a clean save, never by "recover, then move on" —
  // and this scenario deliberately never saves (that would mean Ctrl+S-ing straight over the
  // real fixtures/text.pdf, the exact fixture-pollution bug the other specs' saveAs fix avoids).
  // Left alone, this recovered-but-unsaved journal would keep re-triggering the recovery dialog
  // on every later launch — wdio.conf.mjs's onPrepare hook already guards the NEXT invocation of
  // this suite, but clean up now too so this file leaves the environment as it found it.
  after(() => clearJournals());
  it("shows the recovery dialog on startup", async () => {
    // A REAL, reproducible bug this found (confirmed by hand, both under this harness and via a
    // fully manual, non-automated launch against the same on-disk journal): `RecoveryDialog.tsx`
    // used to rely SOLELY on the `recovery_available` event, which the backend emits inside
    // Tauri's `setup()` hook — before the WebView2 JS runtime has even loaded index.html, let
    // alone mounted this component and attached its listener. That emit has no "replay for a
    // listener that attaches later" semantics, so it was lost on every real launch, not just
    // occasionally. Fixed by also querying `journal_recover(null)` (CONTRACTS §3) directly on
    // mount — see RecoveryDialog.tsx's own comment.
    const title = await $(`h2*=${t(LNG, "screens:screens.recovery.title")}`);
    await title.waitForExist({ timeout: 15000 });
  });

  it("recovers, and the rotation survived", async () => {
    const openAndRecover = await $(`aria/${t(LNG, "screens:screens.recovery.open")}`);
    await openAndRecover.click();
    const tab = await $('[role="tab"]*=text.pdf');
    await tab.waitForExist({ timeout: 15000 });

    // The rotated page's <img> (not its fixed-width thumbnail card — see 03-pages.e2e.mjs's and
    // 06-recovery-a-kill's identical note) should still show a landscape aspect ratio.
    await activateTool(LNG, "tools-pages:tools-pages.toolbar.label");
    const thumb = await $('[role="button"][aria-label*="Selecionar a página"]');
    await thumb.waitForExist({ timeout: 10000 });
    const img = await thumb.$("img");
    const size = await img.getSize();
    expect(size.width).toBeGreaterThan(size.height); // text.pdf's page is portrait; a 90° rotate makes it landscape
  });
});
