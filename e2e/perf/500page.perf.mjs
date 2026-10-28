// R8 deliverable 2: a performance pass against the 500-page fixture. NOT part of the default
// `pnpm e2e` suite (deliverable 1's 9 spec files) — this is exploratory measurement, not a
// pass/fail scenario, since neither CONTRACTS nor ARCHITECTURE.md states a numeric budget
// (ARCHITECTURE.md's own principle is qualitative: "instant or honest... the tile pipeline exists
// to make a 500-page document scroll like a small one"). Run explicitly:
//   RUBRICA_E2E_SPECS="./perf/500page.perf.mjs" pnpm e2e
//
// Opens `fixtures/500-page.pdf` by path (`openByPath`, exactly like every other spec in this
// suite) — NOT the Home screen's own "Documento de exemplo com 500 páginas" quick-launch button.
// That button (and its two siblings) turned out to be a real, previously-undetected bug: it opens
// a bare relative path ("demo-500-pages.pdf") that only the *mock* engine's own path-matching
// convention resolves (`ipc/mock/state.ts`'s `resolveDocKindFromPath` — any path containing
// "500"/"perf"/"form"/"text"). No such file is bundled as a Tauri resource or synthesized by any
// Rust command, so in the real app all three quick-launch buttons fail outright. See
// docs/BACKLOG.md.
//
// Measures, against the real engine (tile pipeline, real PDFium rendering — not the mock):
//   1. Cold-open latency: open the file -> first real tile actually painted (`naturalWidth > 0`,
//      not just an <img> with a src assigned — a `rubrica-tile://` request can still be in
//      flight).
//   2. Settle latency: cold-open -> the visible viewport's tiles have all painted.
//   3. Scroll responsiveness: five successive full-viewport PageDown scrolls, each timed from the
//      key press to every tile visible after that scroll having painted.
//   4. Peak working-set memory of the rubrica.exe process (via `tasklist`, since this is the one
//      measurement WebDriver itself can't give us — it's an OS-level process stat, not a page
//      metric) sampled after cold-open and again after the scroll pass.
//
// History: this script's first run never produced a number — it found that no tile ever loaded
// at all, for any document (the release-blocking "viewer never renders real page content" bug:
// the frontend spelled tile URLs as a literal `rubrica-tile://...`, which WebView2 has no handler
// for — Tauri only exposes a custom scheme as `http://<scheme>.localhost/...` on Windows). Fixed
// in src/ipc/protocolUrl.ts; e2e/specs/09-render.e2e.mjs now asserts real pixels arrive so the
// suite can't go green on broken images again. The tile selector below matches on the scheme
// NAME (`src*=`), not a `rubrica-tile://` prefix, because the real src is the
// `http://rubrica-tile.localhost/` form.
import { execSync } from "node:child_process";
import { openByPath } from "../lib/actions.mjs";
import { fixture } from "../lib/paths.mjs";

const LNG = "pt-PT";

function rubricaWorkingSetKB() {
  // `tasklist /FI` — findstr-free (avoids another shell dependency) parse of the CSV output.
  const out = execSync('tasklist /FI "IMAGENAME eq rubrica.exe" /FO CSV /NH', { encoding: "utf8" });
  const line = out.trim().split("\n")[0];
  if (!line || !line.includes("rubrica.exe")) return null;
  const cols = line.split('","').map((c) => c.replace(/"/g, ""));
  const memStr = cols[4]; // e.g. "45,231 K"
  if (!memStr) return null;
  return Number(memStr.replace(/[^0-9]/g, ""));
}

async function paintedTileCount() {
  return browser.execute(() => {
    const imgs = Array.from(document.querySelectorAll('img[src*="rubrica-tile"]'));
    return { total: imgs.length, painted: imgs.filter((img) => img.naturalWidth > 0).length };
  });
}

async function waitForAllPainted(label, timeout = 15000) {
  const start = Date.now();
  await browser.waitUntil(
    async () => {
      const { total, painted } = await paintedTileCount();
      return total > 0 && total === painted;
    },
    { timeout, interval: 100, timeoutMsg: `${label}: tiles never finished painting within ${timeout}ms` },
  );
  return Date.now() - start;
}

describe("performance: 500-page fixture (real engine)", () => {
  it("measures cold-open, settle, scroll, and memory", async () => {
    const report = {};

    const t0 = Date.now();
    await openByPath(LNG, fixture("500-page.pdf"));
    report.tabAppearedMs = Date.now() - t0;
    await browser.pause(3000);
    // First-tile latency: poll until at least one tile has actually painted.
    await browser.waitUntil(
      async () => (await paintedTileCount()).painted > 0,
      { timeout: 20000, interval: 50, timeoutMsg: "no tile painted within 20s of cold-open" },
    );
    report.firstTileMs = Date.now() - t0;

    // Settle latency: every tile the initial viewport requested has painted.
    report.settleMs = report.firstTileMs + (await waitForAllPainted("cold-open settle"));

    report.memAfterOpenKB = rubricaWorkingSetKB();

    // Scroll pass: five PageDowns, each timed to its own settle.
    report.scrollStepsMs = [];
    for (let i = 0; i < 5; i++) {
      const stepStart = Date.now();
      await browser.keys(["Escape"]); // no-op if nothing's open; keeps focus away from any stray control
      await browser.keys(["PageDown"]);
      const settleMs = await waitForAllPainted(`scroll step ${i + 1}`);
      report.scrollStepsMs.push(Date.now() - stepStart);
      void settleMs; // already folded into the step's own total above
    }

    report.memAfterScrollKB = rubricaWorkingSetKB();

    console.log("PERF REPORT:", JSON.stringify(report, null, 2));
  });
});
