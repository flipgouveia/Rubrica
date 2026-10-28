// Wires the annotate tool's markup modes (highlight/underline/strikeout) to the viewer's REAL
// text selection (`src/viewer/selection/selectionStore.ts`) — CONTRACTS' own AnnotSpec doc and
// `AnnotationLayer.tsx`'s own header comment are explicit that these three kinds are "created
// from a text selection, not a canvas drag", but until this file existed nothing in the app
// actually did that: `deriveQuadpointsFromSelectionRects` (this tool's own pure conversion
// function) was only ever called from `dev/AnnotateHarness.tsx`, against a hardcoded fake
// selection rect — highlight/underline/strikeout had no way to create a real annotation in the
// wired-up app at all. This is the real, non-simulated path: it reads the live selection, fetches
// each spanned page's real char layout, and creates one annotation per page the selection touches
// (an `AnnotSpec`'s `quadpoints` are scoped to a single page, so a selection spanning N pages
// becomes N `annot_add` calls, same as `redact`'s own per-page `redact_apply` constraint).
import { commands } from "../../ipc";
import type { AnnotSpec, QuadPoint, Rect, RubricaError } from "../../ipc/bindings";
import { selectionRangeForPage, useSelectionStore, type SelectionRange } from "../../viewer/selection/selectionStore";
import { buildHighlightRects } from "../../viewer/selection/highlightRects";
import { isMarkupMode, type AnnotationMode, type AnnotationStyle, type MarkupMode } from "./model";

/** A PDF-space `Rect` (lower-left origin, per `src/tools/shared/coords.ts`'s convention) to the four-corner `QuadPoint` the PDF spec (and `AnnotSpec`) expects: (x1,y1)=top-left, (x2,y2)=top-right, (x3,y3)=bottom-left, (x4,y4)=bottom-right. */
function rectToQuadPoint(rect: Rect): QuadPoint {
  const x = rect.x ?? 0;
  const y = rect.y ?? 0;
  const width = rect.width ?? 0;
  const height = rect.height ?? 0;
  return { x1: x, y1: y + height, x2: x + width, y2: y + height, x3: x, y3: y, x4: x + width, y4: y };
}

/** Whether `mode` is a markup kind AND there's a real, non-collapsed selection on `docId` to apply it to — gates the panel's "apply to selection" affordance. */
export function useCanApplyMarkupToSelection(docId: string, mode: AnnotationMode): boolean {
  const selection = useSelectionStore((s) => s.selection);
  if (!isMarkupMode(mode) || !selection || selection.docId !== docId) return false;
  return !(selection.anchor.page === selection.focus.page && selection.anchor.charIndex === selection.focus.charIndex);
}

/**
 * Creates one highlight/underline/strikeout annotation per page the current selection spans, then
 * clears the selection (matching a real PDF viewer's "select text, click Highlight" flow — the
 * selection's job is done once it's become a permanent mark). No-ops quietly (returns `ok: true`)
 * if there's nothing to apply (the panel button that calls this is only enabled when
 * `useCanApplyMarkupToSelection` is true, but a slow revision/selection race is possible, so this
 * re-checks rather than trusting the caller blindly).
 *
 * Stops at the first failed page (either `textPageLayout` or `annotAdd`) and returns its error
 * instead of silently treating it as "nothing on this page" — a real bug a review caught: this
 * used to fold a failed layout fetch into an empty page (skipping it as if the selection simply
 * didn't reach there) and never checked `annotAdd`'s own result at all, so a transient/backend
 * error looked exactly like a successful apply with some pages silently missing their mark, and
 * the selection was cleared either way with no way to tell anything had gone wrong or retry. Only
 * clears the selection once every spanned page has actually succeeded.
 */
export async function applyMarkupToSelection(docId: string, mode: MarkupMode, style: AnnotationStyle): Promise<{ ok: true } | { ok: false; error: RubricaError }> {
  const selection = useSelectionStore.getState().selection;
  if (!selection || selection.docId !== docId) return { ok: true };

  const pages = pagesSpannedBySelection(selection);
  for (const page of pages) {
    const layout = await commands.textPageLayout(docId, page);
    if (layout.status === "error") return { ok: false, error: layout.error };
    const range = selectionRangeForPage(selection, page, layout.data.length);
    if (!range) continue;
    const rects = buildHighlightRects(layout.data, range.start, range.end);
    if (rects.length === 0) continue;
    const quadpoints = rects.map(rectToQuadPoint);
    const spec: AnnotSpec = { kind: mode, page, quadpoints, color: style.color, opacity: style.opacity };
    const added = await commands.annotAdd(docId, spec);
    if (added.status === "error") return { ok: false, error: added.error };
  }

  useSelectionStore.getState().clearSelection();
  return { ok: true };
}

function pagesSpannedBySelection(selection: SelectionRange): number[] {
  const start = Math.min(selection.anchor.page, selection.focus.page);
  const end = Math.max(selection.anchor.page, selection.focus.page);
  const pages: number[] = [];
  for (let page = start; page <= end; page++) pages.push(page);
  return pages;
}
