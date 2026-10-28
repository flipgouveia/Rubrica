// Bring-up smoke test (R8 SA-1's own "prove the harness works before building scenarios on top of
// it" step): does tauri-driver actually attach to the real Tauri/WebView2 window and can
// WebdriverIO see real DOM content through it? Nothing here touches the real engine yet — that's
// every other spec in this directory.
// `expect`/`$`/`$$`/`browser` are real globals injected by the wdio mocha framework at test-run
// time — no import needed (and no `@wdio/globals` package is installed; importing it here failed
// with ERR_MODULE_NOT_FOUND before this was fixed).
import { t } from "../lib/i18n.mjs";

describe("harness bring-up", () => {
  it("attaches to the real app window and sees the Home screen", async () => {
    const dropHint = await $(`p=${t("pt-PT", "screens:screens.home.dropHint")}`);
    await expect(dropHint).toBeExisting();
  });
});
