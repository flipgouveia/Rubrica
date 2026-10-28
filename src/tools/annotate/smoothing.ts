// Smooths a freehand ink stroke's raw captured points before it is
// committed to the PDF (ARCHITECTURE: "committed to the PDF only on
// release" — this runs once, at pointer-up, never mid-stroke).
//
// Deliberately typed over a minimal `{ x, y }` shape rather than the IPC
// `Point` (`{ x: number | null; y: number | null }`): these are freshly
// captured pointer coordinates, never deserialized IPC data, so the
// f64-as-null quirk (CONTRACTS/R1 report) doesn't apply, and the algorithm
// itself is coordinate-system-agnostic — callers can smooth screen-space
// points or already-converted PDF-space points with the same function
// (`AnnotationLayer` calls it after converting to PDF space, so the
// smoothing strength is in PDF points regardless of zoom).
//
// Pressure/tilt are ignored entirely (pressure-agnostic per the brief) —
// every point in `Vec2` and thus every `Stroke.points` entry this feeds
// carries only position; stroke width comes uniformly from the tool's width
// control, not per-point pressure.
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * A centered moving-average smoother: each output point is the average of
 * up to `2*strength + 1` input points centered on it. `strength` is a point
 * radius, not a pixel/PDF-point distance, so it scales naturally with
 * however densely the caller sampled the raw pointer events. The first and
 * last points are always preserved exactly (a stroke's endpoints shouldn't
 * drift, or short strokes near the window size would visibly shrink).
 *
 * Strokes shorter than 3 points are returned unchanged — there's nothing
 * meaningful to average.
 */
export function smoothStrokePoints(points: readonly Vec2[], strength = 2): Vec2[] {
  const n = points.length;
  if (n < 3 || strength < 1) return points.map((p) => ({ ...p }));

  const result: Vec2[] = new Array(n);
  result[0] = { ...points[0] };
  result[n - 1] = { ...points[n - 1] };

  for (let i = 1; i < n - 1; i++) {
    const lo = Math.max(0, i - strength);
    const hi = Math.min(n - 1, i + strength);
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let j = lo; j <= hi; j++) {
      sumX += points[j].x;
      sumY += points[j].y;
      count++;
    }
    result[i] = { x: sumX / count, y: sumY / count };
  }
  return result;
}
