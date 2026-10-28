import { describe, expect, it } from "vitest";
import type { CharBox } from "../../ipc/bindings";
import { buildHighlightRects, toDisplayBands } from "./highlightRects";

// Mirrors mock/text.ts's grid: 60 chars/row, 7pt-wide chars, 14pt-tall rows, one page margin.
const CHARS_PER_LINE = 60;
const CHAR_WIDTH = 7;
const LINE_HEIGHT = 14;
const MARGIN = 72;
const PAGE_HEIGHT = 792;

function box(charIndex: number): CharBox {
  const col = charIndex % CHARS_PER_LINE;
  const row = Math.floor(charIndex / CHARS_PER_LINE);
  return { charIndex, rect: { x: MARGIN + col * CHAR_WIDTH, y: PAGE_HEIGHT - MARGIN - row * LINE_HEIGHT, width: CHAR_WIDTH, height: LINE_HEIGHT } };
}

const PAGE_BOXES: CharBox[] = Array.from({ length: 150 }, (_, i) => box(i));

describe("buildHighlightRects", () => {
  it("returns nothing for an empty range", () => {
    expect(buildHighlightRects(PAGE_BOXES, 10, 10)).toEqual([]);
  });

  it("merges a same-row range into a single rect spanning it", () => {
    const rects = buildHighlightRects(PAGE_BOXES, 5, 10);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: MARGIN + 5 * CHAR_WIDTH, y: PAGE_HEIGHT - MARGIN, width: 5 * CHAR_WIDTH, height: LINE_HEIGHT });
  });

  it("produces one rect per row when the range crosses a line boundary", () => {
    // Row 0 is chars [0, 60), row 1 is [60, 120) — selecting [55, 65) crosses the boundary.
    const rects = buildHighlightRects(PAGE_BOXES, 55, 65);
    expect(rects).toHaveLength(2);
    const [firstRow, secondRow] = rects;
    expect(firstRow.width).toBe(5 * CHAR_WIDTH); // chars 55..59
    expect(secondRow.width).toBe(5 * CHAR_WIDTH); // chars 60..64
    expect(firstRow.y).not.toBe(secondRow.y);
  });

  it("spans full rows in the middle of a multi-row range", () => {
    const rects = buildHighlightRects(PAGE_BOXES, 0, 130);
    expect(rects).toHaveLength(3); // rows 0, 1 (full 60 chars each), and partial row 2 (10 chars)
    expect(rects[0].width).toBe(CHARS_PER_LINE * CHAR_WIDTH);
    expect(rects[1].width).toBe(CHARS_PER_LINE * CHAR_WIDTH);
    expect(rects[2].width).toBe(10 * CHAR_WIDTH);
  });
});

// Real PDFium glyph boxes: each glyph carries its own tight y/height (x-height, ascender, descender).
function glyph(charIndex: number, x: number, bottom: number, top: number, width = 6): CharBox {
  return { charIndex, rect: { x, y: bottom, width, height: top - bottom } };
}

/** One line of text at `baseline` with a mix of x-height, ascender and descender glyphs, starting at char `first`. */
function textLine(first: number, baseline: number): CharBox[] {
  const shapes = [
    [0, 5], // x-height
    [0, 9], // ascender
    [-3, 5], // descender
    [0, 9],
    [-3, 9], // both
    [0, 5],
  ];
  return shapes.map(([below, above], i) => glyph(first + i, 72 + i * 6, baseline + below, baseline + above));
}

