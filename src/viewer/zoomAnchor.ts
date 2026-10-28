// Scroll arithmetic for "zoom around a point": which scroll offsets keep the document point under
// the anchor (the cursor, or the top of the viewport) where it was. Page boxes scale with zoom but
// the gap between them does not, so this walks the pages instead of scaling the offset as a whole.

/** `listY`: a vertical position in the page list (0 = top of the first page), at zoom `from`. Returns where that point sits at zoom `to`. */
export function zoomedListY(pageHeights: readonly number[], gap: number, from: number, to: number, listY: number): number {
  if (listY < 0) return listY; // the padding above the first page does not scale
  let fromStart = 0;
  let toStart = 0;
  for (const height of pageHeights) {
    const fromHeight = height * from;
    if (listY < fromStart + fromHeight + gap) {
      const offset = listY - fromStart;
      // Inside the page it scales with it; inside the gap below it, the gap stays the same size.
      return toStart + (offset <= fromHeight ? offset * (to / from) : height * to + (offset - fromHeight));
    }
    fromStart += fromHeight + gap;
    toStart += height * to + gap;
  }
  return toStart + (listY - fromStart);
}

/**
 * New `scrollLeft` keeping the point at `viewportX` still. Pages are centred in rows at least as
 * wide as the scroller's content box, so the point is tracked relative to that centre.
 */
export function zoomedScrollLeft(
  widestPage: number,
  contentWidth: number,
  padding: number,
  from: number,
  to: number,
  scrollLeft: number,
  viewportX: number,
): number {
  const rowWidth = (zoom: number) => Math.max(contentWidth, widestPage * zoom);
  const fromOffset = scrollLeft + viewportX - (padding + rowWidth(from) / 2);
  return Math.max(0, padding + rowWidth(to) / 2 + fromOffset * (to / from) - viewportX);
}
