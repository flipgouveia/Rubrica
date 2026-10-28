// R8 deliverable 1: "both-language smoke (switch to en, core flows still work)". Every helper in
// this suite already takes a language argument (e2e/lib/i18n.mjs's `t()`), so this doesn't repeat
// the other specs — it switches the app's actual UI language via Settings, then re-runs a small
// slice of the core flow (open a doc, activate a tool, use the viewer) with English selectors,
// proving the switch is real (not just a locale file existing) and that English isn't a
// second-class, undertested path.
import { t } from "../lib/i18n.mjs";
import { activateTool, openByPath } from "../lib/actions.mjs";
import { fixture } from "../lib/paths.mjs";
import { closeSearch, searchAndCountHits } from "../lib/search.mjs";

const path = fixture("text.pdf");

describe("i18n smoke: switching to English, core flows still work", () => {
  // The language switch calls prefs_set, which persists to the real %APPDATA%\Rubrica\rubrica.db
  // — not per-test-isolated. Left as English, EVERY OTHER spec in this suite (all pt-PT-based)
  // would fail from their very first Home-screen check on the next run, exactly like the
  // recovery scenario's leftover journal did (see wdio.conf.mjs's onPrepare comment) — a real bug
  // in this suite found by running it twice in a row.
  after(async () => {
    const settingsButton = await $(`aria/${t("en", "chrome:chrome.toolbar.settings")}`);
    if (await settingsButton.isExisting()) await settingsButton.click();
    const ptOption = await $(`aria/${t("en", "screens:screens.settings.language.ptPT")}`);
    if (await ptOption.isExisting()) await ptOption.click();
  });


  it("opens text.pdf in the pt-PT default, then switches to English via Settings", async () => {
    await openByPath("pt-PT", path);
    const settingsButton = await $(`aria/${t("pt-PT", "chrome:chrome.toolbar.settings")}`);
    await settingsButton.click();
    const englishOption = await $(`aria/${t("pt-PT", "screens:screens.settings.language.en")}`);
    await englishOption.waitForExist({ timeout: 10000 });
    await englishOption.click();
    // Confirm the switch actually took effect before navigating anywhere else — the settings
    // screen's own title should now render in English.
    const title = await $(`h1=${t("en", "screens:screens.settings.title")}`);
    await title.waitForExist({ timeout: 10000 });
  });

  it("returns to Home (now in English) and reopens the document", async () => {
    const backButton = await $(`aria/${t("en", "common:common.actions.close")}`);
    await backButton.click();
    await openByPath("en", path);
  });

  it("the toolbar and tool panels are in English", async () => {
    await activateTool("en", "tools-pages:tools-pages.toolbar.label");
    const panelTitle = await $(`h2=${t("en", "tools-pages:tools-pages.panel.title")}`);
    await panelTitle.waitForExist({ timeout: 10000 });
  });

  it("search still works in English", async () => {
    const hits = await searchAndCountHits("Rubrica", "en");
    expect(hits).toBeGreaterThan(0);
    await closeSearch("en");
  });

  it("annotate is reachable and usable in English too", async () => {
    await activateTool("en", "tools-annotate:tools-annotate.toolbar.label");
    const selectMode = await $(`aria/${t("en", "tools-annotate:tools-annotate.toolbar.select")}`);
    await selectMode.waitForExist({ timeout: 10000 });
  });
});
