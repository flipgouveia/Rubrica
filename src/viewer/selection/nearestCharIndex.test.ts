import { describe, expect, it } from "vitest";
import type { CharBox } from "../../ipc/bindings";
import { nearestCharIndex } from "./nearestCharIndex";

function box(charIndex: number, x: number, y: number, width = 7, height = 14): CharBox {
  return { charIndex, rect: { x, y, width, height } };
}

describe("nearestCharIndex", () => {
  it("returns 0 for an empty layout", () => {
    expect(nearestCharIndex([], 100, 100)).toBe(0);
  });

  it("picks the char whose center is closest to the point", () => {
    const boxes = [box(0, 0, 700), box(1, 7, 700), box(2, 14, 700)];
    // Center of char 1 is (10.5, 707); this point is much closer to it than to 0 or 2.
    expect(nearestCharIndex(boxes, 11, 707)).toBe(1);
  });

  it("clicking well past the last character still resolves to the nearest one", () => {
    const boxes = [box(0, 0, 700), box(1, 7, 700), box(2, 14, 700)];
    expect(nearestCharIndex(boxes, 1000, 700)).toBe(2);
  });

  it("clicking before the first character resolves to it", () => {
    const boxes = [box(0, 72, 700), box(1, 79, 700)];
    expect(nearestCharIndex(boxes, 0, 700)).toBe(0);
  });
});
