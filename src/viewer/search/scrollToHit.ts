// Brings a search hit's rect into view (B5). The geometry lives in `computeRectScroll`
// (viewer/store.ts); this file only finds the visible page scroller and applies the result.
import type { Rect, SearchHit } from "../../ipc/bindings";
import { computeRectScroll, getTabByDocId } from "../store";
import type { DocId } from "../types";

/** Height the compact bar needs kept clear at the top of the viewer (bar + its top offset). */
export const COMPACT_BAR_INSET = 64;
/** Breathing room above the hit when nothing overlays the viewer (docked panel). */
export const DOCKED_INSET = 8;

/** The scroller of the visible tab (every tab's viewer stays mounted, the inactive ones `hidden`). */
function visibleScroller(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[data-testid="viewer-scroll"]');
  for (const el of all) if (!el.closest("[hidden]")) return el;
  return null;
}

/**
 * Bounding box, in PDF points, of the part of a (possibly wrapped) hit that lies on `page` (the
 * hit's start page by default): the proximity window when there is one, else the term rects. A hit
 * that spans a page break only contributes its first page, so coordinates of two pages never mix.
 */
export function hitBounds(hit: SearchHit, page?: number): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const target = page ?? hit.windowRects[0]?.page ?? hit.rects[0]?.page;
  const onPage = hit.windowRects.filter((r) => r.page === target);
  const rectsOnPage = hit.rects.filter((r) => r.page === target);
  const pieces = onPage.length > 0 ? onPage : rectsOnPage.length > 0 ? rectsOnPage : hit.rects;
  for (const { rect } of pieces) {
    const x = rect.x ?? 0;
    const y = rect.y ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (rect.width ?? 0));
    maxY = Math.max(maxY, y + (rect.height ?? 0));
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function scrollToHit(docId: DocId, page: number, hit: SearchHit, topInset: number): void {
  const tab = getTabByDocId(docId);
  const scroller = visibleScroller();
  if (!tab || !scroller) return;
  const target = computeRectScroll({
    pages: tab.info.pages,
    zoom: tab.zoom,
    page,
    rect: hitBounds(hit, page),
    view: {
      width: scroller.clientWidth,
      height: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
    },
    topInset,
  });
  if (!target) return;
  scroller.scrollTop = target.top;
  scroller.scrollLeft = target.left;
}
