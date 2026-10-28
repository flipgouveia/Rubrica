import { describe, expect, it } from "vitest";

import { buildReorderedIndices, computeDropIndex, type RectLike } from "./dnd";

// A single row of 5 thumbnails, 160px wide with a 20px gap (180px pitch),
// all sharing the same vertical span — mirrors PagesPanel's real layout
// closely enough to exercise the "same row" branch of computeDropIndex.
// centers land at x = 80, 260, 440, 620, 800.
function singleRowRects(count: number): RectLike[] {
  return Array.from({ length: count }, (_, i) => ({
    left: i * 180,
    right: i * 180 + 160,
    top: 0,
    bottom: 220,
  }));
}

const ROW_Y = 110; // vertical midpoint of the fixture row above

describe("computeDropIndex", () => {
  it("drops before the first thumbnail when the pointer is left of its center", () => {
    const rects = singleRowRects(5);
    expect(computeDropIndex({ x: -50, y: ROW_Y }, rects, 2)).toBe(0);
    expect(computeDropIndex({ x: 30, y: ROW_Y }, rects, 2)).toBe(0);
  });

  it("drops after the last thumbnail when the pointer is right of its center", () => {
    const rects = singleRowRects(5);
    expect(computeDropIndex({ x: 1100, y: ROW_Y }, rects, 2)).toBe(5);
    expect(computeDropIndex({ x: 850, y: ROW_Y }, rects, 2)).toBe(5);
  });

  it("is a no-op gap when the pointer sits on either edge of the dragged item's own slot", () => {
    const rects = singleRowRects(5);
    const draggedIndex = 2; // slot spans [360, 520], center 440

    // Just right of item 1's center (260) but left of item 2 (dragged) —
    // closest surviving candidate is item 1, pointer is right of its
    // center, so the gap returned is "after item 1" == draggedIndex.
    expect(computeDropIndex({ x: 300, y: ROW_Y }, rects, draggedIndex)).toBe(draggedIndex);

    // Just left of item 3's center (620) but right of item 2 (dragged) —
    // closest surviving candidate is item 3, pointer is left of its
    // center, so the gap returned is "before item 3" == draggedIndex + 1.
    expect(computeDropIndex({ x: 580, y: ROW_Y }, rects, draggedIndex)).toBe(draggedIndex + 1);
  });

  it("drops into the middle when the pointer sits clearly on one side of a middle thumbnail", () => {
    const rects = singleRowRects(5);
    // Left half of item 2 (center 440, dragging item 0) -> gap 2.
    expect(computeDropIndex({ x: 400, y: ROW_Y }, rects, 0)).toBe(2);
    // Right half of item 2 (center 440, dragging item 0) -> gap 3.
    expect(computeDropIndex({ x: 480, y: ROW_Y }, rects, 0)).toBe(3);
  });

  it("resolves left-vs-right correctly across a sweep of gaps", () => {
    const rects = singleRowRects(5);
    const draggedIndex = 4;
    // Sweeping left to right across items 0..3 (item 4 excluded, dragged),
    // the drop gap should be monotonically non-decreasing.
    const xs = [-20, 80, 150, 260, 330, 440, 510, 620];
    const results = xs.map((x) => computeDropIndex({ x, y: ROW_Y }, rects, draggedIndex));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1]);
    }
    expect(results[0]).toBe(0);
    expect(results.at(-1)).toBe(4);
  });

  it("uses the row (vertical) position to disambiguate a wrapped, multi-row grid", () => {
    // Two rows of 3: row 0 at y[0,220], row 1 at y[240,460].
    const rects: RectLike[] = [
      { left: 0, right: 160, top: 0, bottom: 220 },
      { left: 180, right: 340, top: 0, bottom: 220 },
      { left: 360, right: 520, top: 0, bottom: 220 },
      { left: 0, right: 160, top: 240, bottom: 460 },
      { left: 180, right: 340, top: 240, bottom: 460 },
      { left: 360, right: 520, top: 240, bottom: 460 },
    ];
    // Pointer clearly above row 0 -> before whatever's closest in row 0.
    expect(computeDropIndex({ x: 80, y: -50 }, rects, 5)).toBe(0);
    // Pointer clearly below row 1 -> after whatever's closest in row 1.
    expect(computeDropIndex({ x: 440, y: 600 }, rects, 0)).toBe(6);
  });

  it("returns the dragged index itself when it is the only rect", () => {
    const rects = singleRowRects(1);
    expect(computeDropIndex({ x: 9999, y: ROW_Y }, rects, 0)).toBe(0);
  });

  it("returns 0 for an empty rect list", () => {
    expect(computeDropIndex({ x: 0, y: 0 }, [], 0)).toBe(0);
  });
});

describe("buildReorderedIndices", () => {
  it("is a no-op when dropped into its own leading gap", () => {
    const order = [0, 1, 2, 3, 4];
    const result = buildReorderedIndices(order, 2, 2);
    expect(result).toEqual(order);
    expect(result).not.toBe(order);
  });

  it("is a no-op when dropped into its own trailing gap", () => {
    const order = [0, 1, 2, 3, 4];
    const result = buildReorderedIndices(order, 2, 3);
    expect(result).toEqual(order);
    expect(result).not.toBe(order);
  });

  it("moves an item from the front to the end", () => {
    const order = [0, 1, 2, 3, 4];
    expect(buildReorderedIndices(order, 0, 5)).toEqual([1, 2, 3, 4, 0]);
  });

  it("moves an item from the end to the front", () => {
    const order = [0, 1, 2, 3, 4];
    expect(buildReorderedIndices(order, 4, 0)).toEqual([4, 0, 1, 2, 3]);
  });

  it("moves an item into the middle, dragging left to right", () => {
    const order = [0, 1, 2, 3, 4];
    // Drop item 0 into gap 3 (after original item 2).
    expect(buildReorderedIndices(order, 0, 3)).toEqual([1, 2, 0, 3, 4]);
  });

  it("moves an item into the middle, dragging right to left", () => {
    const order = [0, 1, 2, 3, 4];
    // Drop item 4 into gap 1 (right after original item 0).
    expect(buildReorderedIndices(order, 4, 1)).toEqual([0, 4, 1, 2, 3]);
  });

  it("operates on the current `order` values, not raw positions, after a prior reorder", () => {
    // Simulates calling this a second time against an already-permuted
    // array (as PagesPanel would after a first successful pagesReorder).
    const order = [4, 0, 1, 2, 3];
    expect(buildReorderedIndices(order, 0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("leaves the order untouched for an out-of-range fromIndex", () => {
    const order = [0, 1, 2];
    const result = buildReorderedIndices(order, 5, 1);
    expect(result).toEqual(order);
    expect(result).not.toBe(order);
  });

  it("clamps an out-of-range toIndex to the end", () => {
    const order = [0, 1, 2, 3];
    expect(buildReorderedIndices(order, 0, 999)).toEqual([1, 2, 3, 0]);
  });
});
