// Pure conversion from an active text selection to candidate redaction rects (brief item 1b:
// "from the current text selection"). Deliberately dependency-free from React/IPC/the store
// (mirrors `tools/annotate/selection.ts`'s style) so this is directly unit-testable — `actions.ts`
// is the thin IO wrapper that fetches each page's `CharBox[]` via the real `text_page_layout`
// command and feeds it through here.
import type { CharBox, Rect } from "../../ipc/bindings";
import { buildHighlightRects } from "../../viewer/selection/highlightRects";
import { isCollapsed, normalizeSelection, selectionRangeForPage, type SelectionRange } from "../../viewer/selection/selectionStore";
import type { DocId } from "../../viewer/types";

/** Every page index the selection touches, start to end inclusive (matches `selectionRangeForPage`'s own page-range semantics — a selection can span pages when anchor and focus land on different ones). */
export function pagesSpannedBySelection(selection: SelectionRange): number[] {
  const { startPage, endPage } = normalizeSelection(selection);
  const pages: number[] = [];
  for (let page = startPage; page <= endPage; page++) pages.push(page);
  return pages;
}

/** One rect per visual row of the selection on `page` (via `selectionRangeForPage` + `buildHighlightRects`, exactly like the viewer's own `SelectionOverlay.tsx` renders highlights), or `[]` if the selection doesn't touch this page. */
export function computeMarkRectsForPage(selection: SelectionRange, page: number, boxes: CharBox[]): Rect[] {
  const range = selectionRangeForPage(selection, page, boxes.length);
  if (!range) return [];
  return buildHighlightRects(boxes, range.start, range.end);
}

export interface SelectionMark {
  page: number;
  rect: Rect;
}

/**
 * Converts `selection` (if non-null, non-collapsed, and belonging to `docId`) into candidate
 * redaction rects across every page it spans. `fetchPageLayout` is injected so this stays
 * testable without a real IPC round-trip — `actions.ts` passes a `commands.textPageLayout`
 * wrapper in production. Pages are fetched and processed in order, not concurrently, so the
 * returned marks are in a stable, predictable (page, row) order.
 */
export async function computeMarksFromSelection(
  docId: DocId,
  selection: SelectionRange | null,
  fetchPageLayout: (page: number) => Promise<CharBox[]>,
): Promise<SelectionMark[]> {
  if (!selection || selection.docId !== docId || isCollapsed(selection)) return [];
  const marks: SelectionMark[] = [];
  for (const page of pagesSpannedBySelection(selection)) {
    const boxes = await fetchPageLayout(page);
    for (const rect of computeMarkRectsForPage(selection, page, boxes)) {
      marks.push({ page, rect });
    }
  }
  return marks;
}
