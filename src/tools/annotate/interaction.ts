// Screen-space hit-testing and resize-handle math for the annotation
// overlay. This is tool-internal geometry that `src/tools/shared/coords.ts`
// (read-only, R1-owned) doesn't provide and isn't generic enough to belong
// there — kept inside `annotate/` per the brief's guidance for new shared
// helpers a tool discovers it needs.
import type { Annot, ShapeKind } from "../../ipc/bindings";
import { getAnnotBBox, isAnnotResizable } from "./geometry";
import type { PageViewport, ScreenRect } from "../shared/coords";
import { pdfRectToScreen } from "../shared/coords";

export interface ScreenPointLike {
  x: number;
  y: number;
}

export function pointInRect(point: ScreenPointLike, rect: ScreenRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * Topmost annotation whose screen bbox contains `point`, or `null`. "Topmost"
 * is last-in-list (annotations render in list order, so the last one drawn
 * is visually on top) — a small, deliberately generous grace margin (screen
 * pixels) makes thin annotations (a single-stroke ink line, an underline)
 * easier to click without needing pixel-perfect precision.
 */
export function hitTestAnnotations(annotations: readonly Annot[], point: ScreenPointLike, viewport: PageViewport, margin = 4): Annot | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const annot = annotations[i];
    const screenRect = pdfRectToScreen(getAnnotBBox(annot), viewport);
    const grown: ScreenRect = {
      x: screenRect.x - margin,
      y: screenRect.y - margin,
      width: screenRect.width + margin * 2,
      height: screenRect.height + margin * 2,
    };
    if (pointInRect(point, grown)) return annot;
  }
  return null;
}

/** Corner + edge-midpoint resize handles for rect-like annotations. */
export type BoxHandleId = "nw" | "n" | "ne" | "w" | "e" | "sw" | "s" | "se";
/** The two endpoint handles for `shape: line | arrow`, per the bottom-left-to-top-right rect convention documented in `AnnotationLayer.tsx`. */
export type LineHandleId = "start" | "end";
export type HandleId = BoxHandleId | LineHandleId;

export interface Handle {
  id: HandleId;
  point: ScreenPointLike;
}

const BOX_HANDLE_IDS: BoxHandleId[] = ["nw", "n", "ne", "w", "e", "sw", "s", "se"];

function boxHandlePoint(id: BoxHandleId, rect: ScreenRect): ScreenPointLike {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  switch (id) {
    case "nw":
      return { x: rect.x, y: rect.y };
    case "n":
      return { x: midX, y: rect.y };
    case "ne":
      return { x: right, y: rect.y };
    case "w":
      return { x: rect.x, y: midY };
    case "e":
      return { x: right, y: midY };
    case "sw":
      return { x: rect.x, y: bottom };
    case "s":
      return { x: midX, y: bottom };
    case "se":
      return { x: right, y: bottom };
  }
}

/** Whether `kind`'s handles are the 2-endpoint line convention rather than the 8-point box convention. */
export function isLineLikeShape(kind: ShapeKind): boolean {
  return kind === "line" || kind === "arrow";
}

/**
 * Resize handles for a given screen rect — the shared implementation behind
 * `getResizeHandles` below. Split out so a live drag preview (a rect that
 * doesn't correspond to any annotation's *stored* geometry yet) can recompute
 * handle positions against the CURRENT dragged rect, not go stale against the
 * pre-drag one.
 */
export function handlesForScreenRect(rect: ScreenRect, lineLike: boolean): Handle[] {
  if (lineLike) {
    return [
      { id: "start", point: { x: rect.x, y: rect.y + rect.height } },
      { id: "end", point: { x: rect.x + rect.width, y: rect.y } },
    ];
  }
  return BOX_HANDLE_IDS.map((id) => ({ id, point: boxHandlePoint(id, rect) }));
}

/**
 * Resize handles for `annot`'s current (non-dragging) screen bbox, or `[]`
 * for a non-resizable kind (`note`). `line`/`arrow` shapes get just their two
 * endpoints (bottom-left/top-right of the bbox, matching the rendering
 * convention) instead of all 8 box handles, since only those two points have
 * an unambiguous meaning for a shape with no independent width/height axes.
 */
export function getResizeHandles(annot: Annot, viewport: PageViewport): Handle[] {
  if (!isAnnotResizable(annot)) return [];
  const rect = pdfRectToScreen(getAnnotBBox(annot), viewport);
  const lineLike = annot.kind === "shape" && isLineLikeShape(annot.shape);
  return handlesForScreenRect(rect, lineLike);
}

/** Nearest handle to `point` within `radius` screen pixels, or `null`. Used at pointer-down to decide whether the user grabbed a handle rather than the annotation body. */
export function findHandleAtPoint(handles: readonly Handle[], point: ScreenPointLike, radius = 7): Handle | null {
  let best: Handle | null = null;
  let bestDistance = radius;
  for (const handle of handles) {
    const dx = handle.point.x - point.x;
    const dy = handle.point.y - point.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  }
  return best;
}

/** Maps a `line`/`arrow` endpoint handle onto the equivalent box corner for `resizeScreenRect` — "start" (bottom-left) behaves exactly like dragging a box's "sw" corner, "end" (top-right) like "ne". */
export function resizeHandleToBoxHandle(handle: HandleId): BoxHandleId {
  if (handle === "start") return "sw";
  if (handle === "end") return "ne";
  return handle;
}

/** Suggested CSS cursor for a handle, purely cosmetic. */
export function cursorForHandle(handle: HandleId): string {
  const box = resizeHandleToBoxHandle(handle);
  const cursors: Record<BoxHandleId, string> = {
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
  };
  return cursors[box];
}

/**
 * Applies a drag of resize handle `handle` (originally at some point, now
 * under the pointer at `pointer`) to `original`, returning the new screen
 * rect. Dragging a corner/edge past its opposite anchor flips it rather than
 * collapsing to zero (`Math.min`/`Math.max` normalize which side is which),
 * matching ordinary resize-handle UX elsewhere (e.g. any raster editor).
 */
export function resizeScreenRect(original: ScreenRect, handle: BoxHandleId, pointer: ScreenPointLike): ScreenRect {
  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;
  if (handle.includes("w")) left = pointer.x;
  if (handle.includes("e")) right = pointer.x;
  if (handle.includes("n")) top = pointer.y;
  if (handle.includes("s")) bottom = pointer.y;
  const x = Math.min(left, right);
  const x2 = Math.max(left, right);
  const y = Math.min(top, bottom);
  const y2 = Math.max(top, bottom);
  return { x, y, width: x2 - x, height: y2 - y };
}

/** Translates a screen rect by a screen-space delta (used for move-drag). */
export function translateScreenRect(rect: ScreenRect, dx: number, dy: number): ScreenRect {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

/** The axis-aligned screen rect spanning two drag points (a fresh shape/freeText/selection drag hasn't picked a direction yet, so this normalizes whichever corner the pointer started from). */
export function normalizeScreenRect(a: ScreenPointLike, b: ScreenPointLike): ScreenRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Keeps a moved/resized rect's top-left within the page's screen bounds (best-effort — doesn't shrink the rect, just repositions it). */
export function clampRectToPage(rect: ScreenRect, viewport: PageViewport): ScreenRect {
  const maxX = Math.max(0, viewport.pageWidthPt * viewport.scale - rect.width);
  const maxY = Math.max(0, viewport.pageHeightPt * viewport.scale - rect.height);
  return { ...rect, x: Math.min(Math.max(rect.x, 0), maxX), y: Math.min(Math.max(rect.y, 0), maxY) };
}
