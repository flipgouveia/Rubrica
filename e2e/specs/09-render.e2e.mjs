// The one kind of assertion no other spec in this suite makes: that real PIXELS arrive. Every
// other spec is DOM-structural, CSS/layout-derived, or interaction-state-based — which is exactly
// how the app shipped through 8 waves plus this suite's first 9 specs (all green) while the main
// viewer showed nothing but the browser's broken-image icon at every tile position (see
// docs/BACKLOG.md's resolved "viewer may never render real page content" entry, and
// src/ipc/protocolUrl.ts for the root cause: tile URLs were spelled as a literal
// `rubrica-tile://...`, which WebView2 has no handler for — Tauri only exposes a custom scheme as
// `http://<scheme>.localhost/...` on Windows). This spec is what would have caught it.
//
// Three layers, each a distinct failure mode the others can't see:
//   1. `naturalWidth/Height > 0` on the live `<img>`s: the protocol handler was reached and
//      returned bytes the browser could decode. (An assigned `src` alone proves nothing — that's
//      what the old broken state looked like.)
//   2. The `src` is the platform form Tauri routes (`http://rubrica-tile.localhost/...`), not the
//      CONTRACTS spelling. Windows-only assertion, like the rest of this suite (Rubrica ships
//      Windows-only — docs/ARCHITECTURE.md); the unit test in src/ipc/protocolUrl.test.ts covers
//      the non-Windows branch.
//   3. Actual ink: fetch a tile the viewer is showing, decode it, and count non-white pixels — a
//      handler that returned a valid but blank 512×512 PNG (a PDFium regression, a wrong page
//      index, a zero-size render) passes 1 and 2 and fails here. Needs the
//      `Access-Control-Allow-Origin` header protocols.rs sends (the page and the protocol are
//      different origins).
import { activateTool, openByPath } from "../lib/actions.mjs";
import { fixture } from "../lib/paths.mjs";

const LNG = "pt-PT";
const path = fixture("text.pdf");

// Match on the scheme NAME, not a `rubrica-tile://` prefix — the real src is the
// `http://rubrica-tile.localhost/` form (see header), and the transparent-pixel placeholder
// Tile.tsx shows before a src is assigned is a `data:` URL that must not count.
const TILE_SELECTOR = 'img[src*="rubrica-tile"]';
const THUMB_SELECTOR = 'img[src*="rubrica-thumb"]';
const TILE_SIZE = 512; // engine::tiles::TILE_SIZE (CONTRACTS §3)
const THUMB_MAX = 160; // engine::tiles::THUMB_MAX (CONTRACTS §3: "fit 160px")

/** Snapshot of every protocol `<img>` matching `selector`: how many exist, how many have actually decoded, and their srcs. */
async function imageState(selector) {
  return browser.execute((sel) => {
    const imgs = Array.from(document.querySelectorAll(sel));
    return {
      total: imgs.length,
      painted: imgs.filter((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0).length,
      srcs: imgs.map((img) => img.src),
      sizes: imgs.map((img) => [img.naturalWidth, img.naturalHeight]),
    };
  }, selector);
}

/** Waits until at least one `selector` image exists AND every one of them has decoded, then returns the final snapshot. */
async function waitForAllPainted(selector, label, timeout = 30000) {
  let last = { total: 0, painted: 0, srcs: [], sizes: [] };
  await browser.waitUntil(
    async () => {
      last = await imageState(selector);
      return last.total > 0 && last.painted === last.total;
    },
    { timeout, interval: 100, timeoutMsg: `${label}: images never all painted within ${timeout}ms` },
  );
  return last;
}

/**
 * Fetches one protocol URL from inside the page, decodes it, and measures how much of it is ink
 * (any pixel that is opaque and not near-white). Runs in the webview because that's the only
 * place the `http://*.localhost` protocol hosts resolve — Node can't reach them (the routing is a
 * WebView2 WebResourceRequested filter, not a real network listener).
 */
async function inspectImage(url) {
  return browser.execute(async (src) => {
    const res = await fetch(src);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const contentType = res.headers.get("content-type");
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0 && (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)) ink++;
    }
    return { contentType, width: bitmap.width, height: bitmap.height, inkFraction: ink / (data.length / 4) };
  }, url);
}

