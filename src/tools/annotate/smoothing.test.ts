import { describe, expect, it } from "vitest";
import { smoothStrokePoints, type Vec2 } from "./smoothing";

/** Sum of absolute consecutive y-deltas — a simple "jaggedness" measure: high for a noisy zigzag, low for a smooth curve, independent of the path's overall trend. */
function jaggedness(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.abs(points[i].y - points[i - 1].y);
  return total;
}

describe("smoothStrokePoints", () => {
  it("leaves strokes with fewer than 3 points unchanged", () => {
    const points: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 4 },
    ];
    expect(smoothStrokePoints(points)).toEqual(points);
  });

  it("preserves the first and last point exactly (endpoints don't drift)", () => {
    const points: Vec2[] = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i % 2 === 0 ? 0 : 10 }));
    const smoothed = smoothStrokePoints(points, 3);
    expect(smoothed[0]).toEqual(points[0]);
    expect(smoothed[smoothed.length - 1]).toEqual(points[points.length - 1]);
  });

  it("measurably reduces zigzag noise without collapsing the path to a point", () => {
    // A noisy zigzag riding on a rising trend, roughly modeling a shaky
    // freehand stroke drawn diagonally.
    const n = 40;
    const points: Vec2[] = Array.from({ length: n }, (_, i) => ({ x: i, y: i + (i % 2 === 0 ? -6 : 6) }));

    const before = jaggedness(points);
    const smoothed = smoothStrokePoints(points, 4);
    const after = jaggedness(smoothed);

    // Smoothing should cut the point-to-point noise substantially...
    expect(after).toBeLessThan(before * 0.3);
    // ...without flattening the stroke into a single point or a flat line:
    // the smoothed path still spans essentially the same x/y range as the
    // original (only interior points move; endpoints are exact).
    const ys = smoothed.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(10);
    expect(smoothed[n - 1].x - smoothed[0].x).toBe(points[n - 1].x - points[0].x);
  });

  it("is a no-op on an already-smooth straight line, away from the endpoints", () => {
    // A symmetric moving-average window over evenly-spaced points on a
    // straight line reproduces that same line exactly — but only where the
    // window itself is symmetric, i.e. at least `strength` away from either
    // end (a window straddling the boundary is asymmetric and doesn't
    // average to the line's true value there, which is fine: the two tests
    // above already cover endpoint behavior specifically).
    const strength = 2;
    const points: Vec2[] = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i * 2 }));
    const smoothed = smoothStrokePoints(points, strength);
    for (let i = strength; i < points.length - strength; i++) {
      expect(smoothed[i].x).toBeCloseTo(points[i].x, 5);
      expect(smoothed[i].y).toBeCloseTo(points[i].y, 5);
    }
  });
});
