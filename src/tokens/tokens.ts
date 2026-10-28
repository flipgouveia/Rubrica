// TypeScript mirror of src/tokens/tokens.css — source of truth for JS-side
// consumers that can't reach CSS custom properties, e.g. <canvas> drawing
// code in the tile renderer / SVG overlay layers (see ARCHITECTURE.md).
// Keep these values in exact sync with tokens.css by hand; there is no
// build-time codegen linking the two files.

export type ThemeName = "light" | "dark";

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceRaised: string;
  overlay: string;
  border: string;
  borderStrong: string;
  text: string;
  mutedText: string;
  accent: string;
  accentHover: string;
  accentForeground: string;
  danger: string;
  dangerForeground: string;
  success: string;
  successForeground: string;
  focusRing: string;
}

/** Mirrors the `--rubrica-*` custom properties in tokens.css. */
export const colors: Record<ThemeName, ThemeColors> = {
  light: {
    background: "#faf7f5",
    surface: "#ffffff",
    surfaceRaised: "#ffffff",
    overlay: "rgb(36 28 26 / 0.45)",
    border: "#e7dfda",
    borderStrong: "#d3c6be",
    text: "#241c1a",
    mutedText: "#6f625b",
    accent: "#a3243a",
    accentHover: "#8a1e31",
    accentForeground: "#fff6f2",
    danger: "#b3261e",
    dangerForeground: "#fff5f3",
    success: "#1c6e4a",
    successForeground: "#f1fbf5",
    focusRing: "#a3243a",
  },
  dark: {
    background: "#17120f",
    surface: "#1e1815",
    surfaceRaised: "#26201c",
    overlay: "rgb(0 0 0 / 0.6)",
    border: "#362d27",
    borderStrong: "#4a3e36",
    text: "#f3ece7",
    mutedText: "#b2a69d",
    accent: "#e6808f",
    accentHover: "#ee9aa6",
    accentForeground: "#2b0f16",
    danger: "#ff8a80",
    dangerForeground: "#2b0d0a",
    success: "#6fdda6",
    successForeground: "#07281a",
    focusRing: "#e6808f",
  },
};

/**
 * Font stacks. Mirrors the `@theme` block in tokens.css: `sans` overrides
 * Tailwind's own `--font-sans` (so plain body/UI text is already
 * Instrument Sans with no extra class), `mono` overrides `--font-mono`,
 * and `display` is Rubrica's own addition for headings (`font-display`
 * utility). No .woff2 files are bundled yet — see the tokens.css header —
 * so these stacks currently render via their system fallback.
 */
export const fonts = {
  sans: `"Instrument Sans", ui-sans-serif, system-ui, sans-serif`,
  mono: `"JetBrains Mono", ui-monospace, "Cascadia Code", monospace`,
  display: `"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif`,
};

/** Mirrors the `--radius-*` overrides in the tokens.css `@theme` block. */
export const radii = {
  sm: "6px",
  md: "10px",
  lg: "16px",
};

/**
 * Mirrors Tailwind's own default 4px spacing scale (Rubrica does not
 * override it — see the note in tokens.css). Provided for non-CSS
 * consumers (canvas layout math) that need the same numbers in JS.
 */
export const spacing = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "24px",
  6: "32px",
};

/** Mirrors the `--shadow-*` entries in the tokens.css `@theme` block. */
export const shadows = {
  menu: "0 8px 24px -4px rgb(0 0 0 / 0.18), 0 2px 8px -2px rgb(0 0 0 / 0.12)",
  dialog: "0 24px 48px -12px rgb(0 0 0 / 0.35), 0 8px 24px -8px rgb(0 0 0 / 0.2)",
};
