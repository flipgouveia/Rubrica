// Pure model of the density map (docs/mockups/search-v2.html, "Mapa de densidade"): which buckets
// to draw for a strip of a given height, how dark each one is, where the chapter ticks, the
// viewport rectangle and the active-hit marker go. Everything here is plain data in / plain data
// out so it can be tested without a DOM; `DensityMap.tsx` only renders it.
//
// Positions are fractions (0..1) of the strip's track, measured in PAGES (not in scrolled pixels):
// a bucket is one page (or a run of pages when there is more than one page per pixel), so the
// strip has the same page-proportional geometry whatever the page sizes are.
import type { OutlineItem, PageSize } from "../../ipc/bindings";
import { VIEWER_PADDING, VIEWER_PAGE_GAP } from "../store";

/** Lowest opacity of a non-empty bucket, so a single hit is still visible next to a dense one. */
export const MIN_BUCKET_OPACITY = 0.25;

export interface DensityBucket {
  /** Position in the (sparse) list of buckets with hits, 0-based. */
  index: number;
  /** First and last page (0-based, inclusive) covered by the bucket. */
  fromPage: number;
  toPage: number;
  /** Number of hits that start on those pages. */
  count: number;
  /** Fractions of the track height. */
  top: number;
  height: number;
  opacity: number;
}

/** One page per bucket, unless the track has fewer pixels than the document has pages. */
export function pagesPerBucket(pageCount: number, trackHeightPx: number): number {
  return Math.max(1, Math.ceil(pageCount / Math.max(1, Math.floor(trackHeightPx))));
}

/** `log(1 + n)` scaled to the busiest bucket, mapped onto [MIN_BUCKET_OPACITY, 1]. */
export function bucketOpacity(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  const scaled = Math.log1p(count) / Math.log1p(maxCount);
  return MIN_BUCKET_OPACITY + (1 - MIN_BUCKET_OPACITY) * Math.min(1, scaled);
}

/**
 * Buckets with at least one hit (pages without hits, e.g. everything outside the search scope,
 * have no bucket). `counts` maps a 0-based page to the number of hits starting on it.
 */
export function computeBuckets(input: {
  pageCount: number;
  counts: ReadonlyMap<number, number>;
  trackHeightPx: number;
}): DensityBucket[] {
  const { pageCount, counts, trackHeightPx } = input;
  if (pageCount <= 0) return [];
  const perBucket = pagesPerBucket(pageCount, trackHeightPx);
  const totals = new Map<number, number>();
  for (const [page, count] of counts) {
    if (count <= 0 || page < 0 || page >= pageCount) continue;
    const key = Math.floor(page / perBucket);
    totals.set(key, (totals.get(key) ?? 0) + count);
  }
  const keys = [...totals.keys()].sort((a, b) => a - b);
  const max = Math.max(0, ...totals.values());
  return keys.map((key, index) => {
    const fromPage = key * perBucket;
    const toPage = Math.min(pageCount, fromPage + perBucket) - 1;
    const count = totals.get(key) ?? 0;
    return {
      index,
      fromPage,
      toPage,
      count,
      top: fromPage / pageCount,
      height: (toPage - fromPage + 1) / pageCount,
      opacity: bucketOpacity(count, max),
    };
  });
}

/** Fractions of the track where a top-level (chapter) entry starts. The first page needs no tick. */
export function chapterTicks(items: readonly OutlineItem[], pageCount: number): number[] {
  if (pageCount <= 0) return [];
  const pages = new Set<number>();
  for (const item of items) {
    if (item.page !== null && item.page > 0 && item.page < pageCount) pages.add(item.page);
  }
  return [...pages].sort((a, b) => a - b).map((page) => page / pageCount);
}

export interface HitsSummary {
  total: number;
  /** 0-based first and last page with hits, and the page with the most hits (first one on ties). */
  firstPage: number;
  lastPage: number;
  densestPage: number;
}

export function summarizeHits(counts: ReadonlyMap<number, number>): HitsSummary | null {
  let total = 0;
  let firstPage = Infinity;
  let lastPage = -Infinity;
  let densestPage = -1;
  let densest = 0;
  for (const [page, count] of counts) {
    if (count <= 0) continue;
    total += count;
    firstPage = Math.min(firstPage, page);
    lastPage = Math.max(lastPage, page);
    if (count > densest || (count === densest && page < densestPage)) {
      densest = count;
      densestPage = page;
    }
  }
  return total === 0 ? null : { total, firstPage, lastPage, densestPage };
}

/** Top of every page in the scroller's page column (padding excluded), plus the column height. */
export function pageOffsets(pages: readonly PageSize[], zoom: number): { tops: number[]; total: number } {
  const tops: number[] = [];
  let y = 0;
  for (const page of pages) {
    tops.push(y);
    y += (page.height ?? 792) * zoom + VIEWER_PAGE_GAP;
  }
  return { tops, total: y };
}

/** Fractional page index (0..pageCount) at a y offset inside the page column. */
export function yToPagePosition(offsets: { tops: readonly number[]; total: number }, y: number): number {
  const { tops, total } = offsets;
  const count = tops.length;
  if (count === 0 || y <= 0) return 0;
  if (y >= total) return count;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  const end = lo + 1 < count ? tops[lo + 1] : total;
  return lo + (y - tops[lo]) / (end - tops[lo]);
}

export interface ViewportRect {
  top: number;
  height: number;
}

/** The part of the document the scroller shows, as a rectangle on the track (fractions). */
export function viewportRect(input: {
  pages: readonly PageSize[];
  zoom: number;
  scrollTop: number;
  clientHeight: number;
}): ViewportRect | null {
  const { pages, zoom, scrollTop, clientHeight } = input;
  if (pages.length === 0 || clientHeight <= 0) return null;
  const offsets = pageOffsets(pages, zoom);
  const start = yToPagePosition(offsets, scrollTop - VIEWER_PADDING);
  const end = yToPagePosition(offsets, scrollTop - VIEWER_PADDING + clientHeight);
  return { top: start / pages.length, height: Math.max(0, end - start) / pages.length };
}

/** Where the active-hit triangle points: the middle of its page. */
export function activeMarkerPosition(page: number, pageCount: number): number | null {
  if (pageCount <= 0 || page < 0 || page >= pageCount) return null;
  return (page + 0.5) / pageCount;
}

/** The bucket under a pointer at `fraction` of the track, or the closest one within `tolerancePx`. */
export function bucketAtFraction(
  buckets: readonly DensityBucket[],
  fraction: number,
  trackHeightPx: number,
  tolerancePx = 4,
): DensityBucket | null {
  let best: DensityBucket | null = null;
  let bestDistance = Infinity;
  for (const bucket of buckets) {
    const distance =
      fraction < bucket.top
        ? bucket.top - fraction
        : fraction > bucket.top + bucket.height
          ? fraction - (bucket.top + bucket.height)
          : 0;
    if (distance < bestDistance) {
      best = bucket;
      bestDistance = distance;
    }
  }
  return best && bestDistance * trackHeightPx <= tolerancePx ? best : null;
}

/** The page at `fraction` of the track (0-based, clamped). */
export function pageAtFraction(fraction: number, pageCount: number): number {
  return Math.min(pageCount - 1, Math.max(0, Math.floor(fraction * pageCount)));
}
