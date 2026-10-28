import { describe, expect, it } from "vitest";
import { isCollapsed, normalizeSelection, selectionRangeForPage, type SelectionRange } from "./selectionStore";

const doc = "doc-1";

describe("normalizeSelection", () => {
  it("keeps anchor-before-focus order as-is", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 0, charIndex: 5 }, focus: { page: 0, charIndex: 12 } };
    expect(normalizeSelection(sel)).toEqual({ startPage: 0, startIndex: 5, endPage: 0, endIndex: 12 });
  });

  it("flips a backwards same-page drag", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 0, charIndex: 12 }, focus: { page: 0, charIndex: 5 } };
    expect(normalizeSelection(sel)).toEqual({ startPage: 0, startIndex: 5, endPage: 0, endIndex: 12 });
  });

  it("orders by page first when the drag spans multiple pages", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 2, charIndex: 3 }, focus: { page: 0, charIndex: 40 } };
    expect(normalizeSelection(sel)).toEqual({ startPage: 0, startIndex: 40, endPage: 2, endIndex: 3 });
  });
});

describe("isCollapsed", () => {
  it("is true for a click with no drag", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 0, charIndex: 5 }, focus: { page: 0, charIndex: 5 } };
    expect(isCollapsed(sel)).toBe(true);
  });

  it("is false once anchor and focus differ", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 0, charIndex: 5 }, focus: { page: 0, charIndex: 6 } };
    expect(isCollapsed(sel)).toBe(false);
  });
});

describe("selectionRangeForPage", () => {
  const PAGE_LENGTH = 200;

  it("returns null for a page entirely outside the selection", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 2, charIndex: 0 }, focus: { page: 3, charIndex: 10 } };
    expect(selectionRangeForPage(sel, 0, PAGE_LENGTH)).toBeNull();
    expect(selectionRangeForPage(sel, 5, PAGE_LENGTH)).toBeNull();
  });

  it("returns the exact sub-range for a single-page selection", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 1, charIndex: 10 }, focus: { page: 1, charIndex: 50 } };
    expect(selectionRangeForPage(sel, 1, PAGE_LENGTH)).toEqual({ start: 10, end: 50 });
  });

  it("returns null (no highlight) for a collapsed single-page selection", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 1, charIndex: 10 }, focus: { page: 1, charIndex: 10 } };
    expect(selectionRangeForPage(sel, 1, PAGE_LENGTH)).toBeNull();
  });

  it("selects from the start index to the page end on the first page of a multi-page selection", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 0, charIndex: 150 }, focus: { page: 2, charIndex: 5 } };
    expect(selectionRangeForPage(sel, 0, PAGE_LENGTH)).toEqual({ start: 150, end: PAGE_LENGTH });
  });

  it("selects from the page start to the end index on the last page of a multi-page selection", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 0, charIndex: 150 }, focus: { page: 2, charIndex: 5 } };
    expect(selectionRangeForPage(sel, 2, PAGE_LENGTH)).toEqual({ start: 0, end: 5 });
  });

  it("selects the whole page for a page strictly between the selection's endpoints", () => {
    const sel: SelectionRange = { docId: doc, anchor: { page: 0, charIndex: 150 }, focus: { page: 3, charIndex: 5 } };
    expect(selectionRangeForPage(sel, 1, PAGE_LENGTH)).toEqual({ start: 0, end: PAGE_LENGTH });
    expect(selectionRangeForPage(sel, 2, PAGE_LENGTH)).toEqual({ start: 0, end: PAGE_LENGTH });
  });

  it("handles a selection dragged backwards across pages the same as forwards", () => {
    const forward: SelectionRange = { docId: doc, anchor: { page: 0, charIndex: 150 }, focus: { page: 2, charIndex: 5 } };
    const backward: SelectionRange = { docId: doc, anchor: { page: 2, charIndex: 5 }, focus: { page: 0, charIndex: 150 } };
    expect(selectionRangeForPage(forward, 1, PAGE_LENGTH)).toEqual(selectionRangeForPage(backward, 1, PAGE_LENGTH));
  });
});
