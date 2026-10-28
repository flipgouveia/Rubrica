// Mock tile/thumbnail rendering (CONTRACTS §5).
//
// The real backend serves PNG bytes over the `rubrica-tile://` /
// `rubrica-thumb://` custom protocols (CONTRACTS §3), which don't exist in
// a plain browser. These two functions are the mock's drop-in replacement:
// they draw a placeholder to an offscreen <canvas> and return a
// `data:image/png;base64,...` URL an `<img src=...>` can use directly.
//
// Seam for wave-1 viewer code: construct a real `rubrica-tile://...` URL
// string when running for real, or call `mockTileUrl`/`mockThumbUrl` when
// `import.meta.env.VITE_MOCK_ENGINE === '1'` or outside Tauri — i.e.
// wherever `src/ipc/index.ts` resolves to the mock `commands`/`events`.
//
// Both functions are synchronous (canvas.toDataURL() is synchronous) and
// pure with respect to their arguments — calling them again with the same
// arguments (importantly, the same `revision`) redraws identical pixels, so
// callers can safely use the returned URL as an `<img>` `key`/`src` and
// expect a new URL (and therefore a visible redraw) exactly when revision
// changes.
import { colors } from "../../tokens/tokens";

const TILE_SIZE = 512;
const THUMB_WIDTH = 160;
const THUMB_ASPECT = 792 / 612; // US Letter, matches the mock text/form documents.

function drawPlaceholder(width: number, height: number, lines: string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const palette = colors.light;
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = Math.max(2, Math.round(width / 128));
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth);

  ctx.fillStyle = palette.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fontSize = Math.max(11, Math.round(width / 18));
  ctx.font = `${fontSize}px "Instrument Sans", ui-sans-serif, system-ui, sans-serif`;
  const lineHeight = Math.round(fontSize * 1.4);
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, startY + i * lineHeight);
  });

  return canvas.toDataURL("image/png");
}

/**
 * Placeholder tile for `rubrica-tile://<docId>/<page>/<zoomBucket>/<x>/<y>?rev=<revision>`.
 * Draws docId, 1-based page number, zoom bucket, tile coordinate, and
 * revision as visible text so a revision bump is visually obvious on
 * redraw. `page`/`x`/`y` are 0-based, matching the real protocol.
 */
export function mockTileUrl(docId: string, page: number, zoomBucket: number, x: number, y: number, revision: number): string {
  return drawPlaceholder(TILE_SIZE, TILE_SIZE, [
    docId,
    `page ${page + 1}`,
    `zoom ${zoomBucket}x`,
    `tile (${x}, ${y})`,
    `rev ${revision}`,
  ]);
}

/** Placeholder thumbnail for `rubrica-thumb://<docId>/<page>?rev=<revision>`, fit to 160px wide. */
export function mockThumbUrl(docId: string, page: number, revision: number): string {
  const height = Math.round(THUMB_WIDTH * THUMB_ASPECT);
  return drawPlaceholder(THUMB_WIDTH, height, [docId, `p.${page + 1}`, `r${revision}`]);
}

// Async variants with deliberate synthetic latency (R3 brief: "smooth 500-page behavior against
// the mock's synthetic latency"). The real `rubrica-tile://`/`rubrica-thumb://` protocols are
// inherently async (network-shaped custom-protocol round trip through the webview) — the
// synchronous functions above return instantly, which would let the viewer "cheat" past the
// windowing/prefetch logic it actually needs against a real engine. These add a small delay and
// a tiny cache (so re-requesting the same already-resolved key, e.g. scrolling back to a page,
// doesn't re-pay the delay) — everything the viewer should be built against.
const TILE_LATENCY_MS = 16;
const resolvedUrlCache = new Map<string, string>();

function cacheKey(prefix: string, parts: (string | number)[]): string {
  return `${prefix}:${parts.join(":")}`;
}

async function withLatency<T>(key: string, compute: () => T): Promise<T> {
  const cached = resolvedUrlCache.get(key);
  if (cached !== undefined) return cached as T;
  await new Promise<void>((resolve) => setTimeout(resolve, TILE_LATENCY_MS));
  const value = compute();
  resolvedUrlCache.set(key, value as string);
  return value;
}

export function mockTileUrlAsync(docId: string, page: number, zoomBucket: number, x: number, y: number, revision: number): Promise<string> {
  return withLatency(cacheKey("tile", [docId, page, zoomBucket, x, y, revision]), () => mockTileUrl(docId, page, zoomBucket, x, y, revision));
}

export function mockThumbUrlAsync(docId: string, page: number, revision: number): Promise<string> {
  return withLatency(cacheKey("thumb", [docId, page, revision]), () => mockThumbUrl(docId, page, revision));
}
