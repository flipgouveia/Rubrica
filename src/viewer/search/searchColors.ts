// Highlight colours per term position (SEARCH-ORCHESTRATION §2.1 "Cores do destaque", mockup state G).
//
// The user owns FOUR colours, bound to the term's POSITION in the query (colour 1 = first term…),
// not to the word; phrase mode uses colour 1; terms from the 5th on cycle through the four. They are
// stored as `#RRGGBB` (no alpha) and drawn at a fixed ~50 % opacity so the page text stays legible.
// The originals are the `--search-t1..t4` tokens: a colour equal to its original is painted through
// the token (so a future theme tweak still applies), anything else as an `rgba(…, .5)` of the hex.

/** The four original colours (hex of the `--search-t1..t4` tokens, before their alpha). */
export const DEFAULT_HIGHLIGHT_COLORS: readonly string[] = ["#FACC15", "#22D3EE", "#F472B6", "#4ADE80"];

/** The 8 presets of the palette (mockup state G): the 4 originals plus 4 more. */
export const PRESET_COLORS: readonly string[] = [
  "#FACC15",
  "#22D3EE",
  "#F472B6",
  "#4ADE80",
  "#FB923C",
  "#A78BFA",
  "#60A5FA",
  "#F87171",
];

export const HIGHLIGHT_SLOTS = 4;
export const HIGHLIGHT_ALPHA = 0.5;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

/** Canonical spelling (upper-case) of a valid hex colour. */
export function normalizeHex(value: string): string {
  return value.toUpperCase();
}

/** 0..3 slot of a term index; terms beyond the 4th cycle (negative/odd input is folded in range). */
export function colorSlot(termIndex: number): number {
  return ((Math.trunc(termIndex) % HIGHLIGHT_SLOTS) + HIGHLIGHT_SLOTS) % HIGHLIGHT_SLOTS;
}

/** Parses the persisted `search.highlightColors` JSON; `null` when it is missing or malformed. */
export function parseHighlightColors(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length !== HIGHLIGHT_SLOTS) return null;
    if (!value.every((entry): entry is string => typeof entry === "string" && isHexColor(entry))) return null;
    return value.map(normalizeHex);
  } catch {
    return null;
  }
}

export function sameColor(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

function isOriginal(colors: readonly string[], slot: number): boolean {
  return sameColor(colors[slot] ?? "", DEFAULT_HIGHLIGHT_COLORS[slot]);
}

export function hexToRgba(hex: string, alpha = HIGHLIGHT_ALPHA): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Translucent fill that highlights a term on the page (the user's colour, or the original token). */
export function highlightFill(colors: readonly string[], termIndex: number): string {
  const slot = colorSlot(termIndex);
  return isOriginal(colors, slot) ? `var(--search-t${slot + 1})` : hexToRgba(colors[slot]);
}

/** Solid swatch of a term chip / palette (the original `--search-tNs` token, or the user's hex). */
export function swatchFill(colors: readonly string[], termIndex: number): string {
  const slot = colorSlot(termIndex);
  return isOriginal(colors, slot) ? `var(--search-t${slot + 1}s)` : colors[slot];
}

/** The hex of a term's colour, for tests and `data-` attributes. */
export function colorOf(colors: readonly string[], termIndex: number): string {
  return colors[colorSlot(termIndex)];
}
