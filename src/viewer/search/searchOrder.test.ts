import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../ipc/bindings";
import { buildHitOrder, groupKey, NO_GROUP_KEY } from "./searchOrder";

function hit(outlineItemId: string | null, score: number | null): SearchHit {
  return {
    rects: [],
    charStart: 0,
    charLen: 1,
    context: { before: "", matched: "x", after: "", terms: [] },
    windowRects: [],
    score,
    spansPages: null,
    outlineItemId,
  };
}

// p1: chapter A (score 300), p2: A (100) + B (500), p3: B (200), p4: no chapter (50)
const hitsByPage = {
  1: [hit("A", 300)],
  2: [hit("A", 100), hit("B", 500)],
  3: [hit("B", 200)],
  4: [hit(null, 50)],
};

describe("visible order of the result list", () => {
  it("by position: groups and hits in document order", () => {
    const order = buildHitOrder(hitsByPage, false);
    expect(order.grouped).toBe(true);
    expect(order.groups.map((g) => g.id)).toEqual(["A", "B", null]);
    expect(order.flat).toEqual([
      { page: 1, hitIndex: 0 },
      { page: 2, hitIndex: 0 },
      { page: 2, hitIndex: 1 },
      { page: 3, hitIndex: 0 },
      { page: 4, hitIndex: 0 },
    ]);
  });

  it("most compact: hits by score inside each group, groups by their best hit", () => {
    const order = buildHitOrder(hitsByPage, true);
    // best hits: null=50, A=100, B=200
    expect(order.groups.map((g) => g.id)).toEqual([null, "A", "B"]);
    expect(order.groups[1].refs).toEqual([
      { page: 2, hitIndex: 0 }, // 100
      { page: 1, hitIndex: 0 }, // 300
    ]);
    expect(order.groups[2].refs).toEqual([
      { page: 3, hitIndex: 0 }, // 200
      { page: 2, hitIndex: 1 }, // 500
    ]);
    expect(order.flat).toHaveLength(5);
    expect(order.flat.map((r) => hitsByPage[r.page as 1][r.hitIndex].score)).toEqual([50, 100, 300, 200, 500]);
  });

  it("is a flat, header-less list when no hit has an outline entry (a PDF without index)", () => {
    const order = buildHitOrder({ 0: [hit(null, 9), hit(null, 3)], 5: [hit(null, 6)] }, false);
    expect(order.grouped).toBe(false);
    expect(order.groups).toHaveLength(1);
    expect(order.flat).toEqual([
      { page: 0, hitIndex: 0 },
      { page: 0, hitIndex: 1 },
      { page: 5, hitIndex: 0 },
    ]);
    // most compact on a flat list sorts the whole list by score
    expect(buildHitOrder({ 0: [hit(null, 9), hit(null, 3)], 5: [hit(null, 6)] }, true).flat).toEqual([
      { page: 0, hitIndex: 1 },
      { page: 5, hitIndex: 0 },
      { page: 0, hitIndex: 0 },
    ]);
  });

  it("breaks score ties by document order and keeps phrase hits (no score) in position order", () => {
    const tied = buildHitOrder({ 1: [hit("A", 10)], 2: [hit("A", 10)] }, true);
    expect(tied.flat).toEqual([
      { page: 1, hitIndex: 0 },
      { page: 2, hitIndex: 0 },
    ]);
    const phrase = buildHitOrder({ 3: [hit("A", null)], 1: [hit("A", null)] }, true);
    expect(phrase.flat.map((r) => r.page)).toEqual([1, 3]);
  });

  it("is empty for no hits", () => {
    expect(buildHitOrder({}, true)).toEqual({ flat: [], groups: [], grouped: false });
  });

  it("maps the null group to a reserved key", () => {
    expect(groupKey(null)).toBe(NO_GROUP_KEY);
    expect(groupKey("1.2")).toBe("1.2");
  });
});
