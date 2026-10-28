// R8 deliverable 1: "recovery (kill mid-edit, journal replay)". Split across two spec FILES
// (this one, and 07-recovery-b-check.e2e.mjs) rather than two `it()`s in one file, because
// WebdriverIO gives each spec file its own fresh session — and therefore its own fresh app
// process launch — which is exactly the "kill it, then launch again" shape this scenario needs;
// a single session can't relaunch the app it's attached to mid-test.
//
// This file: open text.pdf, rotate its first page (a real, journaled commit — CONTRACTS §8: every
// commit is appended to the autosave journal immediately, independent of doc_save), then kill the
// process outright — never calling doc_save, so the journal survives on disk for the next launch
// to find (a clean WebDriver session close would instead go through the app's own graceful
// shutdown path and likely save/clean up, defeating the point).
import { activateTool, openByPath } from "../lib/actions.mjs";
import { fixture } from "../lib/paths.mjs";
import { clearJournals, hasJournal, killApp } from "../lib/process.mjs";

const LNG = "pt-PT";

describe("recovery (1/2): commit an edit, then kill the app before saving", () => {
  it("clears any stale journal from an earlier run", () => {
    clearJournals();
  });

  it("opens text.pdf and rotates its first page", async () => {
    await openByPath(LNG, fixture("text.pdf"));
    await activateTool(LNG, "tools-pages:tools-pages.toolbar.label");
    const thumb = await $('[role="button"][aria-label*="Selecionar a página"]');
    await thumb.waitForExist({ timeout: 10000 });
    // The thumbnail CARD (role="button") is a fixed-width flex container (Tailwind `w-40`,
    // PageThumbnail.tsx) — it never resizes, so a rotation's aspect-ratio flip only ever shows up
    // on the `<img>` inside it (styled with a real `aspectRatio: width/height`), not the card
    // itself (the same bug 03-pages.e2e.mjs's identical check had until this was fixed there).
    const img = await thumb.$("img");
    const before = await img.getSize();
    await thumb.click();
    const rotateRight = await $('button[aria-label*="Rodar para a direita"]');
    await rotateRight.waitForEnabled({ timeout: 10000 });
    await rotateRight.click();
    // Confirm the rotation actually committed before killing the process — a fixed pause alone
    // doesn't prove the mutation (and therefore the journal append) really landed, only that some
    // time passed.
    await browser.waitUntil(
      async () => {
        const after = await img.getSize();
        return Math.abs(after.width / after.height - before.height / before.width) < 0.15;
      },
      { timeout: 10000, timeoutMsg: "rotation never took visible effect before the kill" },
    );
  });

  it("kills the app without saving, leaving a journal behind", async () => {
    killApp();
    // A moment for the OS to actually tear the process down before the next spec file tries to
    // launch a fresh one against the same install/portable directory.
    await browser.pause(1000);
    expect(hasJournal()).toBe(true);
  });
});