describe("buildHighlightRects with real glyph bounds", () => {
  it("merges glyphs with differing y/height on one line into a single rect with the line's extent", () => {
    const rects = buildHighlightRects(textLine(0, 700), 0, 6);
    expect(rects).toEqual([{ x: 72, y: 697, width: 36, height: 12 }]);
  });

  it("yields one rect per line, in reading order, for lines whose glyph extents overlap", () => {
    // Leading of 11pt with a 12pt glyph extent: line 1's descenders (697) reach above line 2's ascenders (700+9-11=698).
    const boxes = [...textLine(0, 700), ...textLine(6, 689), ...textLine(12, 678)];
    const rects = buildHighlightRects(boxes, 0, 18);
    expect(rects).toHaveLength(3);
    expect(rects.map((r) => r.y)).toEqual([697, 686, 675]);
    expect(rects.every((r) => r.x === 72 && r.width === 36)).toBe(true);
  });

  it("keeps mixed font sizes (a superscript, a larger run) on the same line", () => {
    const boxes = [glyph(0, 72, 700, 709), glyph(1, 78, 706, 711, 4), glyph(2, 82, 697, 716, 12), glyph(3, 94, 700, 709)];
    expect(buildHighlightRects(boxes, 0, 4)).toEqual([{ x: 72, y: 697, width: 28, height: 19 }]);
  });

  it("splits lines whose glyphs differ in y by a hair without matching y exactly", () => {
    const boxes = [glyph(0, 72, 700, 709), glyph(1, 78, 701, 708), glyph(2, 72, 680, 689), glyph(3, 78, 679.99, 688.5)];
    expect(buildHighlightRects(boxes, 0, 4)).toHaveLength(2);
  });

  it("ignores zero-sized boxes so they do not stretch a line", () => {
    const boxes = [glyph(0, 72, 700, 709), { charIndex: 1, rect: { x: 400, y: 0, width: 0, height: 0 } }, glyph(2, 78, 700, 709)];
    expect(buildHighlightRects(boxes, 0, 3)).toEqual([{ x: 72, y: 700, width: 12, height: 9 }]);
  });

  it("only includes boxes inside [start, end)", () => {
    const rects = buildHighlightRects(textLine(0, 700), 2, 4);
    expect(rects).toEqual([{ x: 84, y: 697, width: 12, height: 12 }]);
  });
});

describe("toDisplayBands", () => {
  it("leaves already-separate bands untouched", () => {
    const rects = [
      { x: 72, y: 700, width: 100, height: 12 },
      { x: 72, y: 680, width: 100, height: 12 },
    ];
    expect(toDisplayBands(rects)).toEqual(rects);
  });

  it("splits the vertical overlap of two adjacent lines at its middle", () => {
    const upper = { x: 72, y: 698, width: 100, height: 12 }; // 698..710
    const lower = { x: 72, y: 686, width: 80, height: 14 }; // 686..700
    const [u, l] = toDisplayBands([upper, lower]);
    expect(u.y).toBe(699);
    expect(l.y! + l.height!).toBe(699);
    expect(u.y! + u.height!).toBe(710);
    expect(l.y).toBe(686);
  });

  it("produces no overlapping bands for a block of tightly leaded lines", () => {
    const boxes = [...textLine(0, 700), ...textLine(6, 689), ...textLine(12, 678), ...textLine(18, 667)];
    const bands = toDisplayBands(buildHighlightRects(boxes, 0, 24));
    expect(bands).toHaveLength(4);
    for (let i = 0; i < bands.length; i++) {
      for (let j = i + 1; j < bands.length; j++) {
        const overlap = Math.min(bands[i].y! + bands[i].height!, bands[j].y! + bands[j].height!) - Math.max(bands[i].y!, bands[j].y!);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
    expect(bands.every((b) => b.height! > 0)).toBe(true);
  });

  it("does not split bands that share no horizontal extent (two columns)", () => {
    const left = { x: 72, y: 698, width: 100, height: 12 };
    const right = { x: 300, y: 690, width: 100, height: 12 };
    expect(toDisplayBands([left, right])).toEqual([left, right]);
  });

  it("does not mutate its input", () => {
    const rects = [
      { x: 72, y: 698, width: 100, height: 12 },
      { x: 72, y: 686, width: 100, height: 14 },
    ];
    const copy = structuredClone(rects);
    toDisplayBands(rects);
    expect(rects).toEqual(copy);
  });
});
