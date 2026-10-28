import { describe, expect, it } from "vitest";
import { groupMarksByPage, groupMarksForDisplay } from "./grouping";
import type { PendingMark } from "./model";

function mark(id: string, page: number, x = 0): PendingMark {
  return { id, page, rect: { x, y: 0, width: 10, height: 10 } };
}

describe("groupMarksByPage", () => {
  it("groups marks by page, sorted ascending by page, preserving within-page order", () => {
    const marks = [mark("a", 2), mark("b", 0), mark("c", 2), mark("d", 1)];
    expect(groupMarksByPage(marks)).toEqual([
      { page: 0, rects: [marks[1].rect], markIds: ["b"] },
      { page: 1, rects: [marks[3].rect], markIds: ["d"] },
      { page: 2, rects: [marks[0].rect, marks[2].rect], markIds: ["a", "c"] },
    ]);
  });

  it("returns an empty array for no marks", () => {
    expect(groupMarksByPage([])).toEqual([]);
  });

  it("returns a single group with one rect for a single mark", () => {
    const marks = [mark("only", 3)];
    expect(groupMarksByPage(marks)).toEqual([{ page: 3, rects: [marks[0].rect], markIds: ["only"] }]);
  });
});

describe("groupMarksForDisplay", () => {
  it("groups full mark objects by page, sorted ascending by page", () => {
    const marks = [mark("a", 1), mark("b", 0), mark("c", 1)];
    const groups = groupMarksForDisplay(marks);
    expect(groups.map((g) => g.page)).toEqual([0, 1]);
    expect(groups[0].marks).toEqual([marks[1]]);
    expect(groups[1].marks).toEqual([marks[0], marks[2]]);
  });

  it("returns an empty array for no marks", () => {
    expect(groupMarksForDisplay([])).toEqual([]);
  });
});
