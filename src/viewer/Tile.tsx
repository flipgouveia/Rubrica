// One 512x512 tile (CONTRACTS §3 render protocol). A dedicated component (rather than resolving
// the URL inline in TileLayer's map) so each tile can independently `useState`/`useEffect` its
// own async load against the mock's synthetic latency (src/ipc/mock/render.ts) — TileLayer's own
// tile *count* changes with zoom, which would violate rules-of-hooks if the per-tile hook lived
// directly in that loop.
import { useEffect, useState } from "react";
import { isMockEngine, mockTileUrlAsync, realTileUrl } from "../ipc";
import { TRANSPARENT_PIXEL } from "./blankPixel";
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

  return (
    <img
      // `||`, not `??`: a canvas-less environment (jsdom in tests) makes the mock draw resolve
      // to `""` rather than throwing, which should fall back the same as "not loaded yet".
      src={src || TRANSPARENT_PIXEL}
      alt=""
      draggable={false}
      className="absolute select-none bg-border/30"
      style={{ left: x * TILE_SIZE * scale, top: y * TILE_SIZE * scale, width: TILE_SIZE * scale, height: TILE_SIZE * scale }}
    />
  );
}
