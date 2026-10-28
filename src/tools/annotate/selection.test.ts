import { describe, expect, it } from "vitest";
import type { PageViewport, ScreenRect } from "../shared/coords";
import { deriveQuadpointsFromSelectionRects } from "./selection";

describe("deriveQuadpointsFromSelectionRects", () => {
  const viewport: PageViewport = { pageWidthPt: 612, pageHeightPt: 792, scale: 1 };

  it("converts a single screen-space selection rect into a PDF-space quad, flipping y", () => {
    // Same rect/viewport as `DemoRoute.tsx`'s own hardcoded highlight example
    // — this doubles as a regression check that the two independently
    // written call sites agree on the coordinate convention.
    const rect: ScreenRect = { x: 72, y: 92, width: 228, height: 20 };
    const [quad] = deriveQuadpointsFromSelectionRects([rect], viewport);
    expect(quad).toEqual({ x1: 72, y1: 700, x2: 300, y2: 700, x3: 72, y3: 680, x4: 300, y4: 680 });
  });

  it("produces one quad per input rect, preserving order (one per visual line)", () => {
    const rects: ScreenRect[] = [
      { x: 72, y: 92, width: 200, height: 20 },
      { x: 72, y: 112, width: 120, height: 20 },
    ];
    const quads = deriveQuadpointsFromSelectionRects(rects, viewport);
    expect(quads).toHaveLength(2);
    // Second line sits directly below the first on screen -> lower PDF y (y-up).
    expect(quads[0].y3).toBe(quads[1].y1);
    expect(quads[1].x2).toBe(72 + 120);
  });

  it("accounts for zoom scale when converting", () => {
    const zoomed: PageViewport = { ...viewport, scale: 2 };
    const rect: ScreenRect = { x: 144, y: 184, width: 456, height: 40 };
    const [quad] = deriveQuadpointsFromSelectionRects([rect], zoomed);
    // At 2x zoom, the same PDF-space quad as the 1x case above should result
    // from screen coordinates that are exactly doubled.
    expect(quad).toEqual({ x1: 72, y1: 700, x2: 300, y2: 700, x3: 72, y3: 680, x4: 300, y4: 680 });
  });

  it("returns an empty array for no rects", () => {
    expect(deriveQuadpointsFromSelectionRects([], viewport)).toEqual([]);
  });
});
