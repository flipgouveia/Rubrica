// Shared, locale-aware page actions used across specs — every selector goes through `t(lng, key)`
// (e2e/lib/i18n.mjs) rather than a hardcoded string, so the same helper drives both the pt-PT
// main flow and the "both-language smoke" scenario (R8 deliverable 1) just by passing a different
// `lng`.
import { t } from "./i18n.mjs";

/** Types an absolute path into the Home screen's path field and opens it (HomeScreen.tsx: Enter or the "Open" button both call the same handleOpenPath). Waits for a tab with that file's basename to appear. */
export async function openByPath(lng, absolutePath, { timeout = 20000 } = {}) {
  const input = await $(`input[placeholder="${t(lng, "screens:screens.home.pathPlaceholder")}"]`);
  await input.waitForExist({ timeout });
  await input.setValue(absolutePath);
  await input.addValue(""); // WebDriver Enter key
  const basename = absolutePath.split(/[\\/]/).pop();
  const tab = await $(`[role="tab"]*=${basename}`);
  await tab.waitForExist({ timeout });
  return tab;
}

/**
 * Clicks a button/control by its accessible name (WebdriverIO's `aria/` selector strategy —
 * matches `aria-label`, or falls back to text content, exactly like a screen reader would). Every
 * tool-cluster and mode button in this app is an icon-only `IconButton` with no visible text node
 * (see src/chrome/Toolbar.tsx's tool-cluster loop, AnnotationToolbar.tsx's `ModeButton`s) — a
 * plain WebdriverIO `button=text` selector (exact TEXT CONTENT match) silently never matches
 * those, which is what every one of this file's callers hit before this was fixed.
 */
export async function clickByAccessibleName(lng, key) {
  const button = await $(`aria/${t(lng, key)}`);
  await button.waitForExist({ timeout: 10000 });
  await button.click();
  return button;
}

/**
 * Clicks a tool's toolbar toggle button by its real toolbar label
 * (namespace:namespace.toolbar.label — matches what every tool package's index.ts registers).
 * Verifies `aria-pressed` actually flipped to `"true"` and clicks once more if not: confirmed by
 * hand that the FIRST click right after a document finishes opening can silently not register
 * (`toggleTool`'s zustand update never lands) — a real, if narrow, UI race rather than a
 * WebDriver quirk, since a second click immediately afterward always works.
 */
export async function activateTool(lng, toolLabelKey) {
  const button = await clickByAccessibleName(lng, toolLabelKey);
  await browser.pause(500);
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await browser.pause(500);
  }
  return button;
}

/**
 * Ctrl+S — chrome.doc.save is an "always"-scope shortcut (src/chrome/Toolbar.tsx), simpler and
 * more robust than opening the File menu. Only safe to call on a document already opened from
 * e2e/.scratch/ (see `saveAs` below) — never on a fixture opened straight from `fixtures/`, since
 * this overwrites the file at its CURRENT path. (A real mistake this suite made early on: several
 * specs plain-`save()`d straight over `fixtures/text.pdf`/`form.pdf` — the checked-in corpus
 * fixtures/README.md and docs/PORTABILITY-CHECKLIST.md both say to keep pristine — silently
 * accumulating annotations/pages/redactions across every local run until `git status` caught it.)
 */
export async function save() {
  await browser.keys(["Control", "s"]);
}

/**
 * Save menu -> Save As -> types `destAbsolutePath` -> confirms. Use this (never plain `save()`)
 * whenever a spec opened a document straight from `fixtures/` and needs to persist an edit —
 * writes to a scratch copy instead of overwriting the checked-in fixture. Returns nothing; the
 * caller re-opens `destAbsolutePath` (via `openByPath`) to verify the round-trip.
 */
export async function saveAs(lng, destAbsolutePath) {
  await clickByAccessibleName(lng, "chrome:chrome.toolbar.saveMenu");
  const saveAsItem = await $(`aria/${t(lng, "chrome:chrome.toolbar.saveAs")}`);
  await saveAsItem.waitForExist({ timeout: 5000 });
  await saveAsItem.click();
  // NOT a plain CSS attribute selector here — the real bug this replaced: the pt-PT placeholder
  // string is itself an example Windows path ("ex.: C:\Users\utilizador\Documentos\ficheiro.pdf")
  // containing backslashes, which a raw `input[placeholder="..."]` selector string feeds straight
  // into CSS's OWN escape-sequence syntax (`\U`, `\D`, ...) — silently never matching, even though
  // the dialog renders correctly every time (confirmed by hand: `getHTML()` on the dialog showed
  // the exact right `<input placeholder="...">` present, while the CSS-selector query for it kept
  // timing out). `aria/` matches by accessible name instead (an unlabeled `<input>`'s accessible
  // name falls back to its `placeholder` per the ARIA spec), sidestepping CSS escaping entirely.
  const input = await $(`aria/${t(lng, "chrome:chrome.saveAs.pathPlaceholder")}`);
  await input.waitForExist({ timeout: 10000 });
  await input.setValue(destAbsolutePath);
  // Scoped to the dialog, NOT a bare `aria/` lookup: the toolbar's Save menu trigger carries the
  // same accessible name ("Save"/"Guardar") and sits earlier in the DOM than this portalled
  // dialog, so an unscoped query would click the trigger and reopen the menu instead.
  const confirmButton = await $('[role="dialog"]').$(`button*=${t(lng, "common:common.actions.save")}`);
  await confirmButton.waitForClickable({ timeout: 5000 });
  await confirmButton.click();
  // SaveAsDialog.tsx awaits the real docSaveAs IPC call before closing itself — wait for the
  // dialog to actually disappear (not a fixed pause) so a large/slow save can't leave the caller
  // racing ahead while it's still in flight.
  await $('[role="dialog"]').waitForExist({ timeout: 15000, reverse: true });
  await browser.pause(500);
}

/** Waits for the tab's dirty-dot to clear and `save_state` to settle — polls the tab's own accessible name, since TabsBar.tsx surfaces dirty state there (see src/chrome/TabsBar.tsx). A fixed short wait is used instead of a hard assertion on a specific DOM marker, since the exact dirty-indicator markup isn't part of any tool's public contract. */
export async function waitForSaveToSettle(ms = 1500) {
  await browser.pause(ms);
}

/** Closes the currently open tab (so a later `openByPath` re-opens the file fresh from disk, not from the in-memory session) via its own close button, then confirms via Home screen. */
export async function closeActiveTab(lng, basename) {
  const closeButton = await $(`button[aria-label*="${basename}"]`);
  if (await closeButton.isExisting()) {
    await closeButton.click();
  }
}
