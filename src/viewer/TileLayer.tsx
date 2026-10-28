// Composes a page's visible area out of 512x512 tiles from the render protocol (CONTRACTS §3:
// `rubrica-tile://<docId>/<page>/<zoomBucket>/<x>/<y>?rev=<revision>`, buckets 0.5/0.75/1/1.25/
// 1.5/2/3/4). Tiles are always requested at the nearest bucket >= the continuous UI zoom, then
// scaled via CSS to the exact zoom — this is what makes zoom feel continuous while the tile
// cache (real backend) and the mock's placeholder canvas both stay keyed to a small, fixed set
// of resolutions instead of one per arbitrary zoom percentage.
import { useMemo } from "react";
import { Tile } from "./Tile";
import type { DocId } from "./types";
import { nearestBucket } from "./types";

const TILE_SIZE = 512;

interface TileLayerProps {
  docId: DocId;
  page: number;
  widthPt: number;
  heightPt: number;
  zoom: number;
  revision: number;
}

export function TileLayer({ docId, page, widthPt, heightPt, zoom, revision }: TileLayerProps) {
  const bucket = nearestBucket(zoom);
  const scale = zoom / bucket;

  const tiles = useMemo(() => {
    const pxWidth = widthPt * bucket;
    const pxHeight = heightPt * bucket;
    const tilesX = Math.max(1, Math.ceil(pxWidth / TILE_SIZE));
    const tilesY = Math.max(1, Math.ceil(pxHeight / TILE_SIZE));
    const grid: { x: number; y: number }[] = [];
    for (let y = 0; y < tilesY; y++) {
      for (let x = 0; x < tilesX; x++) grid.push({ x, y });
    }
    return grid;
  }, [widthPt, heightPt, bucket]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-white">
      {tiles.map(({ x, y }) => (
        <Tile key={`${x}-${y}-${bucket}`} docId={docId} page={page} bucket={bucket} x={x} y={y} revision={revision} scale={scale} />
      ))}
    </div>
  );
}
