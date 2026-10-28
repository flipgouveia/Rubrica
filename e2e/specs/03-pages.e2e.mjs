// R8 deliverable 1: "reorder + delete pages" against the real engine, then "save → reopen →
// assert everything survived". Uses page-count and per-thumbnail aspect ratio (a 90° rotation
// swaps width/height) as the observable signals, rather than pixel-level thumbnail content, since
// a screenshot-diff isn't a meaningful cross-run assertion in CI.
//
// A real gap a review found in an earlier version of this file: despite the scenario's own name
// and the PR description, it never actually performed a drag reorder, and its rotate+delete steps
// both targeted the SAME page (index 0) — so the reopen check could pass even if reorder,
// rotation-survives-reorder, or blank-page persistence were all silently broken. Fixed by rotating
// page 0 itself first (see `docs/BACKLOG.md`: rotation angle isn't exposed through `DocInfo`, only
// the post-rotation aspect ratio, so a 90°/270° flip is the only identity signal available) and
// then dragging THAT rotated page to swap with its neighbor via the real pointer-driven drag
// handle (`PageThumbnail.tsx`'s `dragHandle` button, not HTML5 drag-and-drop — `PagesPanel.tsx`
// tracks the gesture via plain pointermove/pointerup) — asserting the rotated page's own index
// actually changed, not just that the page count stayed the same. An adjacent, one-slot swap
// (rather than dragging clear across the whole grid) also sidesteps a real e2e-harness limitation
// found along the way: `PagesPanel.tsx`'s own drag tracking has no auto-scroll-while-dragging, so
// a drag spanning pages that aren't simultaneously on screen can't land correctly, and a
// coordinate computed past a thumbnail sitting at the edge of the grid can put the pointer outside
// the actual window entirely (WebDriver rejects that outright as "move target out of bounds").
import { t } from "../lib/i18n.mjs";
import { activateTool, openByPath, saveAs } from "../lib/actions.mjs";
import { fixture, scratchPath } from "../lib/paths.mjs";

const LNG = "pt-PT";
const path = fixture("text.pdf");
const savedPath = scratchPath("pages.pdf");

async function pageThumbnails() {
  // Every PageThumbnail.tsx root is `role="button"` with an aria-label built from
  // tools-pages.actions.selectPage's "Selecionar a página {{page}}" template — match the
  // constant prefix so this doesn't need to guess the current page count up front.
  const prefix = t(LNG, "tools-pages:tools-pages.actions.selectPage", { page: "" }).trim();
  return $$(`[role="button"][aria-label^="${prefix}"]`);
}

/** The `role="button"` thumbnail card itself is a FIXED-width (Tailwind `w-40`) flex container — it never changes width, so measuring IT for a rotation's aspect-ratio flip always fails. The `<img>` inside is the one styled with `aspectRatio: width/height` from the real page size (PageThumbnail.tsx) and is what actually reflects a rotation. */
async function pageThumbnailImageSize(index) {
  const thumbs = await pageThumbnails();
  const img = await thumbs[index].$("img");
  return img.getSize();
}

/** Index of the (single) landscape thumbnail among the current page list, or -1 if none is — used to track the rotated identity-marker page across a reorder/delete/insert/reopen instead of assuming it stays at a fixed position. */
async function findLandscapeIndex() {
  const thumbs = await pageThumbnails();
  for (let i = 0; i < thumbs.length; i++) {
    const img = await thumbs[i].$("img");
    const size = await img.getSize();
    if (size.width > size.height) return i;
  }
  return -1;
}

/** Drags the drag-handle of the page at `fromIndex` to just past the right edge of the page at `toIndex` — a real pointer-driven gesture through `PagesPanel.tsx`'s own drag tracking, not HTML5 drag-and-drop. `fromIndex`/`toIndex` should be adjacent (or close) — see this file's header comment on why a long-distance drag isn't reliable here. */
async function dragPageTo(fromIndex, toIndex) {
  // Reset the grid's own scroll position first — both the source handle and the drop target need
  // to be on screen TOGETHER at one fixed scroll state for the whole gesture to land correctly
  // (scrolling one into view after the other, separately, moves the shared scrollable ancestor
  // and invalidates whichever coordinate was measured first — confirmed by hand: doing that
  // intermittently made the pointerdown land on a completely different page's label text instead
  // of the handle).
  const grid = await $('[data-testid="pages-grid"]');
  await browser.execute((el) => {
    el.scrollTop = 0;
  }, grid);
  await browser.pause(200);

  const thumbs = await pageThumbnails();
  const fromPage = fromIndex + 1; // dragHandle's {{page}} is 1-based
  const handle = await thumbs[fromIndex].$(`aria/${t(LNG, "tools-pages:tools-pages.actions.dragHandle", { page: fromPage })}`);
  const handleLoc = await handle.getLocation();
  const handleSize = await handle.getSize();
  const startX = Math.round(handleLoc.x + handleSize.width / 2);
  const startY = Math.round(handleLoc.y + handleSize.height / 2);

  const targetThumb = thumbs[toIndex];
  const targetLoc = await targetThumb.getLocation();
  const targetSize = await targetThumb.getSize();
  // Within the target thumbnail's own right edge (not past it — a target sitting at the edge of
  // the grid can otherwise put the pointer outside the actual window). computeDropIndex (dnd.ts)
  // only needs the pointer on the right half of the target to resolve to "drop after this one".
  const endX = Math.round(targetLoc.x + targetSize.width * 0.85);
  const endY = Math.round(targetLoc.y + targetSize.height / 2);

  await browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: startX, y: startY },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 100, x: Math.round((startX + endX) / 2), y: Math.round((startY + endY) / 2) },
        { type: "pointerMove", duration: 100, x: endX, y: endY },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

