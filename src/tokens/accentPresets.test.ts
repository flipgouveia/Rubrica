// Every accent preset keeps WCAG AA in both themes, and the hand-maintained CSS in tokens.css
// matches the JS mirror in accentPresets.ts for all three theme sources (light, OS dark, forced dark).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCENT_IDS, ACCENT_PRESETS, DEFAULT_ACCENT, isAccentId } from "./accentPresets";
import { colors } from "./tokens";

function channel(hex: string, offset: number): number {
  const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}
/** WCAG 2.x contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
// Every page background the accent can sit on, per theme (tokens.css).
const BACKGROUNDS = {
  light: [colors.light.background, colors.light.surface, colors.light.surfaceRaised],
  dark: [colors.dark.background, colors.dark.surface, colors.dark.surfaceRaised],
} as const;

describe("accent presets contrast (WCAG AA)", () => {
  it("has the default plus 5 to 7 presets, ids unique", () => {
    expect(ACCENT_PRESETS.map((p) => p.id)).toEqual([...ACCENT_IDS]);
    expect(new Set(ACCENT_IDS).size).toBe(ACCENT_IDS.length);
    expect(ACCENT_IDS.length).toBeGreaterThanOrEqual(5);
    expect(ACCENT_IDS.length).toBeLessThanOrEqual(7);
    expect(isAccentId(DEFAULT_ACCENT)).toBe(true);
    expect(isAccentId("nope")).toBe(false);
  });

  it("the default preset is exactly the base palette", () => {
    const rubrica = ACCENT_PRESETS.find((p) => p.id === DEFAULT_ACCENT)!;
    for (const theme of ["light", "dark"] as const) {
      expect(rubrica[theme]).toEqual({
        accent: colors[theme].accent,
        accentHover: colors[theme].accentHover,
        accentForeground: colors[theme].accentForeground,
      });
    }
  });

  for (const preset of ACCENT_PRESETS) {
    for (const theme of ["light", "dark"] as const) {
      const { accent, accentHover, accentForeground } = preset[theme];
      it(`${preset.id} (${theme}): text on the accent and on its hover state`, () => {
        expect(contrast(accentForeground, accent)).toBeGreaterThanOrEqual(AA);
        expect(contrast(accentForeground, accentHover)).toBeGreaterThanOrEqual(AA);
      });
      it(`${preset.id} (${theme}): accent and hover as text/borders on every page background`, () => {
        for (const background of BACKGROUNDS[theme]) {
          expect(contrast(accent, background)).toBeGreaterThanOrEqual(AA);
          expect(contrast(accentHover, background)).toBeGreaterThanOrEqual(AA);
        }
      });
    }
  }
});

// Vitest runs from the repo root (jsdom makes `import.meta.url` a non-file URL).
const tokensCss = readFileSync(resolve(process.cwd(), "src/tokens/tokens.css"), "utf8");

function block(selector: string): string {
  const start = tokensCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no CSS block for ${selector}`);
  return tokensCss.slice(start, tokensCss.indexOf("}", start));
}

describe("tokens.css matches accentPresets.ts", () => {
  for (const preset of ACCENT_PRESETS.filter((p) => p.id !== DEFAULT_ACCENT)) {
    const id = preset.id;
    const sources = {
      light: block(`:root[data-accent="${id}"]`),
      "OS dark": block(`:root[data-accent="${id}"]:not([data-theme="light"])`),
      "forced dark": block(`:root[data-accent="${id}"][data-theme="dark"]`),
    };
    const expectations = [
      ["light", preset.light],
      ["OS dark", preset.dark],
      ["forced dark", preset.dark],
    ] as const;
    for (const [source, theme] of expectations) {
      it(`${id}: ${source} block`, () => {
        const css = sources[source];
        expect(css).toContain(`--rubrica-accent: ${theme.accent};`);
        expect(css).toContain(`--rubrica-accent-hover: ${theme.accentHover};`);
        expect(css).toContain(`--rubrica-accent-foreground: ${theme.accentForeground};`);
        expect(css).toContain(`--rubrica-focus-ring: ${theme.accent};`);
      });
    }
    it(`${id}: keeps the light accent for what is drawn over the page bitmap`, () => {
      expect(sources.light).toContain(`--rubrica-accent-page: ${preset.light.accent};`);
    });
  }
});
