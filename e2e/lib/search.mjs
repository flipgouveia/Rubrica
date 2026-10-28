// Shared search helpers — used by the viewer scenario and the redact scenario's own
// before/after verification (search for the redacted term, confirm it's gone; search for
// something else, confirm search itself still works).
//
// The result list is virtualized, so the number of DOM nodes says nothing about the number of
// results: the total is read from the count label's `data-total` (and `data-done` says the
// search finished). `data-testid="search-panel"` is on the search root in both modes (compact bar
// and docked panel), and `data-query` on the count tells which query the numbers belong to.
import { t } from "./i18n.mjs";

export async function openSearch(lng = "pt-PT") {
  await browser.keys(["Control", "f"]);
  const input = await $(`input[placeholder="${t(lng, "viewer:viewer.search.placeholder")}"]`);
  await input.waitForExist({ timeout: 5000 });
  return input;
}

/** Reads `{ total, done, query }` from the search count label, or null when it is not on screen. */
async function readCount() {
  const count = await $('[data-testid="search-panel"] [data-testid="search-count"]');
  if (!(await count.isExisting())) return null;
  return {
    total: Number(await count.getAttribute("data-total")),
    done: (await count.getAttribute("data-done")) === "true",
    query: await count.getAttribute("data-query"),
  };
}

/** Types `query` into (an already-open) search box and waits for the debounced search + streamed results to finish, returning the number of hits found (one per occurrence, not per rectangle). `lng` must match the app's CURRENT UI language (a real bug: this used to hardcode "pt-PT" here, which broke the moment the i18n-smoke spec switched the app to English — the placeholder text this looks for stopped matching). */
export async function searchAndCountHits(query, lng = "pt-PT") {
  const input = await openSearch(lng);
  await input.setValue(query);
  // 250ms debounce (searchController.ts) + streaming results. Done means the engine said so
  // (`data-done`) for THIS query (`data-query`), and the total stopped changing between polls.
  let lastTotal = -1;
  let stableTicks = 0;
  const settled = await browser.waitUntil(
    async () => {
      const state = await readCount();
      if (!state || state.query !== query || !state.done) {
        stableTicks = 0;
        lastTotal = -1;
        return false;
      }
      if (state.total === lastTotal) stableTicks++;
      else stableTicks = 0;
      lastTotal = state.total;
      return stableTicks >= 1 ? { total: state.total } : false; // an object: a total of 0 must not read as "keep waiting"
    },
    { timeout: 15000, interval: 400, timeoutMsg: `search for "${query}" never finished` },
  );
  return settled.total;
}

export async function closeSearch() {
  const closeButton = await $('[data-testid="search-panel"] [data-testid="search-close"]');
  if (await closeButton.isExisting()) await closeButton.click();
}
