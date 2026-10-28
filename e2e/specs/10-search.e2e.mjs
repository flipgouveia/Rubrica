// Search v2 on the real engine (agents/SEARCH-ORCHESTRATION.md §2.5): proximity finds the known zone
// of fixtures/book.pdf, the chapter scope limits results, excluding headers/footers drops the
// "Página N de 40" footers, "acao" finds "ação", and the density map appears. Ground truth:
// fixtures/book.expected.json (tight trio on p. 17 ≈ 125 chars, loose trio on p. 30 ≈ 386 chars).
//
// Search options are app-wide preferences persisted in the real %APPDATA%\Rubrica\rubrica.db, so
// `after` puts every one of them back to its default — otherwise the next run (and every other
// spec that searches) would start in proximity mode with headers/footers excluded.
import { t } from "../lib/i18n.mjs";
import { openByPath } from "../lib/actions.mjs";
import { fixture } from "../lib/paths.mjs";
import { closeSearch } from "../lib/search.mjs";

const LNG = "pt-PT";
const tv = (key, options) => t(LNG, `viewer:viewer.search.${key}`, options);

async function count() {
  const el = await $('[data-testid="search-panel"] [data-testid="search-count"]');
  if (!(await el.isExisting())) return null;
  return {
    total: Number(await el.getAttribute("data-total")),
    done: (await el.getAttribute("data-done")) === "true",
    query: await el.getAttribute("data-query"),
  };
}

/** Waits until the search for `query` is done and its total is stable; returns the total. */
async function settledTotal(query) {
  let last = -1;
  const result = await browser.waitUntil(
    async () => {
      const state = await count();
      if (!state || state.query !== query || !state.done) {
        last = -1;
        return false;
      }
      const stable = state.total === last;
      last = state.total;
      return stable ? { total: state.total } : false;
    },
    { timeout: 20000, interval: 400, timeoutMsg: `search for "${query}" never settled` },
  );
  return result.total;
}

async function input() {
  const el = await $('[data-testid="search-panel"] [data-testid="search-input"]');
  await el.waitForExist({ timeout: 5000 });
  return el;
}

async function search(query) {
  const el = await input();
  await el.setValue(query);
  return settledTotal(query);
}

/** After an option change the same query re-runs: wait for it to start over, then settle. */
async function rerun(query, change) {
  await change();
  await browser.pause(400); // > the 250 ms debounce, so `done` below belongs to the new run
  return settledTotal(query);
}

async function clickButton(label) {
  const button = await $(`button=${label}`);
  await button.waitForClickable({ timeout: 5000 });
  await button.click();
}

async function setSwitch(label, on) {
  const toggle = await $(`label*=${label}`);
  const box = await toggle.$("input");
  if ((await box.isSelected()) !== on) await toggle.click();
}

describe("search v2 on book.pdf (real engine)", () => {
  after(async () => {
    if (await (await $('[data-testid="search-panel"]')).isExisting()) {
      await clickButton(tv("modePhrase"));
      await setSwitch(tv("ignoreDiacritics"), true);
      await setSwitch(tv("excludeHeadersFooters"), false);
    }
    await closeSearch(LNG);
  });

  it("opens book.pdf and the docked search panel", async () => {
    await openByPath(LNG, fixture("book.pdf"));
    await browser.keys(["Control", "Shift", "f"]);
    await input();
    await clickButton(tv("modePhrase"));
    await setSwitch(tv("ignoreDiacritics"), true);
    await setSwitch(tv("excludeHeadersFooters"), false);
  });

  it('"acao" finds "ação" with accents ignored, and nothing when they matter', async () => {
    expect(await search("acao")).toBeGreaterThan(0);
    expect(await rerun("acao", () => setSwitch(tv("ignoreDiacritics"), false))).toBe(0);
    await setSwitch(tv("ignoreDiacritics"), true);
  });

  it('excluding headers and footers drops the "Página N de 40" footers', async () => {
    expect(await search("Página")).toBeGreaterThanOrEqual(39);
    expect(await rerun("Página", () => setSwitch(tv("excludeHeadersFooters"), true))).toBe(0);
    await setSwitch(tv("excludeHeadersFooters"), false);
  });

  it("proximity finds the tight zone at 250 chars and both zones at 500", async () => {
    await clickButton(tv("modeProximity"));
    const query = "rescisão prazo indemnização";
    const el = await input();
    await el.setValue(query);
    await clickButton("250");
    expect(await settledTotal(query)).toBe(1);
    expect(await rerun(query, () => clickButton("500"))).toBe(2);
  });

  it("shows the density map for the results", async () => {
    const map = await $('[data-testid="density-map"]');
    await map.waitForExist({ timeout: 5000 });
    expect(await map.getAttribute("role")).toBe("img");
    expect((await map.getAttribute("aria-label")).length).toBeGreaterThan(0);
  });

  it('the chapter scope "3 Cessação do contrato" keeps only the zone inside it', async () => {
    const query = "rescisão prazo indemnização";
    const total = await rerun(query, async () => {
      await (await $('[data-testid="search-scope"]')).click();
      const tree = await $('[data-testid="scope-tree"]');
      await tree.waitForExist({ timeout: 5000 });
      await (await tree.$("button*=3 Cessação do contrato")).click();
    });
    expect(total).toBe(1);
    // Back to the whole document for the specs that follow.
    await (await $('[data-testid="search-scope"]')).click();
    await (await $(`button*=${tv("scopeAll")}`)).click();
  });
});
