// Generic bounding-box move/resize for every annotation kind.
//
// CONTRACTS §3 defines exactly one shape for `AnnotPatch`: `{ color,
// opacity, contents, rect }` — the SAME four fields regardless of which
// `AnnotSpec` variant the target annotation is. `shape`/`freeText` annots
// literally have a `rect` field, so a `rect` patch is a direct replacement
// for them. `highlight`/`underline`/`strikeout` (quadpoints), `ink`
// (strokes), and `note` (point) do NOT structurally have a `rect` — but the
// brief calls select/move/resize/delete "common machinery" across every
// annotation type, which only makes sense if `AnnotPatch.rect` is meant
// generically as "the annotation's new bounding box," not literally as its
// `rect` field.
//
// This module is the single implementation of that interpretation: compute
// an annotation's current bounding box (`getAnnotBBox`), and map its
// geometry from the old bbox to a new one (`applyBBoxToAnnot`) via uniform
// translate+scale. The tool UI uses `getAnnotBBox` to place selection/resize
// handles and compute the dragged target rect; `src/ipc/mock/annotations.ts`
// uses `applyBBoxToAnnot` inside `annot_update` to turn that target rect
// back into kind-correct geometry. Flagged in the wave-1 report: R5's real
// Rust engine must implement the same bbox-transform semantics for
// `annot_update`'s `rect` patch on quadpoint/stroke/point-geometry kinds,
// not just a literal rect assignment.
import type { Annot, Point, QuadPoint, Rect, Stroke } from "../../ipc/bindings";
import { nz } from "../shared/coords";

/**
 * The geometry-bearing fields an `annot_update` patch can produce, one
 * variant per annotation kind. Deliberately NOT `Partial<Annot>`: `Partial`
 * of a discriminated union only keeps each member's COMMON keys (`annotId`,
 * `page`, `kind`), not each variant's own geometry field — this named union
 * is the accurate shape instead.
 */
export type AnnotGeometryPatch = { quadpoints: QuadPoint[] } | { strokes: Stroke[] } | { point: Point } | { rect: Rect };

/** Fixed icon footprint for `note` annotations (PDF points) — notes are movable but not resizable, matching Acrobat's own sticky-note behavior. */
export const NOTE_ICON_SIZE_PT = 24;

function bboxFromPoints(xs: number[], ys: number[]): Rect {
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function quadPoints(quad: QuadPoint): { x: number; y: number }[] {
  return [
    { x: nz(quad.x1), y: nz(quad.y1) },
    { x: nz(quad.x2), y: nz(quad.y2) },
    { x: nz(quad.x3), y: nz(quad.y3) },
    { x: nz(quad.x4), y: nz(quad.y4) },
  ];
}

export function getAnnotBBox(annot: Annot): Rect {
  switch (annot.kind) {
    case "highlight":
    case "underline":
    case "strikeout": {
      const pts = annot.quadpoints.flatMap(quadPoints);
      return bboxFromPoints(
        pts.map((p) => p.x),
        pts.map((p) => p.y),
      );
    }
    case "ink": {
      const pts = annot.strokes.flatMap((s) => s.points.map((p) => ({ x: nz(p.x), y: nz(p.y) })));
      if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      return bboxFromPoints(
        pts.map((p) => p.x),
        pts.map((p) => p.y),
      );
    }
    case "note":
      return { x: nz(annot.point.x), y: nz(annot.point.y) - NOTE_ICON_SIZE_PT, width: NOTE_ICON_SIZE_PT, height: NOTE_ICON_SIZE_PT };
    case "shape":
    case "freeText":
      return annot.rect;
  }
}

/** Whether dragging a resize handle (not just a move) makes sense for this annotation kind. */
export function isAnnotResizable(annot: Annot): boolean {
  return annot.kind !== "note";
}

/**
 * Maps `annot`'s geometry from its current bounding box onto `newRect` via a
 * uniform translate+scale per axis, returning only the fields that changed
 * (merge into the target with `Object.assign`/spread). Degenerate zero-size
 * source axes (e.g. a perfectly horizontal or vertical ink stroke) fall back
 * to scale 1 on that axis so a move doesn't produce `NaN`/Infinity geometry.
 */
export function applyBBoxToAnnot(annot: Annot, newRect: Rect): AnnotGeometryPatch {
  const old = getAnnotBBox(annot);
  const oldW = old.width ?? 0;
  const oldH = old.height ?? 0;
  const newW = nz(newRect.width) || oldW;
  const newH = nz(newRect.height) || oldH;
  const scaleX = oldW > 1e-6 ? newW / oldW : 1;
  const scaleY = oldH > 1e-6 ? newH / oldH : 1;
  const originX = nz(newRect.x);
  const originY = nz(newRect.y);
  const mapX = (x: number) => originX + (x - old.x!) * scaleX;
  const mapY = (y: number) => originY + (y - old.y!) * scaleY;

  switch (annot.kind) {
    case "highlight":
    case "underline":
    case "strikeout": {
      const quadpoints = annot.quadpoints.map(
        (q): QuadPoint => ({
          x1: mapX(nz(q.x1)),
          y1: mapY(nz(q.y1)),
          x2: mapX(nz(q.x2)),
          y2: mapY(nz(q.y2)),
          x3: mapX(nz(q.x3)),
          y3: mapY(nz(q.y3)),
          x4: mapX(nz(q.x4)),
          y4: mapY(nz(q.y4)),
        }),
      );
      return { quadpoints };
    }
    case "ink": {
      const strokes: Stroke[] = annot.strokes.map((s) => ({
        ...s,
        points: s.points.map((p) => ({ x: mapX(nz(p.x)), y: mapY(nz(p.y)) })),
      }));
      return { strokes };
    }
    case "note":
      return { point: { x: originX, y: originY + NOTE_ICON_SIZE_PT } };
    case "shape":
    case "freeText":
      return { rect: newRect };
  }
}
