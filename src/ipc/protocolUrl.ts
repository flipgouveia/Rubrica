// Builds the real-engine `<img src>` URLs for CONTRACTS §3's two render protocols. This is the ONE
// place that knows what a custom Tauri scheme looks like from inside the webview — every
// real-engine tile/thumbnail call site (viewer/Tile.tsx, chrome/Thumbnail.tsx,
// tools/pages/PagesPanel.tsx) goes through here, and none of them may spell out a scheme string.
//
// Why this exists (the release-blocking bug R8 found — see docs/BACKLOG.md): CONTRACTS writes the
// protocols as `rubrica-tile://<docId>/...`, and the first three call sites used exactly that
// string as their `<img src>`. But a Tauri custom scheme is NOT reachable under its own name on
// every platform. Per `tauri::Builder::register_uri_scheme_protocol`'s own docs, the page sees:
//   - Windows / Android:   http://<scheme>.localhost/<path>   (WebView2 can't register a real
//                           `rubrica-tile:` scheme handler, so Tauri maps the scheme onto a
//                           WebResourceRequested filter for this synthetic http host instead)
//   - macOS / iOS / Linux: <scheme>://localhost/<path>
// Nothing rewrites a literal `rubrica-tile://...` into that form on the way out. WebView2 simply
// has no handler for it: the request never leaves the webview, Rust's `handle_tile_request` is
// never called, and the `<img>` shows the browser's broken-image icon — exactly what R8's
// PrintWindow screenshots showed at every tile position.
//
// Rather than re-deriving that platform table here (and drifting the day Tauri changes it — its
// `use_https_scheme` option, for one, flips the `http` prefix to `https`), the base is asked from
// Tauri's own `convertFileSrc(filePath, protocol)`, which IS that table. Called with an EMPTY path
// it returns exactly the origin plus a trailing slash (`http://rubrica-tile.localhost/`), and the
// path segments are appended verbatim. Passing the full path through `convertFileSrc` instead
// would `encodeURIComponent` it — every `/` becomes `%2F`, `?rev=` becomes `%3Frev%3D` — and the
// Rust side's `path_segments`/`revision_from_query` (protocols.rs) would never split it apart.
import { convertFileSrc } from "@tauri-apps/api/core";

export type RenderScheme = "rubrica-tile" | "rubrica-thumb" | "rubrica-print";

/**
 * The platform-correct origin for one of the render protocols, always ending in `/`. Only valid
 * inside Tauri (`convertFileSrc` reaches into `window.__TAURI_INTERNALS__`, which Tauri's init
 * script injects) — the mock engine never calls this; see ipc/index.ts's `isMockEngine`.
 */
export function renderProtocolBase(scheme: RenderScheme): string {
  const base = convertFileSrc("", scheme);
  return base.endsWith("/") ? base : `${base}/`;
}

/** `rubrica-tile://<docId>/<page>/<zoomBucket>/<x>/<y>?rev=<revision>` (CONTRACTS §3), in the form this platform's webview actually routes to `protocols.rs`. */
export function realTileUrl(docId: string, page: number, bucket: number, x: number, y: number, revision: number): string {
  return `${renderProtocolBase("rubrica-tile")}${docId}/${page}/${bucket}/${x}/${y}?rev=${revision}`;
}

/** `rubrica-thumb://<docId>/<page>?rev=<revision>` (CONTRACTS §3), likewise. */
export function realThumbUrl(docId: string, page: number, revision: number): string {
  return `${renderProtocolBase("rubrica-thumb")}${docId}/${page}?rev=${revision}`;
}

/** `rubrica-print://<docId>/<page>/<dpi>` (CONTRACTS §3), likewise: a page `print_render` already rendered at that DPI (`page` is 0-based). */
export function realPrintUrl(docId: string, page: number, dpi: number): string {
  return `${renderProtocolBase("rubrica-print")}${docId}/${page}/${dpi}`;
}
