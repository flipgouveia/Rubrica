import { describe, expect, it } from "vitest";
import type { OutlineItem } from "../../ipc/bindings";
import { aggregateHitCounts, ancestorIds, defaultExpanded, highlightedRowId, visibleRows } from "./outlineModel";

const node = (id: string, page: number | null, pageEnd: number | null, children: OutlineItem[] = []): OutlineItem => ({
  id,
  title: `T${id}`,
  page,
  pageEnd,
  depth: id.split(".").length - 1,
  children,
});

const TREE: OutlineItem[] = [
  node("0", 0, 9, [node("0.0", 0, 4, [node("0.0.0", 0, 1)]), node("0.1", 5, 9)]),
  node("1", 10, 19),
];

describe("visibleRows", () => {
  it("lists only the top level when nothing is expanded", () => {
    expect(visibleRows(TREE, new Set()).map((r) => r.item.id)).toEqual(["0", "1"]);
  });
  it("lists children, in document order, below expanded entries only", () => {
    const rows = visibleRows(TREE, new Set(["0", "0.0"]));
    expect(rows.map((r) => [r.item.id, r.level, r.posInSet, r.setSize, r.parentId])).toEqual([
      ["0", 1, 1, 2, null],
      ["0.0", 2, 1, 2, "0"],
      ["0.0.0", 3, 1, 1, "0.0"],
      ["0.1", 2, 2, 2, "0"],
      ["1", 1, 2, 2, null],
    ]);
    expect(visibleRows(TREE, new Set(["0.0"])).map((r) => r.item.id)).toEqual(["0", "1"]); // closed parent hides it
  });
});

describe("ancestorIds", () => {
  it("returns the path from the root, excluding the entry itself", () => {
    expect(ancestorIds(TREE, "0.0.0")).toEqual(["0", "0.0"]);
    expect(ancestorIds(TREE, "0")).toEqual([]);
    expect(ancestorIds(TREE, "nope")).toEqual([]);
  });
});

describe("aggregateHitCounts", () => {
  it("sums each entry with all of its descendants", () => {
    const totals = aggregateHitCounts(TREE, new Map([["0.0.0", 2], ["0.0", 1], ["0.1", 4], ["1", 3]]));
    expect(Object.fromEntries(totals)).toEqual({ "0": 7, "0.0": 3, "0.0.0": 2, "0.1": 4, "1": 3 });
  });
  it("is all zeros without counts", () => {
    expect([...aggregateHitCounts(TREE, new Map()).values()].every((n) => n === 0)).toBe(true);
  });
});

describe("defaultExpanded / highlightedRowId", () => {
  it("opens the path to the entry containing the page", () => {
    expect([...defaultExpanded(TREE, 1)].sort()).toEqual(["0", "0.0"]);
    expect([...defaultExpanded(TREE, 7)]).toEqual(["0"]);
    expect([...defaultExpanded(TREE, 15)]).toEqual([]);
    expect([...defaultExpanded(TREE, 99)]).toEqual([]);
  });
  it("marks the current row, or its outermost collapsed ancestor when it is hidden", () => {
    expect(highlightedRowId(TREE, "0.0.0", new Set(["0", "0.0"]))).toBe("0.0.0");
    expect(highlightedRowId(TREE, "0.0.0", new Set(["0"]))).toBe("0.0");
    expect(highlightedRowId(TREE, "0.0.0", new Set())).toBe("0");
    expect(highlightedRowId(TREE, null, new Set())).toBeNull();
  });
});
