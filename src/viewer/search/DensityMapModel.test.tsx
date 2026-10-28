// Pure functions behind the density map: bucket grouping, log opacity, chapter ticks, the viewport
// rectangle and the active marker.
import { describe, expect, it } from "vitest";
import type { OutlineItem, PageSize } from "../../ipc/bindings";
import { VIEWER_PADDING, VIEWER_PAGE_GAP } from "../store";
import {
  MIN_BUCKET_OPACITY,
  activeMarkerPosition,
  bucketAtFraction,
  bucketOpacity,
  chapterTicks,
  computeBuckets,
  pageAtFraction,
  pageOffsets,
  pagesPerBucket,
  summarizeHits,
  viewportRect,
  yToPagePosition,
} from "./DensityMapModel";

const counts = (entries: Array<[number, number]>) => new Map(entries);

describe("pagesPerBucket", () => {
  it("is one page per bucket while the track has a pixel per page", () => {
    expect(pagesPerBucket(40, 600)).toBe(1);
    expect(pagesPerBucket(600, 600)).toBe(1);
  });
  it("groups pages when there is more than one page per pixel", () => {
    expect(pagesPerBucket(601, 600)).toBe(2);
    expect(pagesPerBucket(2500, 600)).toBe(5);
  });
  it("survives a zero-height track", () => {
    expect(pagesPerBucket(10, 0)).toBe(10);
  });
});

describe("bucketOpacity", () => {
  it("scales log(1+n) to the busiest bucket between the floor and 1", () => {
    expect(bucketOpacity(8, 8)).toBe(1);
    expect(bucketOpacity(1, 8)).toBeCloseTo(MIN_BUCKET_OPACITY + (1 - MIN_BUCKET_OPACITY) * (Math.log(2) / Math.log(9)), 10);
  });
  it("is logarithmic: a bucket with 10x fewer hits is far less than 10x lighter", () => {
    const ratio = (bucketOpacity(10, 100) - MIN_BUCKET_OPACITY) / (bucketOpacity(100, 100) - MIN_BUCKET_OPACITY);
    expect(ratio).toBeGreaterThan(0.4);
    expect(bucketOpacity(2, 100)).toBeLessThan(bucketOpacity(4, 100));
    expect(bucketOpacity(4, 100)).toBeLessThan(bucketOpacity(8, 100));
  });
  it("a lone single hit is still visible", () => {
    expect(bucketOpacity(1, 1)).toBe(1);
    expect(bucketOpacity(1, 1000)).toBeGreaterThanOrEqual(MIN_BUCKET_OPACITY);
  });
  it("is 0 for no hits", () => {
    expect(bucketOpacity(0, 5)).toBe(0);
  });
});

