import { describe, expect, it } from "vitest";
import { zoomedListY, zoomedScrollLeft } from "./zoomAnchor";

const pages = [792, 792, 792];
const GAP = 16;

describe("zoomedListY", () => {
  it("keeps the top of the document at the top", () => {
    expect(zoomedListY(pages, GAP, 1, 2, 0)).toBe(0);
  });

  it("does not scale the padding above the first page", () => {
    expect(zoomedListY(pages, GAP, 1, 2, -24)).toBe(-24);
  });

  it("scales the offset inside a page with the page", () => {
    // page 2 starts at 792 + 16 at 100%, and at 2 * 792 + 16 at 200%; a point 100px into it ends up 200px into it
    expect(zoomedListY(pages, GAP, 1, 2, 808 + 100)).toBe(2 * 792 + GAP + 200);
  });

  it("keeps the gap between pages a constant size", () => {
    // 4px into the 16px gap under page 1
    expect(zoomedListY(pages, GAP, 1, 2, 792 + 4)).toBe(2 * 792 + 4);
  });

  it("is reversible", () => {
    const there = zoomedListY(pages, GAP, 1, 1.7, 1234);
    expect(zoomedListY(pages, GAP, 1.7, 1, there)).toBeCloseTo(1234, 6);
  });

  it("carries a position past the last page over unchanged", () => {
    expect(zoomedListY(pages, GAP, 1, 2, 3 * 808 + 10)).toBe(3 * (2 * 792 + GAP) + 10);
  });
});

describe("zoomedScrollLeft", () => {
  it("stays at 0 while the pages fit the viewport", () => {
    expect(zoomedScrollLeft(612, 1152, 24, 1, 1.2, 0, 600)).toBe(0);
  });

  it("zooms around the cursor once the page is wider than the viewport", () => {
    // 612pt page at 400% = 2448px in a 1152px viewport; the cursor sat at the centre of the page
    const left = zoomedScrollLeft(612, 1152, 24, 1, 4, 0, 24 + 576);
    expect(left).toBeCloseTo(24 + 2448 / 2 - 600, 6);
  });

  it("keeps the point under the cursor when already scrolled", () => {
    const widest = 612;
    const before = { zoom: 3, scrollLeft: 300, cursorX: 200 };
    const after = zoomedScrollLeft(widest, 1152, 24, before.zoom, 4, before.scrollLeft, before.cursorX);
    // document x (from the page's left edge) under the cursor, as a fraction of the page width
    const pageLeft = (zoom: number) => 24 + (Math.max(1152, widest * zoom) - widest * zoom) / 2;
    const fractionBefore = (before.scrollLeft + before.cursorX - pageLeft(3)) / (widest * 3);
    const fractionAfter = (after + before.cursorX - pageLeft(4)) / (widest * 4);
    expect(fractionAfter).toBeCloseTo(fractionBefore, 6);
  });
});
