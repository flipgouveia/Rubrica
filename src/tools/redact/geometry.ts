// Pure PDF-point <-> screen-pixel geometry for the redact tool's overlay, built on TOOL-API's
// real `PageViewport` (`toScreen`/`toDoc`) — deliberately NOT `src/tools/shared/coords.ts`'s
// simpler `PageViewport` (that one predates the real chrome and is a different shape; this tool
// is wired through the actual tool-registration API, see `src/chrome/TOOL-API.md`).
//
// `Rect`'s `(x, y)` is its PDF-space bottom-left corner (CONTRACTS convention, confirmed by
// `src/tools/shared/coords.ts`'s own header comment and by the viewer's own
// `SelectionOverlay.tsx`). Converting a rect to screen space means running its PDF-space
// top-left corner `(x, y + height)` through `viewport.toScreen`, then scaling width/height by
// `viewport.zoom` — exactly the recipe TOOL-API.md spells out.
import type { PageViewport } from "../../chrome/tool-api";
import type { Rect } from "../../ipc/bindings";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** `number | null` is pervasive across the IPC surface (CONTRACTS f64-as-null quirk) — treat absent as 0. */
function nz(value: number | null | undefined): number {
  return value ?? 0;
}

/** A PDF-space `Rect` (bottom-left origin) to a screen-space rect (top-left origin, CSS px). */
export function docRectToScreen(rect: Rect, viewport: PageViewport): ScreenRect {
  const x = nz(rect.x);
  const y = nz(rect.y);
  const width = nz(rect.width);
  const height = nz(rect.height);
  const topLeft = viewport.toScreen(x, y + height);
  return { x: topLeft.x, y: topLeft.y, width: width * viewport.zoom, height: height * viewport.zoom };
}

/** Inverse of `docRectToScreen`. */
export function screenRectToDoc(rect: ScreenRect, viewport: PageViewport): Rect {
  const topLeftDoc = viewport.toDoc(rect.x, rect.y);
  const width = rect.width / viewport.zoom;
  const height = rect.height / viewport.zoom;
  return { x: topLeftDoc.x, y: topLeftDoc.y - height, width, height };
}

/** The axis-aligned screen rect spanning two drag points — normalizes whichever corner the pointer started from (a fresh drag hasn't picked a direction yet). */
export function normalizeScreenRect(a: ScreenPoint, b: ScreenPoint): ScreenRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Below this screen-pixel size in either axis, a drag is treated as an accidental click, not a deliberate mark (mirrors `tools/annotate`'s identical `MIN_DRAG_PX` convention). */
export const MIN_DRAG_PX = 4;

export function isDragBigEnough(rect: ScreenRect): boolean {
  return rect.width >= MIN_DRAG_PX && rect.height >= MIN_DRAG_PX;
}

/** Keeps a drawn rect's bounds within the page's screen-space box — pointer capture lets a drag report coordinates past the SVG's own edge while the button stays held, so a mark drawn near the border shouldn't silently extend past the page. Best-effort: clamps position and caps width/height, never grows the rect. */
export function clampRectToPage(rect: ScreenRect, widthPx: number, heightPx: number): ScreenRect {
  const x = Math.min(Math.max(rect.x, 0), widthPx);
  const y = Math.min(Math.max(rect.y, 0), heightPx);
  const maxWidth = Math.max(0, widthPx - x);
  const maxHeight = Math.max(0, heightPx - y);
  return { x, y, width: Math.min(rect.width, maxWidth), height: Math.min(rect.height, maxHeight) };
}
