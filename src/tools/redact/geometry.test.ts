import { describe, expect, it } from "vitest";
import type { PageViewport } from "../../chrome/tool-api";
import { clampRectToPage, docRectToScreen, isDragBigEnough, normalizeScreenRect, screenRectToDoc } from "./geometry";

function makeViewport(zoom: number): PageViewport {
  const heightPt = 792;
  return {
    docId: "doc-1",
    page: 0,
    widthPt: 612,
    heightPt,
    zoom,
    rotation: 0,
    toScreen: (ptX, ptY) => ({ x: ptX * zoom, y: (heightPt - ptY) * zoom }),
    toDoc: (pxX, pxY) => ({ x: pxX / zoom, y: heightPt - pxY / zoom }),
  };
}

describe("docRectToScreen", () => {
  it("flips a PDF-space rect (bottom-left origin) into a screen rect (top-left origin)", () => {
    const viewport = makeViewport(1);
    const rect = { x: 72, y: 700, width: 300, height: 20 };
    // Top-left in PDF space is (72, 720) -> screen y = pageHeight - 720 = 72.
    expect(docRectToScreen(rect, viewport)).toEqual({ x: 72, y: 72, width: 300, height: 20 });
  });

  it("scales position and size by the viewport's zoom", () => {
    const viewport = makeViewport(2);
    const rect = { x: 72, y: 700, width: 300, height: 20 };
    expect(docRectToScreen(rect, viewport)).toEqual({ x: 144, y: 144, width: 600, height: 40 });
  });

  it("treats null rect fields as 0 (CONTRACTS' f64-as-null quirk)", () => {
    const viewport = makeViewport(1);
    expect(docRectToScreen({ x: null, y: null, width: null, height: null }, viewport)).toEqual({ x: 0, y: 792, width: 0, height: 0 });
  });
});

describe("screenRectToDoc", () => {
  it("round-trips through docRectToScreen", () => {
    const viewport = makeViewport(1.5);
    const rect = { x: 100, y: 200, width: 50, height: 30 };
    const screen = docRectToScreen(rect, viewport);
    const back = screenRectToDoc(screen, viewport);
    expect(back.x).toBeCloseTo(100);
    expect(back.y).toBeCloseTo(200);
    expect(back.width).toBeCloseTo(50);
    expect(back.height).toBeCloseTo(30);
  });
});

describe("normalizeScreenRect", () => {
  it("normalizes regardless of which corner the drag started from", () => {
    expect(normalizeScreenRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 40, height: 60 });
    expect(normalizeScreenRect({ x: 10, y: 20 }, { x: 50, y: 80 })).toEqual({ x: 10, y: 20, width: 40, height: 60 });
  });
});

describe("isDragBigEnough", () => {
  it("rejects a drag smaller than the threshold in either axis", () => {
    expect(isDragBigEnough({ x: 0, y: 0, width: 2, height: 10 })).toBe(false);
    expect(isDragBigEnough({ x: 0, y: 0, width: 10, height: 2 })).toBe(false);
  });

  it("accepts a drag at or above the threshold in both axes", () => {
    expect(isDragBigEnough({ x: 0, y: 0, width: 4, height: 4 })).toBe(true);
    expect(isDragBigEnough({ x: 0, y: 0, width: 50, height: 50 })).toBe(true);
  });
});

describe("clampRectToPage", () => {
  it("clamps a rect that overshoots the page bounds back within them", () => {
    expect(clampRectToPage({ x: -10, y: -5, width: 50, height: 50 }, 40, 30)).toEqual({ x: 0, y: 0, width: 40, height: 30 });
  });

  it("leaves a rect that's already within bounds untouched", () => {
    expect(clampRectToPage({ x: 5, y: 5, width: 10, height: 10 }, 40, 30)).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });
});