describe("render: the viewer and thumbnails show real page content", () => {
  let tiles;

  it("opens text.pdf and every visible tile actually decodes (naturalWidth > 0)", async () => {
    await openByPath(LNG, path);
    tiles = await waitForAllPainted(TILE_SELECTOR, "viewer tiles");
    expect(tiles.total).toBeGreaterThan(0);
    expect(tiles.painted).toBe(tiles.total);
  });

  it("requests tiles in the form Tauri actually routes on Windows, never a literal rubrica-tile:// URL", async () => {
    for (const src of tiles.srcs) {
      expect(src).toMatch(/^http:\/\/rubrica-tile\.localhost\/doc-\d+\/\d+\/[\d.]+\/\d+\/\d+\?rev=\d+$/);
    }
  });

  it("serves 512×512 PNG tiles and at least one of them carries real ink from the page", async () => {
    const results = [];
    for (const src of tiles.srcs) results.push(await inspectImage(src));
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.contentType).toBe("image/png");
      expect([r.width, r.height]).toEqual([TILE_SIZE, TILE_SIZE]);
    }
    // text.pdf's first page is body text from its top margin down (fixtures/README.md), so among
    // its visible tiles at least one must be visibly non-blank. Threshold is deliberately low:
    // this guards against "a blank white PNG", not against any particular glyph density.
    const maxInk = Math.max(...results.map((r) => r.inkFraction));
    expect(maxInk).toBeGreaterThan(0.002);
  });

  it("rail thumbnails decode too, fit to 160px, and show the page rather than a blank rectangle", async () => {
    const thumbs = await waitForAllPainted(THUMB_SELECTOR, "rail thumbnails");
    expect(thumbs.total).toBeGreaterThan(0);
    for (const src of thumbs.srcs) expect(src).toMatch(/^http:\/\/rubrica-thumb\.localhost\/doc-\d+\/\d+\?rev=\d+$/);
    for (const [w, h] of thumbs.sizes) expect(Math.max(w, h)).toBe(THUMB_MAX);
    const first = await inspectImage(thumbs.srcs[0]);
    expect(first.error).toBeUndefined();
    expect(first.contentType).toBe("image/png");
    expect(first.inkFraction).toBeGreaterThan(0.002);
  });

  it("print_render's pages decode through the rubrica-print protocol (the print preview's images)", async () => {
    // Same failure mode as the tiles: the print window's <img>s used `convertFileSrc(path)` (the
    // never-enabled asset protocol) and showed the broken-image icon. Opening the real print
    // dialog would block this session on a native window, so drive the two halves directly: the
    // IPC command, then an <img> on the protocol URL the print window builds.
    const docId = /\/(doc-\d+)\//.exec(tiles.srcs[0])[1];
    const state = await browser.executeAsync(async (id, done) => {
      const rendered = await window.__TAURI_INTERNALS__.invoke("print_render", { docId: id, pages: [0], dpi: 150 });
      const img = new Image();
      img.src = `http://rubrica-print.localhost/${id}/0/150`;
      try {
        await img.decode();
      } catch {
        // fall through: naturalWidth stays 0 and the assertion below reports it
      }
      done({ rendered: rendered.length, width: img.naturalWidth, height: img.naturalHeight });
    }, docId);
    expect(state.rendered).toBe(1);
    expect(state.width).toBeGreaterThan(0);
    expect(state.height).toBeGreaterThan(0);
    const page = await inspectImage(`http://rubrica-print.localhost/${docId}/0/150`);
    expect(page.error).toBeUndefined();
    expect(page.contentType).toBe("image/png");
    expect(page.inkFraction).toBeGreaterThan(0.002);
  });

  it("the Pages tool's own thumbnails (a separate URL call site) decode as well", async () => {
    const before = (await imageState(THUMB_SELECTOR)).total;
    await activateTool(LNG, "tools-pages:tools-pages.toolbar.label");
    await browser.waitUntil(async () => (await imageState(THUMB_SELECTOR)).total > before, {
      timeout: 10000,
      timeoutMsg: "activating the Pages tool never added its panel thumbnails",
    });
    const thumbs = await waitForAllPainted(THUMB_SELECTOR, "pages-panel thumbnails");
    expect(thumbs.painted).toBe(thumbs.total);
  });
});