describe("pages: reorder, rotate, delete, insert — survive save + reopen", () => {
  let initialCount;

  it("opens text.pdf and activates Pages", async () => {
    await openByPath(LNG, path);
    await activateTool(LNG, "tools-pages:tools-pages.toolbar.label");
    initialCount = (await pageThumbnails()).length;
    expect(initialCount).toBeGreaterThan(2); // needs at least 3 pages: one to rotate+track, one to reorder past, one to delete
  });

  it("rotates the first page 90° — this becomes the identity marker tracked through the rest of the scenario", async () => {
    const before = await pageThumbnailImageSize(0);
    const thumbs = await pageThumbnails();
    await thumbs[0].click();
    const rotateRight = await $(`aria/${t(LNG, "tools-pages:tools-pages.actions.rotateRight")}`);
    await rotateRight.waitForEnabled({ timeout: 10000 });
    await rotateRight.click();
    await browser.waitUntil(
      async () => {
        const after = await pageThumbnailImageSize(0);
        // Aspect ratio flips (width/height swap); compare the RATIO, not raw pixels, since the
        // image is fit-to-width inside its fixed-width thumbnail card.
        const beforeRatio = before.width / before.height;
        const afterRatio = after.width / after.height;
        return Math.abs(afterRatio - 1 / beforeRatio) < 0.15;
      },
      { timeout: 10000, timeoutMsg: "page thumbnail's aspect ratio never flipped after a 90° rotate" },
    );
    expect(await findLandscapeIndex()).toBe(0);
  });

  it("drags the rotated page past its neighbor — a real reorder, not just a rotation", async () => {
    expect(await findLandscapeIndex()).toBe(0); // still first, before any reorder

    await dragPageTo(0, 1);

    await browser.waitUntil(async () => (await pageThumbnails()).length === initialCount, {
      timeout: 5000,
      timeoutMsg: "page count changed after a plain reorder drag",
    });
    // The real assertion this scenario exists for: the rotated page's own index actually moved —
    // not "the count stayed the same" (true even for a complete no-op) and not "some page
    // somewhere is landscape" (true even if nothing moved).
    await browser.waitUntil(async () => (await findLandscapeIndex()) === 1, {
      timeout: 5000,
      timeoutMsg: "rotated page never moved from index 0 to index 1 after the drag",
    });
  });

  it("deletes the last page via the confirm dialog (a different page from the rotated/reordered one)", async () => {
    const rotatedIndexBeforeDelete = await findLandscapeIndex();
    const lastIndex = initialCount - 1;
    const thumbs = await pageThumbnails();
    await thumbs[lastIndex].click();
    const deleteButton = await $(`aria/${t(LNG, "tools-pages:tools-pages.actions.delete")}`);
    await deleteButton.waitForEnabled({ timeout: 10000 });
    await deleteButton.click();
    const confirmButton = await $(`aria/${t(LNG, "common:common.actions.delete")}`);
    await confirmButton.waitForExist({ timeout: 5000 });
    await confirmButton.click();
    await browser.waitUntil(async () => (await pageThumbnails()).length === initialCount - 1, {
      timeout: 10000,
      timeoutMsg: "page count didn't decrease by 1 after delete",
    });
    // Deleting the LAST page never shifts any earlier index — the rotated marker (at index 1,
    // well before the end) should be exactly where it was.
    expect(await findLandscapeIndex()).toBe(rotatedIndexBeforeDelete);
  });

  it("inserts a blank page", async () => {
    const rotatedIndexBeforeInsert = await findLandscapeIndex();
    const insertButton = await $(`aria/${t(LNG, "tools-pages:tools-pages.actions.insertBlank")}`);
    await insertButton.click();
    await browser.waitUntil(async () => (await pageThumbnails()).length === initialCount, {
      timeout: 10000,
      timeoutMsg: "page count didn't increase by 1 after inserting a blank page",
    });
    // Nothing was selected, so the blank page lands at the end (PagesPanel.tsx's own
    // insertionIndex()) — the rotated marker's own index shouldn't move.
    expect(await findLandscapeIndex()).toBe(rotatedIndexBeforeInsert);
  });

  it("saves (Save As, to a scratch copy), reopens, and the reordered + rotated + inserted pages all survived", async () => {
    const rotatedIndexBeforeSave = await findLandscapeIndex();
    await browser.keys(["Escape"]);
    await saveAs(LNG, savedPath);
    // Save As doesn't rebind the tab's displayed filename (see 01-annotate's note / docs/BACKLOG.md) — it still shows "text.pdf".
    const closeButton = await $('button[aria-label*="text.pdf"]');
    if (await closeButton.isExisting()) await closeButton.click();
    await openByPath(LNG, savedPath);
    await activateTool(LNG, "tools-pages:tools-pages.toolbar.label");
    await browser.waitUntil(async () => (await pageThumbnails()).length === initialCount, {
      timeout: 10000,
      timeoutMsg: `expected ${initialCount} pages after reopen`,
    });
    // The real assertion this scenario exists for: the rotation AND the reordered position both
    // round-tripped together, at the same index they were at right before saving — not just "some
    // page somewhere is still landscape" and not just "the count matches".
    await browser.waitUntil(
      async () => (await findLandscapeIndex()) === rotatedIndexBeforeSave,
      { timeout: 10000, timeoutMsg: `expected the rotated page to still be at index ${rotatedIndexBeforeSave} after reopen` },
    );
  });
});
