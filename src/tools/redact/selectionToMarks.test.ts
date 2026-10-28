import { describe, expect, it } from "vitest";
import type { CharBox } from "../../ipc/bindings";
import type { SelectionRange } from "../../viewer/selection/selectionStore";
import { computeMarkRectsForPage, computeMarksFromSelection, pagesSpannedBySelection } from "./selectionToMarks";

const DOC_ID = "doc-1";

function charBox(charIndex: number, x: number, y: number, width = 7, height = 14): CharBox {
  return { charIndex, rect: { x, y, width, height } };
}

describe("pagesSpannedBySelection", () => {
  it("returns the single page for a same-page selection", () => {
    const selection: SelectionRange = { docId: DOC_ID, anchor: { page: 2, charIndex: 3 }, focus: { page: 2, charIndex: 10 } };
    expect(pagesSpannedBySelection(selection)).toEqual([2]);
  });

  it("returns every page in range inclusive, regardless of anchor/focus order", () => {
    const selection: SelectionRange = { docId: DOC_ID, anchor: { page: 3, charIndex: 5 }, focus: { page: 1, charIndex: 0 } };
    expect(pagesSpannedBySelection(selection)).toEqual([1, 2, 3]);
  });
});

describe("computeMarkRectsForPage", () => {
  const boxes: CharBox[] = [charBox(0, 72, 700), charBox(1, 79, 700), charBox(2, 86, 700)];

  it("returns one rect per visual row within the selection's range on this page", () => {
    const selection: SelectionRange = { docId: DOC_ID, anchor: { page: 0, charIndex: 0 }, focus: { page: 0, charIndex: 3 } };
    const rects = computeMarkRectsForPage(selection, 0, boxes);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ x: 72, width: 21 });
  });

  it("returns an empty array for a page the selection doesn't touch", () => {
    const selection: SelectionRange = { docId: DOC_ID, anchor: { page: 0, charIndex: 0 }, focus: { page: 0, charIndex: 3 } };
    expect(computeMarkRectsForPage(selection, 5, boxes)).toEqual([]);
  });

  it("returns an empty array for a collapsed selection", () => {
    const selection: SelectionRange = { docId: DOC_ID, anchor: { page: 0, charIndex: 1 }, focus: { page: 0, charIndex: 1 } };
    expect(computeMarkRectsForPage(selection, 0, boxes)).toEqual([]);
  });
});

describe("computeMarksFromSelection", () => {
  it("returns no marks for a null selection", async () => {
    const marks = await computeMarksFromSelection(DOC_ID, null, async () => []);
    expect(marks).toEqual([]);
  });

  it("returns no marks for a selection belonging to a different document", async () => {
    const selection: SelectionRange = { docId: "other-doc", anchor: { page: 0, charIndex: 0 }, focus: { page: 0, charIndex: 3 } };
    const marks = await computeMarksFromSelection(DOC_ID, selection, async () => [charBox(0, 72, 700)]);
    expect(marks).toEqual([]);
  });

  it("returns no marks for a collapsed selection", async () => {
    const selection: SelectionRange = { docId: DOC_ID, anchor: { page: 0, charIndex: 2 }, focus: { page: 0, charIndex: 2 } };
    const marks = await computeMarksFromSelection(DOC_ID, selection, async () => [charBox(0, 72, 700)]);
    expect(marks).toEqual([]);
  });

  it("fetches each spanned page's layout in order and converts it to per-page marks", async () => {
    const selection: SelectionRange = { docId: DOC_ID, anchor: { page: 0, charIndex: 2 }, focus: { page: 1, charIndex: 1 } };
    const layouts: Record<number, CharBox[]> = {
      0: [charBox(0, 72, 700), charBox(1, 79, 700), charBox(2, 86, 700)],
      1: [charBox(0, 72, 700), charBox(1, 79, 700)],
    };
    const fetchedPages: number[] = [];
    const marks = await computeMarksFromSelection(DOC_ID, selection, async (page) => {
      fetchedPages.push(page);
      return layouts[page] ?? [];
    });

    expect(fetchedPages).toEqual([0, 1]);
    expect(marks).toHaveLength(2);
    expect(marks[0].page).toBe(0);
    expect(marks[0].rect).toMatchObject({ x: 86 }); // page 0: only charIndex 2 (start=2, end=pageTextLength=3) is selected.
    expect(marks[1].page).toBe(1);
    expect(marks[1].rect).toMatchObject({ x: 72 }); // page 1 (end page): only charIndex 0 (start=0, end=1) is selected.
  });
});
