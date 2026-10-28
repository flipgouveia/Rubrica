// Search preferences: defaults, persistence format (CONTRACTS §8), loading, validation.
import { beforeEach, describe, expect, it } from "vitest";
import { commands } from "../../ipc";
import { DEFAULT_HIGHLIGHT_COLORS } from "./searchColors";
import {
  clampWindow,
  isValidWindow,
  PREF_KEYS,
  PROXIMITY_WINDOW_DEFAULT,
  PROXIMITY_WINDOW_PRESETS,
  resetSearchPrefsForTests,
  useSearchPrefs,
} from "./searchPrefs";

const prefs = () => useSearchPrefs.getState();

async function stored(key: string): Promise<string | null> {
  const result = await commands.prefsGet(key);
  return result.status === "ok" ? result.data : null;
}

beforeEach(() => {
  localStorage.clear();
  resetSearchPrefsForTests();
});

describe("defaults", () => {
  it("starts in phrase mode, 500-char window, accents ignored, headers/footers kept, most compact first, original colours", () => {
    expect(prefs()).toMatchObject({
      mode: "phrase",
      proximityWindow: PROXIMITY_WINDOW_DEFAULT,
      ignoreDiacritics: true,
      excludeHeadersFooters: false,
      sort: "compact",
      highlightColors: DEFAULT_HIGHLIGHT_COLORS,
    });
    expect(PROXIMITY_WINDOW_DEFAULT).toBe(500);
    expect(PROXIMITY_WINDOW_PRESETS).toEqual([100, 250, 500, 1000]);
  });
});

describe("persistence (one prefs key per field, string values)", () => {
  it("saves every field in the contract's format", async () => {
    prefs().setMode("proximity");
    prefs().setProximityWindow(250);
    prefs().setIgnoreDiacritics(false);
    prefs().setExcludeHeadersFooters(true);
    prefs().setSort("position");
    prefs().setHighlightColor(1, "#a78bfa");
    expect(await stored(PREF_KEYS.mode)).toBe("proximity");
    expect(await stored(PREF_KEYS.proximityWindow)).toBe("250");
    expect(await stored(PREF_KEYS.ignoreDiacritics)).toBe("false");
    expect(await stored(PREF_KEYS.excludeHeadersFooters)).toBe("true");
    expect(await stored(PREF_KEYS.sort)).toBe("position");
    expect(JSON.parse((await stored(PREF_KEYS.highlightColors)) as string)).toEqual(["#FACC15", "#A78BFA", "#F472B6", "#4ADE80"]);
    expect(PREF_KEYS).toEqual({
      mode: "search.mode",
      proximityWindow: "search.proximityWindow",
      ignoreDiacritics: "search.ignoreDiacritics",
      excludeHeadersFooters: "search.excludeHeadersFooters",
      sort: "search.sort",
      highlightColors: "search.highlightColors",
    });
  });

  it("loads what was saved", async () => {
    localStorage.clear();
    await commands.prefsSet(PREF_KEYS.mode, "proximity");
    await commands.prefsSet(PREF_KEYS.proximityWindow, "1000");
    await commands.prefsSet(PREF_KEYS.ignoreDiacritics, "false");
    await commands.prefsSet(PREF_KEYS.excludeHeadersFooters, "true");
    await commands.prefsSet(PREF_KEYS.sort, "position");
    await commands.prefsSet(PREF_KEYS.highlightColors, JSON.stringify(["#fb923c", "#22d3ee", "#f472b6", "#f87171"]));
    await prefs().load();
    expect(prefs()).toMatchObject({
      loaded: true,
      mode: "proximity",
      proximityWindow: 1000,
      ignoreDiacritics: false,
      excludeHeadersFooters: true,
      sort: "position",
      highlightColors: ["#FB923C", "#22D3EE", "#F472B6", "#F87171"],
    });
  });

  it("ignores stored values that are out of range or malformed", async () => {
    await commands.prefsSet(PREF_KEYS.mode, "fuzzy");
    await commands.prefsSet(PREF_KEYS.proximityWindow, "10");
    await commands.prefsSet(PREF_KEYS.ignoreDiacritics, "maybe");
    await commands.prefsSet(PREF_KEYS.sort, "alphabetical");
    await commands.prefsSet(PREF_KEYS.highlightColors, JSON.stringify(["#fff", "x", 1, null]));
    await prefs().load();
    expect(prefs()).toMatchObject({
      loaded: true,
      mode: "phrase",
      proximityWindow: 500,
      ignoreDiacritics: true,
      sort: "compact",
      highlightColors: DEFAULT_HIGHLIGHT_COLORS,
    });
    await commands.prefsSet(PREF_KEYS.proximityWindow, "5001");
    resetSearchPrefsForTests();
    await prefs().load();
    expect(prefs().proximityWindow).toBe(500);
  });

  it("a change made before the load finishes wins over the stored value", async () => {
    await commands.prefsSet(PREF_KEYS.mode, "proximity");
    const loading = prefs().load();
    prefs().setMode("phrase");
    await loading;
    expect(prefs().mode).toBe("phrase");
  });

  it("loads once", async () => {
    await commands.prefsSet(PREF_KEYS.mode, "proximity");
    await prefs().load();
    await commands.prefsSet(PREF_KEYS.mode, "phrase");
    await prefs().load();
    expect(prefs().mode).toBe("proximity");
  });
});

describe("setters", () => {
  it("toggles the mode", () => {
    prefs().toggleMode();
    expect(prefs().mode).toBe("proximity");
    prefs().toggleMode();
    expect(prefs().mode).toBe("phrase");
  });

  it("keeps the window between 20 and 5000", () => {
    expect([clampWindow(1), clampWindow(20), clampWindow(5000), clampWindow(99999), clampWindow(333.6)]).toEqual([20, 20, 5000, 5000, 334]);
    expect(isValidWindow(20) && isValidWindow(5000) && isValidWindow(500)).toBe(true);
    expect([19, 5001, 1.5, NaN].some(isValidWindow)).toBe(false);
    prefs().setProximityWindow(7);
    expect(prefs().proximityWindow).toBe(20);
  });

  it("edits one colour at a time, rejects an invalid hex, and resets to the originals", async () => {
    prefs().setHighlightColor(0, "#60a5fa");
    expect(prefs().highlightColors).toEqual(["#60A5FA", "#22D3EE", "#F472B6", "#4ADE80"]);
    prefs().setHighlightColor(2, "nope");
    prefs().setHighlightColor(9, "#112233");
    expect(prefs().highlightColors).toEqual(["#60A5FA", "#22D3EE", "#F472B6", "#4ADE80"]);
    prefs().resetHighlightColors();
    expect(prefs().highlightColors).toEqual(DEFAULT_HIGHLIGHT_COLORS);
    expect(JSON.parse((await stored(PREF_KEYS.highlightColors)) as string)).toEqual(DEFAULT_HIGHLIGHT_COLORS);
  });
});
