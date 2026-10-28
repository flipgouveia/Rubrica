import { describe, expect, it } from "vitest";
import {
  colorOf,
  colorSlot,
  DEFAULT_HIGHLIGHT_COLORS,
  hexToRgba,
  highlightFill,
  isHexColor,
  normalizeHex,
  parseHighlightColors,
  PRESET_COLORS,
  swatchFill,
} from "./searchColors";

describe("highlight colours", () => {
  it("has 8 distinct presets that start with the 4 originals", () => {
    expect(PRESET_COLORS).toHaveLength(8);
    expect(new Set(PRESET_COLORS).size).toBe(8);
    expect(PRESET_COLORS.slice(0, 4)).toEqual(DEFAULT_HIGHLIGHT_COLORS);
  });

  it("validates #RRGGBB strictly", () => {
    for (const ok of ["#FACC15", "#facc15", "#000000", "#aBcDeF"]) expect(isHexColor(ok)).toBe(true);
    for (const bad of ["", "FACC15", "#FACC1", "#FACC155", "#GGGGGG", "#fff", "rgb(0,0,0)", " #FACC15"]) expect(isHexColor(bad)).toBe(false);
    expect(normalizeHex("#facc15")).toBe("#FACC15");
  });

  it("cycles colours past the fourth term", () => {
    expect([0, 1, 2, 3, 4, 5, 8].map(colorSlot)).toEqual([0, 1, 2, 3, 0, 1, 0]);
    const colors = ["#111111", "#222222", "#333333", "#444444"];
    expect(colorOf(colors, 4)).toBe("#111111");
    expect(colorOf(colors, 6)).toBe("#333333");
  });

  it("paints an unchanged colour with its token and a custom one at ~50 % alpha", () => {
    const colors = [...DEFAULT_HIGHLIGHT_COLORS];
    colors[1] = "#A78BFA";
    expect(highlightFill(colors, 0)).toBe("var(--search-t1)");
    expect(highlightFill(colors, 1)).toBe(hexToRgba("#A78BFA"));
    expect(highlightFill(colors, 1)).toBe("rgba(167, 139, 250, 0.5)");
    expect(highlightFill(colors, 5)).toBe("rgba(167, 139, 250, 0.5)"); // 6th term = colour 2
    expect(swatchFill(colors, 0)).toBe("var(--search-t1s)");
    expect(swatchFill(colors, 1)).toBe("#A78BFA");
  });

  it("parses the persisted JSON and rejects anything malformed", () => {
    expect(parseHighlightColors(JSON.stringify(["#facc15", "#22d3ee", "#f472b6", "#4ade80"]))).toEqual(DEFAULT_HIGHLIGHT_COLORS);
    expect(parseHighlightColors(null)).toBeNull();
    expect(parseHighlightColors("not json")).toBeNull();
    expect(parseHighlightColors(JSON.stringify(["#facc15"]))).toBeNull();
    expect(parseHighlightColors(JSON.stringify(["#facc15", "#22d3ee", "#f472b6", "red"]))).toBeNull();
    expect(parseHighlightColors(JSON.stringify({ 0: "#facc15" }))).toBeNull();
  });
});
