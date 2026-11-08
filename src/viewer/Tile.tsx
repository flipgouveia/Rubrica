// One 512x512 tile (CONTRACTS §3 render protocol). A dedicated component (rather than resolving
// the URL inline in TileLayer's map) so each tile can independently `useState`/`useEffect` its
// own async load against the mock's synthetic latency (src/ipc/mock/render.ts) — TileLayer's own
// tile *count* changes with zoom, which would violate rules-of-hooks if the per-tile hook lived
// directly in that loop.
//
// While its image is still loading the tile registers in tileLoadingStore, which drives the one
// "rendering" wheel the viewer shows per document (TileLoadingIndicator). The tile itself draws
// nothing extra, so the page stays plain white and fast tiles cause no flicker.
import { useEffect, useState } from "react";
import { isMockEngine, mockTileUrlAsync, realTileUrl } from "../ipc";
import { TRANSPARENT_PIXEL } from "./blankPixel";
import { useTileLoadingStore } from "./tileLoadingStore";
import type { DocId } from "./types";

const TILE_SIZE = 512;

interface TileProps {
  docId: DocId;
  page: number;
  bucket: number;
  x: number;
  y: number;
  revision: number;
  scale: number;
}

export function Tile({ docId, page, bucket, x, y, revision, scale }: TileProps) {
  const [src, setSrc] = useState<string | null>(() => (isMockEngine ? null : realTileUrl(docId, page, bucket, x, y, revision)));
  // Which image URL has finished (or failed). "Loaded" is derived from it rather than reset in an
  // effect, so a tile whose URL is already cached never renders an extra "loading" frame.
  const [settledKey, setSettledKey] = useState<string | null>(null);

  useEffect(() => {
    if (!isMockEngine) {
      setSrc(realTileUrl(docId, page, bucket, x, y, revision));
      return;
    }
    let cancelled = false;
    setSrc(null);
    void mockTileUrlAsync(docId, page, bucket, x, y, revision).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [docId, page, bucket, x, y, revision]);

  // `||`, not `??`: a canvas-less environment (jsdom in tests) makes the mock draw resolve
  // to `""` rather than throwing, which should fall back the same as "not loaded yet".
  const realSrc = src || null;
  const key = realSrc ?? "__pending__";
  const loaded = settledKey === key;

  // Counted as pending for exactly as long as it is not loaded (also released on unmount).
  useEffect(() => {
    if (loaded) return undefined;
    useTileLoadingStore.getState().begin(docId);
    return () => useTileLoadingStore.getState().end(docId);
  }, [loaded, docId]);

  return (
    <img
      src={realSrc ?? TRANSPARENT_PIXEL}
      alt=""
      draggable={false}
      className="absolute select-none"
      style={{ left: x * TILE_SIZE * scale, top: y * TILE_SIZE * scale, width: TILE_SIZE * scale, height: TILE_SIZE * scale }}
      onLoad={() => {
        // The transparent stand-in also fires `load`; only a real tile settles it.
        if (realSrc) setSettledKey(key);
      }}
      onError={() => setSettledKey(key)}
    />
  );
}
