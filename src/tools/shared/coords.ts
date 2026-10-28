// Shared PDF-space <-> screen-space geometry for every editing tool overlay
// (annotate, forms; pages works on thumbnails and doesn't need this).
//
// PDF coordinate convention confirmed from the mock fixtures (see
// `src/ipc/mock/state.ts`'s form fields and `DemoRoute.tsx`'s highlight):
// `Rect { x, y, width, height }` has `(x, y)` at the LOWER-LEFT corner, y
// increasing upward, matching the PDF spec's own rectangle arrays. Same for
// `QuadPoint`: corners are ordered (x1,y1)=top-left, (x2,y2)=top-right,
// (x3,y3)=bottom-left, (x4,y4)=bottom-right (the PDF spec's own — famously
// unintuitive — QuadPoints order), and y1 === y2 (top edge) > y3 === y4
// (bottom edge) for an unrotated quad.
//
// A `PageViewport`'s `pageWidthPt`/`pageHeightPt` are the page's DISPLAY
// size in PDF points — i.e. `DocInfo.pages[n]`, which the engine (real and
// mock) already reports post-rotation (width/height swapped at 90/270, see
// `mock/state.ts::getDocInfo`). Tools therefore never need to reason about
// rotation themselves: a page rotated 90 degrees just has a wider-than-tall
// `pageWidthPt`/`pageHeightPt`, and all annotation/field rects for that page
// are assumed to already be expressed in that same display space. Whether
// the real PDFium engine needs a pre-rotation content-space transform on top
// of this is a wave-2 (R5) engine concern, not a tool-UI concern — flagged
// in the wave-1 report.
import type { Point, QuadPoint, Rect } from "../../ipc/bindings";

export interface PageViewport {
  /** Page display width in PDF points (post-rotation), e.g. `DocInfo.pages[n].width`. */
  pageWidthPt: number;
  /** Page display height in PDF points (post-rotation). */
  pageHeightPt: number;
  /** Screen pixels per PDF point. */
  scale: number;
}

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
export function nz(value: number | null | undefined): number {
  return value ?? 0;
}

export function pdfPointToScreen(point: { x: number | null; y: number | null }, viewport: PageViewport): ScreenPoint {
  return {
    x: nz(point.x) * viewport.scale,
    y: (viewport.pageHeightPt - nz(point.y)) * viewport.scale,
  };
}

export function screenPointToPdf(point: ScreenPoint, viewport: PageViewport): { x: number; y: number } {
  return {
    x: point.x / viewport.scale,
    y: viewport.pageHeightPt - point.y / viewport.scale,
  };
}

/** `rect`'s `(x, y)` is its lower-left corner in PDF space; the returned screen rect's `(x, y)` is its top-left corner (CSS convention). */
export function pdfRectToScreen(rect: Rect, viewport: PageViewport): ScreenRect {
  const topLeftPdf = { x: nz(rect.x), y: nz(rect.y) + nz(rect.height) };
  const topLeft = pdfPointToScreen(topLeftPdf, viewport);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: nz(rect.width) * viewport.scale,
    height: nz(rect.height) * viewport.scale,
  };
}

/** Inverse of `pdfRectToScreen`: a screen rect with a top-left `(x, y)` back to a PDF `Rect` with a lower-left `(x, y)`. */
export function screenRectToPdf(rect: ScreenRect, viewport: PageViewport): Rect {
  const widthPt = rect.width / viewport.scale;
  const heightPt = rect.height / viewport.scale;
  const topLeftPdf = screenPointToPdf({ x: rect.x, y: rect.y }, viewport);
  return {
    x: topLeftPdf.x,
    y: topLeftPdf.y - heightPt,
    width: widthPt,
    height: heightPt,
  };
}

/** The four corners of a `QuadPoint`, mapped to screen space, in polygon-drawing order (TL, TR, BR, BL). */
export function quadToScreenPolygon(quad: QuadPoint, viewport: PageViewport): ScreenPoint[] {
  const tl = pdfPointToScreen({ x: quad.x1, y: quad.y1 }, viewport);
  const tr = pdfPointToScreen({ x: quad.x2, y: quad.y2 }, viewport);
  const bl = pdfPointToScreen({ x: quad.x3, y: quad.y3 }, viewport);
  const br = pdfPointToScreen({ x: quad.x4, y: quad.y4 }, viewport);
  return [tl, tr, br, bl];
}

export function screenPolygonToSvgPoints(points: ScreenPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/** Builds a `QuadPoint` from a screen-space rectangle (used by the markup tools when deriving quads from a text selection's boxes). */
export function screenRectToQuad(rect: ScreenRect, viewport: PageViewport): QuadPoint {
  const tl = screenPointToPdf({ x: rect.x, y: rect.y }, viewport);
  const tr = screenPointToPdf({ x: rect.x + rect.width, y: rect.y }, viewport);
  const bl = screenPointToPdf({ x: rect.x, y: rect.y + rect.height }, viewport);
  const br = screenPointToPdf({ x: rect.x + rect.width, y: rect.y + rect.height }, viewport);
  return { x1: tl.x, y1: tl.y, x2: tr.x, y2: tr.y, x3: bl.x, y3: bl.y, x4: br.x, y4: br.y };
}

export function pointsBBoxScreen(points: ScreenPoint[]): ScreenRect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function clampPointToPage(point: ScreenPoint, viewport: PageViewport): ScreenPoint {
  return {
    x: Math.min(Math.max(point.x, 0), viewport.pageWidthPt * viewport.scale),
    y: Math.min(Math.max(point.y, 0), viewport.pageHeightPt * viewport.scale),
  };
}

export type { Point, Rect };
