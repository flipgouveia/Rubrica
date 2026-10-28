// Shared tool-state types for the annotation editor: what's being drawn and
// with what style. Deliberately separate from `geometry.ts` (bbox math) and
// from any single component — both `AnnotationLayer` and `AnnotationToolbar`
// import these so a host (today: `dev/AnnotateHarness.tsx`; later: R3's
// chrome shell) can lift `{ mode, style, selectedId }` state above both
// without either component depending on the other's internals.
import type { Annot, ShapeKind } from "../../ipc/bindings";

/** `"select"` is the default: click to select/move/resize/delete existing annotations. Every other value is a tool actively creating a new annotation of that kind. */
export type AnnotationMode = "select" | "highlight" | "underline" | "strikeout" | "ink" | "note" | "shape" | "freeText";

/**
 * The pending style applied to newly-created annotations, and (where
 * CONTRACTS' `AnnotPatch` actually supports it per-kind — see
 * `AnnotationToolbar.tsx`'s header comment) live-edited into a current
 * selection.
 */
export interface AnnotationStyle {
  /** `#rrggbb`. */
  color: string;
  /** 0-1. */
  opacity: number;
  /** PDF points; ink stroke width / shape stroke width. */
  strokeWidth: number;
  /** PDF points; freeText font size. */
  fontSize: number;
  /** Which shape a "shape" mode drag creates. */
  shapeKind: ShapeKind;
  /** Whether a drawn shape also gets a fill (at `color`, `fillOpacity`) or `fill: {color: null, ...}` (outline only). */
  filled: boolean;
  /** Fill opacity, independent of stroke opacity, when `filled` is true. */
  fillOpacity: number;
}

export const DEFAULT_ANNOTATION_STYLE: AnnotationStyle = {
  color: "#a3243a",
  opacity: 0.4,
  strokeWidth: 2,
  fontSize: 14,
  shapeKind: "rect",
  filled: false,
  fillOpacity: 0.2,
};

/** Preset swatches shown in the toolbar's color picker, alongside a native color input for anything else. */
export const COLOR_PRESETS: readonly string[] = ["#a3243a", "#f2c94c", "#1c6e4a", "#2f6fed", "#241c1a", "#ffffff"];

export const MARKUP_MODES = ["highlight", "underline", "strikeout"] as const;
export type MarkupMode = (typeof MARKUP_MODES)[number];

export function isMarkupMode(mode: AnnotationMode): mode is MarkupMode {
  return (MARKUP_MODES as readonly string[]).includes(mode);
}

// ---- AnnotPatch capability gaps (see AnnotationLayer.tsx's header comment) ----
//
// CONTRACTS' `AnnotPatch` is `{ color, opacity, contents, rect }` for every
// kind, but each `AnnotSpec` variant only actually carries a subset of those
// fields as a literal top-level key (`mock/annotations.ts`'s
// `applyAnnotPatch` checks `"color" in mutable` etc. before applying —
// anything else silently no-ops). These two helpers are the single source
// of truth for "can the toolbar live-edit this field on this selection",
// used to disable rather than silently ignore a control.

/** Whether `annot`'s kind has a top-level `color` field `AnnotPatch.color` can actually reach. Kind-based, not value-based — an annotation's own `color`/`opacity` value is never meaningfully absent once it exists, so this must not be confused with null-checking the value itself. */
export function canPatchColor(annot: Annot): boolean {
  return annot.kind === "highlight" || annot.kind === "underline" || annot.kind === "strikeout" || annot.kind === "freeText";
}

/** Same idea as `canPatchColor`, for `opacity`. */
export function canPatchOpacity(annot: Annot): boolean {
  return annot.kind === "highlight" || annot.kind === "underline" || annot.kind === "strikeout" || annot.kind === "ink";
}

/** Reads the current color for a kind `canPatchColor` allows — narrows the union so callers don't need their own exhaustive switch just to read one field. */
export function getPatchableColor(annot: Annot): string | null {
  if (!canPatchColor(annot)) return null;
  // Every branch `canPatchColor` accepts has a top-level `color: string`.
  return (annot as { color: string }).color;
}

/** Reads the current opacity for a kind `canPatchOpacity` allows. */
export function getPatchableOpacity(annot: Annot): number | null {
  if (!canPatchOpacity(annot)) return null;
  return (annot as { opacity: number | null }).opacity;
}
