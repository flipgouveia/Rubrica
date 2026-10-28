// One page's worth of the viewer surface: tiles + selection/search highlight layers + whatever
// tool overlays are currently active (TOOL-API.md). Owns the page's DOM "coordinate anchor" —
// the `data-*` attributes here are what cross-page drag-selection (useTextSelectionHandlers)
// and, later, tool overlays reading `document.elementFromPoint` rely on.
import { useMemo } from "react";
import { makePageViewport, useOverlayTools } from "../chrome/tool-api";
import type { DocId } from "./types";
import { useNightModeStore, nightModeFilter } from "./nightModeStore";
import { TileLayer } from "./TileLayer";
import { SelectionOverlay } from "./selection/SelectionOverlay";
import { useTextSelectionHandlers } from "./selection/useTextSelectionHandlers";
import { usePageTextLayout } from "./selection/textLayoutCache";
import { SearchHighlights } from "./search/SearchHighlights";
import { useActiveToolId } from "../chrome/tool-api";

interface PageCanvasProps {
  docId: DocId;
  page: number;
  widthPt: number;
  heightPt: number;
  zoom: number;
  rotation: number;
  revision: number;
}

export function PageCanvas({ docId, page, widthPt, heightPt, zoom, rotation, revision }: PageCanvasProps) {
  const displayWidth = widthPt * zoom;
  const displayHeight = heightPt * zoom;
  const nightEnabled = useNightModeStore((s) => s.enabled);
  const nightStyle = useNightModeStore((s) => s.style);
  const filter = nightModeFilter(nightEnabled, nightStyle);
  const overlayTools = useOverlayTools();
  const activeToolId = useActiveToolId();

  const viewport = useMemo(
    () => makePageViewport(docId, page, widthPt, heightPt, zoom, rotation),
    [docId, page, widthPt, heightPt, zoom, rotation],
  );
  const textBoxes = usePageTextLayout(docId, page, revision);
  const { onMouseDown } = useTextSelectionHandlers(docId, page, revision, viewport, textBoxes);

  return (
    <div
      className="relative bg-white shadow-md"
      style={{ width: displayWidth, height: displayHeight }}
      data-page-index={page}
      data-doc-id={docId}
      data-width-pt={widthPt}
      data-height-pt={heightPt}
      data-zoom={zoom}
    >
      <div className="absolute inset-0" style={{ filter }}>
        <TileLayer docId={docId} page={page} widthPt={widthPt} heightPt={heightPt} zoom={zoom} revision={revision} />
      </div>
      <SelectionOverlay docId={docId} page={page} viewport={viewport} boxes={textBoxes} />
      <SearchHighlights page={page} viewport={viewport} />
      <div className={activeToolId ? "absolute inset-0" : "absolute inset-0 cursor-text"} onMouseDown={activeToolId ? undefined : onMouseDown} />
      {overlayTools.map(({ tool, isActive }) => {
        const Overlay = tool.overlayLayer;
        return Overlay ? <Overlay key={tool.id} viewport={viewport} isActive={isActive} /> : null;
      })}
    </div>
  );
}
