import type { PageViewport } from "../../chrome/tool-api";
import type { CharBox } from "../../ipc/bindings";
import type { DocId } from "../types";
import { buildHighlightRects, toDisplayBands } from "./highlightRects";
import { selectionRangeForPage, useSelectionStore } from "./selectionStore";

interface SelectionOverlayProps {
  docId: DocId;
  page: number;
  viewport: PageViewport;
  boxes: CharBox[] | null;
}

/**
 * Visual-only highlight layer for the current text selection on one page: one band per visual
 * line, painted OPAQUE inside a single container that carries the alpha, so bands that still
 * touch can never stack into a darker seam (per-rect alpha would).
 */
export function SelectionOverlay({ docId, page, viewport, boxes }: SelectionOverlayProps) {
  const selection = useSelectionStore((s) => s.selection);
  if (!selection || selection.docId !== docId || !boxes) return null;
  const range = selectionRangeForPage(selection, page, boxes.length);
  if (!range) return null;
  const rects = toDisplayBands(buildHighlightRects(boxes, range.start, range.end));
  if (rects.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 opacity-30">
      {rects.map((rect, i) => {
        const topLeft = viewport.toScreen(rect.x ?? 0, (rect.y ?? 0) + (rect.height ?? 0));
        return (
          <div
            key={i}
            className="absolute bg-accent"
            style={{ left: topLeft.x, top: topLeft.y, width: (rect.width ?? 0) * viewport.zoom, height: (rect.height ?? 0) * viewport.zoom }}
          />
        );
      })}
    </div>
  );
}
