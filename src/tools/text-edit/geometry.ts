// PDF-point <-> screen-pixel rect conversion for the text-edit tool.
//
// This tool is wired through `registerTool` (TOOL-API.md), so its overlay
// receives the REAL `PageViewport` from `src/chrome/tool-api.tsx`
// (`toScreen`/`toDoc`, continuous `zoom`) — a different, simpler shape than
// `src/tools/shared/coords.ts`'s own `PageViewport` (built for annotate/
// forms, which predate the registry and aren't wired through it). `nz()` is
// still borrowed from `coords.ts`: the `number | null` quirk it guards
// against (CONTRACTS' f64-as-null convention on every `Rect` field) is
// identical either way, and so is the plain `{x,y,width,height}` shape of
// `ScreenRect`/`ScreenPoint` — reusing those two types isn't an assumption
// about the OTHER PageViewport, just about screen-space rectangles in
// general.
import type { PageViewport } from "../../chrome/tool-api";
import type { Rect } from "../../ipc/bindings";
import { nz, type ScreenPoint, type ScreenRect } from "../shared/coords";

/** Below this many CSS pixels of drag distance, a pointer-down+up is treated as a click (place a default-size object), not a drag (size it explicitly). Mirrors annotate's own `MIN_DRAG_PX`. */
export const DRAG_THRESHOLD_PX = 4;

/**
 * `rect`'s `(x, y)` is its PDF-space lower-left corner (y-up); the returned
 * screen rect's `(x, y)` is CSS's top-left corner (y-down) — converting a
 * whole rect means running its PDF-space TOP-left corner, `(x, y +
 * height)`, through `toScreen` (see TOOL-API.md), then scaling width/height
 * by `viewport.zoom`.
 */
export function rectToScreen(rect: Rect, viewport: PageViewport): ScreenRect {
  const topLeft = viewport.toScreen(nz(rect.x), nz(rect.y) + nz(rect.height));
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: nz(rect.width) * viewport.zoom,
    height: nz(rect.height) * viewport.zoom,
  };
}

/** Inverse of `rectToScreen`. */
export function screenRectToPdfRect(rect: ScreenRect, viewport: PageViewport): Rect {
  const bottomLeft = viewport.toDoc(rect.x, rect.y + rect.height);
  return {
    x: bottomLeft.x,
    y: bottomLeft.y,
    width: rect.width / viewport.zoom,
    height: rect.height / viewport.zoom,
  };
}

/** Normalizes two arbitrary drag corners (in either order) into a positive-size screen rect. */
export function dragRectFromPoints(a: ScreenPoint, b: ScreenPoint): ScreenRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** A fixed-size (PDF points, scaled by `zoom`) screen rect anchored with `point` as its top-left corner — the "clicked, didn't drag" placement shared by add-text and add-image modes. */
export function defaultRectAt(point: ScreenPoint, sizePt: { width: number; height: number }, zoom: number): ScreenRect {
  return { x: point.x, y: point.y, width: sizePt.width * zoom, height: sizePt.height * zoom };
}

/** Straight-line distance between two screen points — used to decide click-vs-drag against `DRAG_THRESHOLD_PX`. */
export function screenDistance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Keeps a screen rect fully within a `pageWidthPx` x `pageHeightPx` page, shrinking it first if it's larger than the page itself rather than letting the clamp push its origin negative. */
export function clampScreenRectToPage(rect: ScreenRect, pageWidthPx: number, pageHeightPx: number): ScreenRect {
  const width = Math.min(rect.width, Math.max(pageWidthPx, 0));
  const height = Math.min(rect.height, Math.max(pageHeightPx, 0));
  const x = Math.min(Math.max(rect.x, 0), pageWidthPx - width);
  const y = Math.min(Math.max(rect.y, 0), pageHeightPx - height);
  return { x, y, width, height };
}
