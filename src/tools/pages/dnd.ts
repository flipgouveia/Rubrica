// Pure drag-reorder math for the pages tool (brief item 2, `pages_reorder`).
//
// Deliberately DOM- and React-free so it is unit-testable with fabricated
// rects/points, independent of jsdom's lack of real layout (jsdom always
// reports zero-size `getBoundingClientRect()` results unless a test stubs
// it). `PagesPanel` is the only caller: it feeds real `getBoundingClientRect()`
// rects from the live thumbnail grid into `computeDropIndex`, then hands the
// result to `buildReorderedIndices` to build the `order` array required by
// `commands.pagesReorder(docId, order)` (CONTRACTS §3 — a full permutation,
// "old-index-at-each-new-position").

/** A `DOMRect`-compatible shape — only the four edges this module needs. */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PointLike {
  x: number;
  y: number;
}

/**
 * Given the pointer's current position and the bounding rects of every
 * thumbnail in its CURRENT display order, returns the "gap" index the
 * dragged item would land in if dropped now — an integer in `[0,
 * thumbnailRects.length]` (N items have N+1 gaps: before the first, between
 * each pair, after the last).
 *
 * The dragged item's own rect is excluded from the closest-match search
 * (comparing against your own rect while it is still sitting in its
 * original slot produces jittery results right after picking it up). Its
 * index is still a perfectly valid *answer*, though: landing back on either
 * edge of your own slot is a legitimate (no-op) result, resolved by
 * `buildReorderedIndices`, not filtered out here.
 *
 * Row-wrapping grids are supported via a simple, deterministic heuristic:
 * find the rect whose center is geometrically closest to the pointer, then
 * decide before/after that rect — by row (pointer above/below its vertical
 * span) when the pointer has left the row entirely, else by column (left
 * half vs. right half of that rect).
 */
export function computeDropIndex(
  pointerPos: PointLike,
  thumbnailRects: RectLike[],
  draggedIndex: number,
): number {
  const count = thumbnailRects.length;
  if (count === 0) return 0;

  let closestIndex = -1;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    if (i === draggedIndex) continue;
    const rect = thumbnailRects[i];
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const distance = Math.hypot(pointerPos.x - cx, pointerPos.y - cy);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = i;
    }
  }

  // Only the dragged item exists (a single-page document mid-drag, or a
  // grid with everything else filtered out) — any drop is necessarily a
  // no-op, so any in-range answer is correct; the dragged item's own index
  // is the simplest one.
  if (closestIndex === -1) return draggedIndex;

  const rect = thumbnailRects[closestIndex];
  const centerX = (rect.left + rect.right) / 2;

  let before: boolean;
  if (pointerPos.y < rect.top) {
    before = true; // above this row entirely
  } else if (pointerPos.y > rect.bottom) {
    before = false; // below this row entirely
  } else {
    before = pointerPos.x < centerX; // same row: left half vs. right half
  }

  return before ? closestIndex : closestIndex + 1;
}

/**
 * Moves the element currently at `fromIndex` so it lands at drop-gap
 * `toIndex` (0..order.length, as returned by `computeDropIndex`), returning
 * a NEW array — the exact permutation to pass to `commands.pagesReorder`.
 *
 * Dropping into either gap immediately adjacent to the dragged item's own
 * position (`toIndex === fromIndex` or `toIndex === fromIndex + 1`) is a
 * no-op: the resulting order is identical to `order`, so an (unchanged
 * value, but freshly copied) array is returned rather than special-cased
 * away — callers that want to skip the IPC call entirely on a no-op should
 * compare the result against `order` themselves.
 *
 * `fromIndex` out of `[0, order.length)` is treated as "nothing to move"
 * and returns a copy of `order` unchanged.
 */
export function buildReorderedIndices(order: number[], fromIndex: number, toIndex: number): number[] {
  const count = order.length;
  if (fromIndex < 0 || fromIndex >= count) return order.slice();

  const clampedTo = Math.max(0, Math.min(toIndex, count));
  if (clampedTo === fromIndex || clampedTo === fromIndex + 1) return order.slice();

  const result = order.slice();
  const [moved] = result.splice(fromIndex, 1);
  const insertAt = clampedTo > fromIndex ? clampedTo - 1 : clampedTo;
  result.splice(insertAt, 0, moved);
  return result;
}
