// Accent colour presets (Settings → Aparência). The CSS side of each preset (the per-theme custom
// properties) lives in tokens.css under `:root[data-accent="<id>"]`; this module is the JS mirror
// used by the Settings swatches, by the prefs store and by the contrast test. Like tokens.ts there
// is no codegen: keep the hex values here in exact sync with tokens.css by hand (a test enforces it).
// Every value meets WCAG AA (4.5:1) for the foreground text on the accent and for the accent
// itself against the page backgrounds of its theme (also asserted in a test).

export const ACCENT_IDS = ["rubrica", "blue", "teal", "green", "purple", "graphite"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];

/** The built-in Rubrica red: no `data-accent` attribute, the base values in tokens.css apply. */
export const DEFAULT_ACCENT: AccentId = "rubrica";

export interface AccentTheme {
  accent: string;
  accentHover: string;
  accentForeground: string;
}

export interface AccentPreset {
  id: AccentId;
  light: AccentTheme;
  dark: AccentTheme;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  {
    id: "rubrica",
    light: { accent: "#a3243a", accentHover: "#8a1e31", accentForeground: "#fff6f2" },
    dark: { accent: "#e6808f", accentHover: "#ee9aa6", accentForeground: "#2b0f16" },
  },
  {
    id: "blue",
    light: { accent: "#1d4ed8", accentHover: "#1e40af", accentForeground: "#f5f8ff" },
    dark: { accent: "#8ab4ff", accentHover: "#a5c4ff", accentForeground: "#0b1a3a" },
  },
  {
    id: "teal",
    light: { accent: "#0f766e", accentHover: "#115e59", accentForeground: "#f0fdfa" },
    dark: { accent: "#4fd1c5", accentHover: "#7ee8dc", accentForeground: "#062925" },
  },
  {
    id: "green",
    light: { accent: "#166534", accentHover: "#14532d", accentForeground: "#f0fdf4" },
    dark: { accent: "#6fcf8a", accentHover: "#8ddba3", accentForeground: "#06210f" },
  },
  {
    id: "purple",
    light: { accent: "#6d28d9", accentHover: "#5b21b6", accentForeground: "#f8f5ff" },
    dark: { accent: "#b79cff", accentHover: "#c9b5ff", accentForeground: "#1d0b45" },
  },
  {
    id: "graphite",
    light: { accent: "#3f4a56", accentHover: "#2c353f", accentForeground: "#f6f8fa" },
    dark: { accent: "#aab4c0", accentHover: "#c3cbd4", accentForeground: "#12171c" },
  },
];

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === "string" && (ACCENT_IDS as readonly string[]).includes(value);
}