describe("computeBuckets", () => {
  it("makes one bucket per page that has hits, and none for the rest (out-of-scope pages)", () => {
    const buckets = computeBuckets({ pageCount: 40, counts: counts([[13, 1], [15, 3], [18, 1]]), trackHeightPx: 600 });
    expect(buckets.map((b) => [b.fromPage, b.toPage, b.count])).toEqual([
      [13, 13, 1],
      [15, 15, 3],
      [18, 18, 1],
    ]);
    expect(buckets.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(buckets[1].top).toBeCloseTo(15 / 40, 10);
    expect(buckets[1].height).toBeCloseTo(1 / 40, 10);
    expect(buckets[1].opacity).toBe(1); // the busiest
    expect(buckets[0].opacity).toBeLessThan(1);
  });

  it("ignores pages without hits, negative counts and pages outside the document", () => {
    const buckets = computeBuckets({ pageCount: 5, counts: counts([[0, 0], [2, -1], [9, 4], [-1, 2], [3, 2]]), trackHeightPx: 100 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ fromPage: 3, toPage: 3, count: 2 });
  });

  it("groups pages, summing their hits, when there is more than one page per pixel", () => {
    // 1000 pages on a 200px track -> 5 pages per bucket
    const buckets = computeBuckets({ pageCount: 1000, counts: counts([[0, 1], [4, 2], [5, 4], [999, 1]]), trackHeightPx: 200 });
    expect(buckets.map((b) => [b.fromPage, b.toPage, b.count])).toEqual([
      [0, 4, 3],
      [5, 9, 4],
      [995, 999, 1],
    ]);
    expect(buckets[2].top + buckets[2].height).toBeCloseTo(1, 10);
  });

  it("clips the last bucket at the end of the document", () => {
    const buckets = computeBuckets({ pageCount: 11, counts: counts([[10, 1]]), trackHeightPx: 5 }); // 3 pages per bucket
    expect(buckets[0]).toMatchObject({ fromPage: 9, toPage: 10 });
    expect(buckets[0].top + buckets[0].height).toBeCloseTo(1, 10);
  });

  it("is empty without hits or pages", () => {
    expect(computeBuckets({ pageCount: 10, counts: counts([]), trackHeightPx: 100 })).toEqual([]);
    expect(computeBuckets({ pageCount: 0, counts: counts([[0, 1]]), trackHeightPx: 100 })).toEqual([]);
  });
});

const item = (id: string, page: number | null, children: OutlineItem[] = [], depth = 0): OutlineItem => ({
  id,
  title: id,
  page,
  pageEnd: page,
  depth,
  children,
});

describe("chapterTicks", () => {
  it("places a tick at every top-level entry except the first page, ignoring sub-entries", () => {
    const outline = [item("0", 0, [item("0.0", 3, [], 1)]), item("1", 10), item("2", 25)];
    expect(chapterTicks(outline, 50)).toEqual([10 / 50, 25 / 50]);
  });
  it("skips entries without a page or outside the document and deduplicates", () => {
    const outline = [item("0", null), item("1", 4), item("2", 4), item("3", 99)];
    expect(chapterTicks(outline, 10)).toEqual([0.4]);
  });
  it("has no ticks without an outline", () => {
    expect(chapterTicks([], 10)).toEqual([]);
  });
});

describe("summarizeHits", () => {
  it("reports the total, the page span and the densest page (earliest on ties)", () => {
    expect(summarizeHits(counts([[13, 1], [15, 3], [18, 3], [14, 1]]))).toEqual({ total: 8, firstPage: 13, lastPage: 18, densestPage: 15 });
  });
  it("is null without hits", () => {
    expect(summarizeHits(counts([]))).toBeNull();
    expect(summarizeHits(counts([[2, 0]]))).toBeNull();
  });
});

describe("viewport rectangle", () => {
  const pages: PageSize[] = Array.from({ length: 10 }, () => ({ width: 600, height: 800 }));
  const zoom = 0.5; // 400px pages + the gap
  const size = 400 + VIEWER_PAGE_GAP;

  it("lays pages out like ViewerSurface: padding, then page height * zoom + gap", () => {
    const offsets = pageOffsets(pages, zoom);
    expect(offsets.tops[0]).toBe(0);
    expect(offsets.tops[3]).toBe(3 * size);
    expect(offsets.total).toBe(10 * size);
  });

  it("at the top of the scroller starts at page 0", () => {
    const rect = viewportRect({ pages, zoom, scrollTop: 0, clientHeight: 832 + VIEWER_PADDING })!;
    expect(rect.top).toBe(0);
    // 832 + padding px of scroller; the first VIEWER_PADDING are the top padding
    expect(rect.height).toBeCloseTo(((832 + VIEWER_PADDING - VIEWER_PADDING) / size) / 10, 10);
  });

  it("follows the scroll position in page units", () => {
    const rect = viewportRect({ pages, zoom, scrollTop: VIEWER_PADDING + 2.5 * size, clientHeight: size })!;
    expect(rect.top).toBeCloseTo(2.5 / 10, 10);
    expect(rect.height).toBeCloseTo(1 / 10, 10);
  });

  it("clamps at the end of the document", () => {
    const rect = viewportRect({ pages, zoom, scrollTop: 10 * size, clientHeight: 5000 })!;
    expect(rect.top + rect.height).toBeCloseTo(1, 10);
  });

  it("handles pages of different sizes (position is in pages, not pixels)", () => {
    const mixed: PageSize[] = [{ width: 600, height: 800 }, { width: 600, height: 200 }, { width: 600, height: 800 }];
    const offsets = pageOffsets(mixed, 1);
    expect(yToPagePosition(offsets, 800 + VIEWER_PAGE_GAP + (200 + VIEWER_PAGE_GAP) / 2)).toBeCloseTo(1.5, 10);
  });

  it("is null without pages or a measured scroller", () => {
    expect(viewportRect({ pages: [], zoom, scrollTop: 0, clientHeight: 100 })).toBeNull();
    expect(viewportRect({ pages, zoom, scrollTop: 0, clientHeight: 0 })).toBeNull();
  });
});

describe("activeMarkerPosition", () => {
  it("points at the middle of the page", () => {
    expect(activeMarkerPosition(16, 40)).toBeCloseTo(16.5 / 40, 10);
  });
  it("is null for a page outside the document", () => {
    expect(activeMarkerPosition(40, 40)).toBeNull();
    expect(activeMarkerPosition(-1, 40)).toBeNull();
  });
});

describe("pointer hit-testing", () => {
  const buckets = computeBuckets({ pageCount: 100, counts: counts([[10, 1], [50, 2]]), trackHeightPx: 1000 });
  it("finds the bucket under the pointer or the nearest within the tolerance", () => {
    expect(bucketAtFraction(buckets, 0.105, 1000)?.fromPage).toBe(10);
    expect(bucketAtFraction(buckets, 0.112, 1000)?.fromPage).toBe(10); // 1px under the bucket's end... within 4px
    expect(bucketAtFraction(buckets, 0.3, 1000)).toBeNull();
  });
  it("maps a fraction to a page", () => {
    expect(pageAtFraction(0.505, 100)).toBe(50);
    expect(pageAtFraction(1.2, 100)).toBe(99);
    expect(pageAtFraction(-0.2, 100)).toBe(0);
  });
});
