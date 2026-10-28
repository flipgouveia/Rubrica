import { describe, expect, it } from "vitest";
import { makePageViewport } from "../../chrome/tool-api";
import { clampScreenRectToPage, defaultRectAt, dragRectFromPoints, rectToScreen, screenDistance, screenRectToPdfRect } from "./geometry";

// A 612x792pt (US Letter) page at 1.5x zoom, unrotated — realistic enough to
// exercise every helper without needing a page canvas or React at all.
const viewport = makePageViewport("doc-1", 0, 612, 792, 1.5, 0);

describe("rectToScreen", () => {
  it("maps a rect's PDF-space top-left corner (x, y + height) to the screen rect's (x, y)", () => {
    const rect = { x: 72, y: 700, width: 300, height: 20 };
    const screen = rectToScreen(rect, viewport);
    const expectedTopLeft = viewport.toScreen(72, 720); // y + height
    expect(screen.x).toBeCloseTo(expectedTopLeft.x);
    expect(screen.y).toBeCloseTo(expectedTopLeft.y);
    expect(screen.width).toBeCloseTo(300 * 1.5);
    expect(screen.height).toBeCloseTo(20 * 1.5);
  });

  it("treats null rect fields as 0 (CONTRACTS' f64-as-null convention)", () => {
    const screen = rectToScreen({ x: null, y: null, width: null, height: null }, viewport);
    expect(screen).toEqual({ x: 0, y: viewport.heightPt * viewport.zoom, width: 0, height: 0 });
  });
});

describe("screenRectToPdfRect", () => {
  it("is the exact inverse of rectToScreen", () => {
    const original = { x: 72, y: 700, width: 300, height: 20 };
    const roundTripped = screenRectToPdfRect(rectToScreen(original, viewport), viewport);
    expect(roundTripped.x).toBeCloseTo(original.x);
    expect(roundTripped.y).toBeCloseTo(original.y);
    expect(roundTripped.width).toBeCloseTo(original.width);
    expect(roundTripped.height).toBeCloseTo(original.height);
  });
});

describe("dragRectFromPoints", () => {
  it("normalizes two corners regardless of drag direction", () => {
    expect(dragRectFromPoints({ x: 10, y: 10 }, { x: 50, y: 40 })).toEqual({ x: 10, y: 10, width: 40, height: 30 });
    // Dragged the opposite way (bottom-right to top-left) — same resulting rect.
    expect(dragRectFromPoints({ x: 50, y: 40 }, { x: 10, y: 10 })).toEqual({ x: 10, y: 10, width: 40, height: 30 });
  });

  it("returns a zero-size rect for a single point", () => {
    expect(dragRectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe("defaultRectAt", () => {
  it("anchors the given PDF-point size, scaled by zoom, at the point's top-left", () => {
    const rect = defaultRectAt({ x: 100, y: 200 }, { width: 160, height: 20 }, 1.5);
    expect(rect).toEqual({ x: 100, y: 200, width: 240, height: 30 });
  });
});

describe("screenDistance", () => {
  it("computes straight-line distance", () => {
    expect(screenDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("is zero for the same point", () => {
    expect(screenDistance({ x: 12, y: 8 }, { x: 12, y: 8 })).toBe(0);
  });
});

describe("clampScreenRectToPage", () => {
  const pageWidth = 900;
  const pageHeight = 1200;

  it("leaves a rect that already fits untouched", () => {
    const rect = { x: 50, y: 50, width: 100, height: 80 };
    expect(clampScreenRectToPage(rect, pageWidth, pageHeight)).toEqual(rect);
  });

  it("pulls a rect back into bounds when it overhangs the right/bottom edge", () => {
    const rect = { x: 850, y: 1150, width: 100, height: 80 };
    const clamped = clampScreenRectToPage(rect, pageWidth, pageHeight);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(pageWidth);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(pageHeight);
    expect(clamped.width).toBe(100);
    expect(clamped.height).toBe(80);
  });

  it("pulls a rect back into bounds when it starts off the top/left edge", () => {
    const rect = { x: -30, y: -20, width: 100, height: 80 };
    const clamped = clampScreenRectToPage(rect, pageWidth, pageHeight);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
  });

  it("shrinks a rect larger than the page itself instead of producing a negative origin", () => {
    const rect = { x: 0, y: 0, width: 2000, height: 3000 };
    const clamped = clampScreenRectToPage(rect, pageWidth, pageHeight);
    expect(clamped.width).toBe(pageWidth);
    expect(clamped.height).toBe(pageHeight);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
  });
});
