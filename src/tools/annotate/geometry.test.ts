// `geometry.ts` shipped without tests (wave-0 foundation commit) — the
// brief asks R4 to add coverage since this module's bbox math is
// load-bearing for every annotation's select/move/resize behavior. Covers
// the four structurally distinct geometry shapes: quadpoints (highlight),
// strokes (ink), a point (note), and a literal rect (shape) — freeText
// shares the same literal-rect path as shape, so it isn't repeated.
import { describe, expect, it } from "vitest";
import type { Annot } from "../../ipc/bindings";
import { applyBBoxToAnnot, getAnnotBBox, isAnnotResizable, NOTE_ICON_SIZE_PT } from "./geometry";

const highlight: Annot = {
  annotId: "a1",
  page: 0,
  kind: "highlight",
  quadpoints: [{ x1: 10, y1: 50, x2: 60, y2: 50, x3: 10, y3: 30, x4: 60, y4: 30 }],
  color: "#a3243a",
  opacity: 0.4,
};

const ink: Annot = {
  annotId: "a2",
  page: 0,
  kind: "ink",
  strokes: [
    {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 5 },
        { x: 5, y: 10 },
      ],
      width: 2,
      color: "#000000",
    },
  ],
  opacity: 1,
};

const note: Annot = { annotId: "a3", page: 0, kind: "note", point: { x: 100, y: 100 }, contents: "hi" };

const shape: Annot = {
  annotId: "a4",
  page: 0,
  kind: "shape",
  shape: "rect",
  rect: { x: 5, y: 5, width: 40, height: 30 },
  stroke: { color: "#000000", opacity: 1, width: 1 },
  fill: { color: null, opacity: null, width: null },
};

describe("getAnnotBBox", () => {
  it("highlight: bounds the union of its quadpoints", () => {
    expect(getAnnotBBox(highlight)).toEqual({ x: 10, y: 30, width: 50, height: 20 });
  });

  it("ink: bounds the union of every stroke's points", () => {
    expect(getAnnotBBox(ink)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("note: a fixed NOTE_ICON_SIZE_PT square anchored below-left of `point`", () => {
    expect(getAnnotBBox(note)).toEqual({ x: 100, y: 100 - NOTE_ICON_SIZE_PT, width: NOTE_ICON_SIZE_PT, height: NOTE_ICON_SIZE_PT });
  });

  it("shape: its own `rect`, verbatim", () => {
    expect(getAnnotBBox(shape)).toEqual({ x: 5, y: 5, width: 40, height: 30 });
  });
});

describe("isAnnotResizable", () => {
  it("is false only for note", () => {
    expect(isAnnotResizable(note)).toBe(false);
    expect(isAnnotResizable(highlight)).toBe(true);
    expect(isAnnotResizable(ink)).toBe(true);
    expect(isAnnotResizable(shape)).toBe(true);
  });
});

describe("applyBBoxToAnnot", () => {
  it("highlight: maps quadpoints from the old bbox onto the new one via translate+scale", () => {
    // Old bbox {x:10,y:30,w:50,h:20} -> new {x:0,y:0,w:100,h:40} is a clean 2x scale on both axes.
    const patch = applyBBoxToAnnot(highlight, { x: 0, y: 0, width: 100, height: 40 });
    expect(patch).toEqual({
      quadpoints: [{ x1: 0, y1: 40, x2: 100, y2: 40, x3: 0, y3: 0, x4: 100, y4: 0 }],
    });
  });

  it("ink: maps every stroke's points the same way", () => {
    // Old bbox {x:0,y:0,w:10,h:10} -> new {x:100,y:200,w:20,h:20}: 2x scale + translate.
    const patch = applyBBoxToAnnot(ink, { x: 100, y: 200, width: 20, height: 20 });
    expect(patch).toEqual({
      strokes: [
        {
          points: [
            { x: 100, y: 200 },
            { x: 120, y: 210 },
            { x: 110, y: 220 },
          ],
          width: 2,
          color: "#000000",
        },
      ],
    });
  });

  it("note: moves `point` to the new rect's implied top-left, ignoring any size change (fixed icon footprint)", () => {
    const patch = applyBBoxToAnnot(note, { x: 200, y: 300, width: 999, height: 999 });
    expect(patch).toEqual({ point: { x: 200, y: 300 + NOTE_ICON_SIZE_PT } });
  });

  it("shape: replaces `rect` directly", () => {
    const newRect = { x: 1, y: 2, width: 3, height: 4 };
    expect(applyBBoxToAnnot(shape, newRect)).toEqual({ rect: newRect });
  });

  it("degenerate zero-size source axis falls back to scale 1 instead of producing NaN", () => {
    const flat: Annot = {
      annotId: "a5",
      page: 0,
      kind: "ink",
      strokes: [
        {
          points: [
            { x: 5, y: 5 },
            { x: 5, y: 5 },
          ],
          width: 1,
          color: "#000000",
        },
      ],
      opacity: 1,
    };
    const patch = applyBBoxToAnnot(flat, { x: 50, y: 50, width: 0, height: 0 });
    if ("strokes" in patch) {
      for (const point of patch.strokes[0].points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
    } else {
      throw new Error("expected a strokes patch");
    }
  });
});
