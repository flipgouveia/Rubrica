// Shared small types used across viewer + chrome. `DocId` mirrors CONTRACTS §2's `type DocId =
// string` — the generated bindings inline `string` everywhere a docId is used instead of
// exporting a named alias, so this is the one place that names it for readability at call sites.
export type DocId = string;

export const ZOOM_BUCKETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export type ZoomBucket = (typeof ZOOM_BUCKETS)[number];

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;

/** Smallest render bucket that is >= `zoom`, so tiles are never blurrier than requested (CONTRACTS §3). */
export function nearestBucket(zoom: number): ZoomBucket {
  for (const bucket of ZOOM_BUCKETS) {
    if (bucket >= zoom) return bucket;
  }
  return ZOOM_BUCKETS[ZOOM_BUCKETS.length - 1];
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
