// The redact tool's overlay (TOOL-API.md's `overlayLayer` slot, brief item 1a): renders every
// pending mark on this page as a semi-transparent rect with a remove (x) control, and — while
// this tool is the active one — turns a click-drag on empty space into a new pending mark
// (mirrors `tools/annotate/AnnotationLayer.tsx`'s shape-drag interaction, simplified to the one
// gesture this tool needs: draw a rect, release to commit it as *pending*, not yet applied to the
// document).
//
// `overlayAlwaysOn` is set on this tool's registration (`index.ts`) so pending marks stay visible
// even while another tool is briefly active — a user shouldn't lose track of an unapplied
// redaction just by clicking over to, say, the pages tool. `isActive` gates the parts that would
// otherwise be confusing to leave live in that state: drawing a new mark, and the per-mark remove
// control (both only make sense while this tool is the one actually driving the page).
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { ToolOverlayProps } from "../../chrome/tool-api";
import { clampRectToPage, docRectToScreen, isDragBigEnough, normalizeScreenRect, screenRectToDoc, type ScreenPoint } from "./geometry";
import { useMarksForPage, useRedactStore } from "./model";

/**
 * `setPointerCapture` can throw (`NotFoundError`) if the browser no longer considers the given
 * pointer id "active" — see `tools/annotate/AnnotationLayer.tsx`'s identical guard for the full
 * explanation. The capture is a nice-to-have (keeps the drag receiving events past the SVG's own
 * bounds), so a failure here shouldn't abort the drag already recorded in local state.
 */
function safeSetPointerCapture(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Ignored — see comment above.
  }
}

export function RedactOverlay({ viewport, isActive }: ToolOverlayProps) {
  const { t } = useTranslation("tools-redact");
  const marks = useMarksForPage(viewport.docId, viewport.page);
  const addMark = useRedactStore((state) => state.addMark);
  const removeMark = useRedactStore((state) => state.removeMark);

  const containerRef = useRef<HTMLDivElement>(null);
  // The authoritative "is a drag in progress, and where did it start" state lives in a ref, not
  // `useState` — mirrors `tools/annotate/AnnotationLayer.tsx`'s `interactionRef`. A ref is
  // mutated synchronously and read back immediately by the very next event handler invocation,
  // regardless of whether React has re-rendered/committed yet; `useState` here would go stale
  // between two pointer events that land in the same task (React 18's automatic batching), which
  // is exactly the shape of a fast real-world drag as well as of a synchronous test dispatch.
  // `dragCurrent` stays `useState` since it only drives the *visual* preview rect, not any
  // decision logic.
  const dragStartRef = useRef<ScreenPoint | null>(null);
  const [dragCurrent, setDragCurrent] = useState<ScreenPoint | null>(null);

  const widthPx = viewport.widthPt * viewport.zoom;
  const heightPx = viewport.heightPt * viewport.zoom;

  function toLocalPoint(event: { clientX: number; clientY: number }): ScreenPoint {
    const bounds = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
  }

  function cancelDrag(): void {
    dragStartRef.current = null;
    setDragCurrent(null);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!isActive || event.button !== 0) return;
    const point = toLocalPoint(event);
    dragStartRef.current = point;
    setDragCurrent(point);
    safeSetPointerCapture(event.currentTarget, event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!dragStartRef.current) return;
    setDragCurrent(toLocalPoint(event));
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>): void {
    const start = dragStartRef.current;
    if (!start) return;
    const finalScreenRect = clampRectToPage(normalizeScreenRect(start, toLocalPoint(event)), widthPx, heightPx);
    cancelDrag();
    if (!isDragBigEnough(finalScreenRect)) return;
    addMark(viewport.docId, viewport.page, screenRectToDoc(finalScreenRect, viewport));
  }

  const previewRect = dragStartRef.current && dragCurrent ? clampRectToPage(normalizeScreenRect(dragStartRef.current, dragCurrent), widthPx, heightPx) : null;

  return (
    // `overlayAlwaysOn` (index.ts) means this renders on every page regardless of which tool is
    // actually active, stacked in DOM order above whatever that other tool's own overlay rendered
    // (TOOL-API.md doesn't define a z-index convention between tools, so later-registered/later-
    // mounted wins by default stacking) — without `pointer-events: none` here when `!isActive`,
    // this wrapper (not just its `<svg>`, which already guards itself the same way below) would
    // silently swallow every click meant for the actually-active tool underneath it. Confirmed as
    // a real bug during manual cross-tool verification, not a hypothetical: the text-edit tool's
    // run-selection clicks landed on this div instead, every time, whenever both tools were
    // registered together.
    <div
      ref={containerRef}
      className="absolute left-0 top-0"
      style={{ width: widthPx, height: heightPx, pointerEvents: isActive ? "auto" : "none" }}
    >
      <svg
        width={widthPx}
        height={heightPx}
        className="absolute left-0 top-0"
        style={{ touchAction: "none", cursor: isActive ? "crosshair" : "default", pointerEvents: isActive ? "auto" : "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelDrag}
        role="img"
        aria-label={t("tools-redact.overlay.ariaLabel")}
      >
        {marks.map((mark) => {
          const screenRect = docRectToScreen(mark.rect, viewport);
          return (
            <rect
              key={mark.id}
              x={screenRect.x}
              y={screenRect.y}
              width={screenRect.width}
              height={screenRect.height}
              className="fill-danger/35 stroke-danger"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          );
        })}

        {previewRect && (
          <rect
            x={previewRect.x}
            y={previewRect.y}
            width={previewRect.width}
            height={previewRect.height}
            className="fill-danger/20 stroke-danger"
            strokeDasharray="4 3"
          />
        )}
      </svg>

      {isActive &&
        marks.map((mark) => {
          const screenRect = docRectToScreen(mark.rect, viewport);
          return (
            <button
              key={mark.id}
              type="button"
              aria-label={t("tools-redact.overlay.removeMark")}
              className="absolute flex h-5 w-5 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-danger bg-surface text-danger shadow-sm hover:bg-danger hover:text-danger-foreground"
              style={{ left: screenRect.x + screenRect.width, top: screenRect.y }}
              onClick={() => removeMark(viewport.docId, mark.id)}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          );
        })}
    </div>
  );
}
