// Mouse-driven text selection (brief item 1: "selection overlay ... mouse + keyboard, copy").
// Selection can cross pages: while dragging, `document.elementFromPoint` finds whichever page
// element is under the cursor (identified by the `data-page-index`/`data-doc-id`/... attributes
// PageCanvas sets on its root), so this hook only needs to be wired to the page the drag started
// on — dragging into a neighboring page "just works" via the DOM, no cross-component drag state.
import { useCallback } from "react";
import type { PageViewport } from "../../chrome/tool-api";
import { makePageViewport } from "../../chrome/tool-api";
import type { CharBox } from "../../ipc/bindings";
import type { DocId } from "../types";
import { useSelectionStore } from "./selectionStore";
import { fetchPageTextLayout, getCachedPageTextLayout } from "./textLayoutCache";
import { nearestCharIndex } from "./nearestCharIndex";

/** `boxes` is this page's own (already-fetched, e.g. via `usePageTextLayout`) text layout. */
export function useTextSelectionHandlers(docId: DocId, page: number, revision: number, viewport: PageViewport, boxes: CharBox[] | null) {
  const startSelection = useSelectionStore((s) => s.startSelection);
  const extendSelection = useSelectionStore((s) => s.extendSelection);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !boxes) return;
      const containerRect = e.currentTarget.getBoundingClientRect();
      const { x, y } = viewport.toDoc(e.clientX - containerRect.left, e.clientY - containerRect.top);
      startSelection(docId, page, nearestCharIndex(boxes, x, y));

      const handleMove = (moveEvent: MouseEvent): void => {
        const pageEl = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-page-index]");
        if (!pageEl || pageEl.dataset.docId !== docId) return;
        const targetPage = Number(pageEl.dataset.pageIndex);
        const widthPt = Number(pageEl.dataset.widthPt);
        const heightPt = Number(pageEl.dataset.heightPt);
        const zoom = Number(pageEl.dataset.zoom);
        if ([targetPage, widthPt, heightPt, zoom].some((n) => Number.isNaN(n))) return;

        const targetBoxes = getCachedPageTextLayout(docId, targetPage, revision);
        if (!targetBoxes) {
          void fetchPageTextLayout(docId, targetPage, revision);
          return;
        }
        const targetViewport: PageViewport = makePageViewport(docId, targetPage, widthPt, heightPt, zoom, 0);
        const rect = pageEl.getBoundingClientRect();
        const point = targetViewport.toDoc(moveEvent.clientX - rect.left, moveEvent.clientY - rect.top);
        extendSelection(targetPage, nearestCharIndex(targetBoxes, point.x, point.y));
      };
      const handleUp = (): void => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [boxes, docId, page, revision, viewport, startSelection, extendSelection],
  );

  return { onMouseDown };
}
