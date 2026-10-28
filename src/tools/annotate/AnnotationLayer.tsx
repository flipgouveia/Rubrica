// The annotation overlay: an absolutely-positioned SVG sized to the page's
// screen dimensions (ARCHITECTURE: "While drawing, the UI renders the
// in-progress object as SVG overlay at 60 fps; it is committed to the PDF
// only on release"), rendering every existing annotation, the in-progress
// draw, and select/move/resize UI.
//
// CONTRACTS gap this file works around: `AnnotPatch` is `{ color, opacity,
// contents, rect }` for every kind, but each `AnnotSpec` variant only
// actually HAS a subset of those fields (see `mock/annotations.ts`'s
// `applyAnnotPatch` — a patch field silently no-ops if the target variant
// doesn't carry that key). Concretely: `contents` only exists on `note`;
// `color` only exists on `highlight`/`underline`/`strikeout`/`freeText`
// (an `ink` stroke's color lives per-stroke, a `shape`'s lives inside its
// nested `stroke`/`fill`, neither is a top-level `color` field); `opacity`
// only exists on `highlight`/`underline`/`strikeout`/`ink`. So *every* kind
// supports live move/resize (via the generic bbox `rect` patch from
// `geometry.ts`) and delete, but only some kinds support a live color/
// opacity edit after creation — `AnnotationToolbar.tsx` enables/disables its
// controls per selected kind accordingly, rather than silently no-op-ing.
//
// A second, separate gap: `annot_add` returns only a `MutationResult`
// (revision + invalidated pages), never the new annotation's id. Placing a
// `note` needs that id immediately (to open its contents popover) — done
// here by diffing `annot_list` before/after the add rather than assuming
// anything about how ids are minted (see `addAndFindNew` below).
//
// Documented rendering convention for `shape: line | arrow` (CONTRACTS'
// `AnnotSpec` only carries a `rect` for shapes, no explicit endpoints):
// the line/arrow always renders from the rect's PDF-space bottom-left
// corner `(x, y)` to its top-right corner `(x + width, y + height)`. Resize
// handles for these two kinds are just those two endpoints (see
// `interaction.ts`'s `handlesForScreenRect`), not the usual 8-point box set.
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "../../ipc";
import type { Annot, AnnotSpec, Rect } from "../../ipc/bindings";
import type { PageViewport, ScreenPoint, ScreenRect } from "../shared/coords";
import { nz, pdfPointToScreen, pdfRectToScreen, quadToScreenPolygon, screenPointToPdf, screenPolygonToSvgPoints, screenRectToPdf } from "../shared/coords";
import { applyBBoxToAnnot, getAnnotBBox, NOTE_ICON_SIZE_PT } from "./geometry";
import {
  clampRectToPage,
  cursorForHandle,
  findHandleAtPoint,
  getResizeHandles,
  handlesForScreenRect,
  hitTestAnnotations,
  isLineLikeShape,
  normalizeScreenRect,
  resizeHandleToBoxHandle,
  resizeScreenRect,
  translateScreenRect,
  type HandleId,
} from "./interaction";
import type { AnnotationMode, AnnotationStyle } from "./model";
import { NotePopover } from "./NotePopover";
import { FreeTextEditor } from "./FreeTextEditor";
import { smoothStrokePoints } from "./smoothing";
import { useAnnotations } from "./useAnnotations";
import { useRafBatch } from "./useRafBatch";

export interface AnnotationLayerProps {
  docId: string;
  page: number;
  viewport: PageViewport;
  mode: AnnotationMode;
  style: AnnotationStyle;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  /** Fired whenever the selected annotation's own data changes (selection changes, or a live edit round-trips) — lets a host toolbar show/edit the current selection without a second `annot_list` subscription. */
  onSelectedAnnotChange?: (annot: Annot | null) => void;
}

type PointerInteraction =
  | { kind: "draw-shape" | "draw-freeText"; start: ScreenPoint }
  | { kind: "draw-ink"; points: ScreenPoint[] }
  | { kind: "move"; annotId: string; startPointer: ScreenPoint; originalRect: ScreenRect }
  | { kind: "resize"; annotId: string; handle: HandleId; originalRect: ScreenRect };

/**
 * `setPointerCapture` can throw (`NotFoundError`) if the browser no longer
 * considers the given pointer id "active" — a real pointer briefly
 * transitioning (e.g. a fast tap-and-release, or a synthetic/automated
 * event with no OS-level pointer session behind it) rather than a bug in
 * the caller. The capture is a nice-to-have (keeps the drag receiving
 * events if the cursor leaves the SVG's bounds mid-drag) — a failure here
 * shouldn't abort the interaction that was already recorded in
 * `interactionRef`, so this swallows it rather than letting it propagate as
 * an uncaught error out of the event handler.
 */
function safeSetPointerCapture(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Ignored — see comment above.
  }
}

const MIN_DRAG_PX = 4;
const NUDGE_STEP_PT = 1;
const NUDGE_STEP_LARGE_PT = 10;
const INK_SMOOTHING_STRENGTH = 3;

/** A click-to-select is a pointer down+up with (near-)zero movement — not a move/resize. Without this guard, plain selection issued a no-op `annot_update` on every click, bumping revision and pushing a redundant no-op entry onto the undo stack. */
function rectsRoughlyEqual(a: ScreenRect, b: ScreenRect, epsilonPx: number): boolean {
  return Math.abs(a.x - b.x) < epsilonPx && Math.abs(a.y - b.y) < epsilonPx && Math.abs(a.width - b.width) < epsilonPx && Math.abs(a.height - b.height) < epsilonPx;
}

/** Diffs `annot_list` before/after an `annot_add` to recover the new annotation's id — see this file's header comment. */
async function addAndFindNew(docId: string, page: number, spec: AnnotSpec): Promise<Annot | null> {
  const before = await commands.annotList(docId, page);
  const beforeIds = new Set(before.status === "ok" ? before.data.map((a) => a.annotId) : []);
  const addResult = await commands.annotAdd(docId, spec);
  if (addResult.status !== "ok") return null;
  const after = await commands.annotList(docId, page);
  if (after.status !== "ok") return null;
  return after.data.find((a) => !beforeIds.has(a.annotId)) ?? null;
}

export function AnnotationLayer({ docId, page, viewport, mode, style, selectedId, onSelectedIdChange, onSelectedAnnotChange }: AnnotationLayerProps) {
  const { t } = useTranslation("tools-annotate");
  const { annotations, refresh } = useAnnotations(docId, page);
  const containerRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);

  const [previewRect, schedulePreviewRect, resetPreviewRect] = useRafBatch<ScreenRect | null>(null);
  const [inkPoints, scheduleInkPoints, resetInkPoints] = useRafBatch<ScreenPoint[]>([]);
  const [pendingFreeText, setPendingFreeText] = useState<ScreenRect | null>(null);
  const [notePopover, setNotePopover] = useState<{ annotId: string; contents: string; x: number; y: number } | null>(null);

  const widthPx = viewport.pageWidthPt * viewport.scale;
  const heightPx = viewport.pageHeightPt * viewport.scale;
  const selectedAnnot = selectedId ? (annotations.find((a) => a.annotId === selectedId) ?? null) : null;

  // Report the selected annotation's live data up to the host (toolbar)
  // whenever the selection or the list itself changes.
  useEffect(() => {
    onSelectedAnnotChange?.(selectedAnnot);
  }, [selectedAnnot, onSelectedAnnotChange]);

  function toPageLocalPoint(event: { clientX: number; clientY: number }): ScreenPoint {
    const bounds = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
  }

  function cancelInteraction() {
    interactionRef.current = null;
    resetPreviewRect();
    resetInkPoints();
  }

  async function handleDelete(annotId: string) {
    await commands.annotDelete(docId, annotId);
    if (selectedId === annotId) onSelectedIdChange(null);
    if (notePopover?.annotId === annotId) setNotePopover(null);
  }

  async function placeNote(point: ScreenPoint) {
    const pdfPoint = screenPointToPdf(point, viewport);
    const created = await addAndFindNew(docId, page, { kind: "note", page, point: pdfPoint, contents: "" });
    await refresh();
    if (!created) return;
    onSelectedIdChange(created.annotId);
    const iconScreen = pdfRectToScreen(getAnnotBBox(created), viewport);
    setNotePopover({ annotId: created.annotId, contents: "", x: iconScreen.x, y: iconScreen.y + iconScreen.height + 6 });
  }

  /** Double-clicking an existing `note` (in "select" mode) reopens its popover pre-filled with its current `contents`, matching Acrobat's own sticky-note behavior. Every other kind ignores a double-click — there's nothing else here to "open". */
  function handleDoubleClick(event: ReactMouseEvent<SVGSVGElement>) {
    if (mode !== "select") return;
    const point = toPageLocalPoint(event);
    const hit = hitTestAnnotations(annotations, point, viewport);
    if (!hit || hit.kind !== "note") return;
    onSelectedIdChange(hit.annotId);
    const iconScreen = pdfRectToScreen(getAnnotBBox(hit), viewport);
    setNotePopover({ annotId: hit.annotId, contents: hit.contents, x: iconScreen.x, y: iconScreen.y + iconScreen.height + 6 });
  }

  // ---- Pointer handling -----------------------------------------------

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const point = toPageLocalPoint(event);

    if (mode === "select" || mode === "highlight" || mode === "underline" || mode === "strikeout") {
      // Markup annotations (highlight/underline/strikeout) are created from
      // a text selection, not a canvas drag — see `selection.ts`'s header
      // comment. While one of those tools is nominally active there's no
      // drag gesture defined yet, so pointer interaction here behaves like
      // "select": click an existing annotation, or click empty space to
      // deselect.
      if (selectedAnnot) {
        const handle = findHandleAtPoint(getResizeHandles(selectedAnnot, viewport), point);
        if (handle) {
          const originalRect = pdfRectToScreen(getAnnotBBox(selectedAnnot), viewport);
          interactionRef.current = { kind: "resize", annotId: selectedAnnot.annotId, handle: handle.id, originalRect };
          safeSetPointerCapture(event.currentTarget, event.pointerId);
          return;
        }
      }
      const hit = hitTestAnnotations(annotations, point, viewport);
      if (hit) {
        onSelectedIdChange(hit.annotId);
        const originalRect = pdfRectToScreen(getAnnotBBox(hit), viewport);
        interactionRef.current = { kind: "move", annotId: hit.annotId, startPointer: point, originalRect };
        safeSetPointerCapture(event.currentTarget, event.pointerId);
      } else {
        onSelectedIdChange(null);
      }
      return;
    }

    if (mode === "note") {
      void placeNote(point);
      return;
    }
    if (mode === "ink") {
      interactionRef.current = { kind: "draw-ink", points: [point] };
      scheduleInkPoints([point]);
      safeSetPointerCapture(event.currentTarget, event.pointerId);
      return;
    }
    if (mode === "shape" || mode === "freeText") {
      interactionRef.current = { kind: mode === "shape" ? "draw-shape" : "draw-freeText", start: point };
      schedulePreviewRect({ x: point.x, y: point.y, width: 0, height: 0 });
      safeSetPointerCapture(event.currentTarget, event.pointerId);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const point = toPageLocalPoint(event);

    switch (interaction.kind) {
      case "draw-ink":
        interaction.points.push(point);
        scheduleInkPoints(interaction.points.slice());
        break;
      case "draw-shape":
      case "draw-freeText":
        schedulePreviewRect(normalizeScreenRect(interaction.start, point));
        break;
      case "move": {
        const dx = point.x - interaction.startPointer.x;
        const dy = point.y - interaction.startPointer.y;
        schedulePreviewRect(clampRectToPage(translateScreenRect(interaction.originalRect, dx, dy), viewport));
        break;
      }
      case "resize": {
        const boxHandle = resizeHandleToBoxHandle(interaction.handle);
        schedulePreviewRect(resizeScreenRect(interaction.originalRect, boxHandle, point));
        break;
      }
    }
  }

  async function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const interaction = interactionRef.current;
    interactionRef.current = null;
    if (!interaction) return;
    const point = toPageLocalPoint(event);

    switch (interaction.kind) {
      case "draw-ink": {
        resetInkPoints();
        if (interaction.points.length < 2) break;
        const pdfPoints = interaction.points.map((p) => screenPointToPdf(p, viewport));
        const smoothed = smoothStrokePoints(pdfPoints, INK_SMOOTHING_STRENGTH);
        await commands.annotAdd(docId, {
          kind: "ink",
          page,
          strokes: [{ points: smoothed, width: style.strokeWidth, color: style.color }],
          opacity: style.opacity,
        });
        break;
      }
      case "draw-shape": {
        resetPreviewRect();
        const finalRect = normalizeScreenRect(interaction.start, point);
        if (finalRect.width < MIN_DRAG_PX && finalRect.height < MIN_DRAG_PX) break;
        const pdfRect = screenRectToPdf(finalRect, viewport);
        // `opacity` is a plain (non-optional) f64 on the Rust side of `StrokeFill` — unlike
        // `color`/`width`, it can't be `null`. When there's no fill at all, the value is otherwise
        // meaningless (engine/annotations.rs's own doc comment: an absent fill color always reads
        // back with opacity 1.0 regardless of what was sent), so any real number is fine here.
        await commands.annotAdd(docId, {
          kind: "shape",
          page,
          shape: style.shapeKind,
          rect: pdfRect,
          stroke: { color: style.color, opacity: style.opacity, width: style.strokeWidth },
          fill: style.filled ? { color: style.color, opacity: style.fillOpacity, width: null } : { color: null, opacity: 1, width: null },
        });
        break;
      }
      case "draw-freeText": {
        resetPreviewRect();
        const finalRect = normalizeScreenRect(interaction.start, point);
        if (finalRect.width < MIN_DRAG_PX || finalRect.height < MIN_DRAG_PX) break;
        setPendingFreeText(finalRect);
        break;
      }
      case "move": {
        resetPreviewRect();
        const dx = point.x - interaction.startPointer.x;
        const dy = point.y - interaction.startPointer.y;
        if (Math.abs(dx) < MIN_DRAG_PX && Math.abs(dy) < MIN_DRAG_PX) break; // plain click-to-select, nothing moved
        const finalRect = clampRectToPage(translateScreenRect(interaction.originalRect, dx, dy), viewport);
        await commitRectPatch(interaction.annotId, finalRect);
        break;
      }
      case "resize": {
        resetPreviewRect();
        const boxHandle = resizeHandleToBoxHandle(interaction.handle);
        const finalRect = resizeScreenRect(interaction.originalRect, boxHandle, point);
        if (rectsRoughlyEqual(finalRect, interaction.originalRect, MIN_DRAG_PX)) break;
        await commitRectPatch(interaction.annotId, finalRect);
        break;
      }
    }
  }

  async function commitRectPatch(annotId: string, screenRect: ScreenRect) {
    const pdfRect = screenRectToPdf(screenRect, viewport);
    await commands.annotUpdate(docId, annotId, { rect: pdfRect, color: null, opacity: null, contents: null });
  }

  // ---- Keyboard: delete / escape / nudge --------------------------------

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;

      if (event.key === "Escape") {
        if (interactionRef.current) {
          cancelInteraction();
        }
        if (pendingFreeText) setPendingFreeText(null);
        if (notePopover) setNotePopover(null);
        if (selectedId) onSelectedIdChange(null);
        return;
      }

      if (!selectedId) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        void handleDelete(selectedId);
        return;
      }

      const step = event.shiftKey ? NUDGE_STEP_LARGE_PT : NUDGE_STEP_PT;
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -step;
      else if (event.key === "ArrowRight") dx = step;
      else if (event.key === "ArrowUp") dy = step;
      else if (event.key === "ArrowDown") dy = -step;
      else return;
      event.preventDefault();

      const current = annotations.find((a) => a.annotId === selectedId);
      if (!current) return;
      const bbox = getAnnotBBox(current);
      const nudged: Rect = { x: nz(bbox.x) + dx, y: nz(bbox.y) + dy, width: bbox.width, height: bbox.height };
      void commands.annotUpdate(docId, selectedId, { rect: nudged, color: null, opacity: null, contents: null });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, annotations, pendingFreeText, notePopover, docId]);

  // ---- Rendering ---------------------------------------------------------

  const draggedRect = previewRect;

  return (
    <div ref={containerRef} className="absolute left-0 top-0" style={{ width: widthPx, height: heightPx }}>
      <svg
        width={widthPx}
        height={heightPx}
        className="absolute left-0 top-0"
        style={{ touchAction: "none", cursor: mode === "select" ? "default" : "crosshair" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => void handlePointerUp(e)}
        onPointerCancel={() => cancelInteraction()}
        onDoubleClick={handleDoubleClick}
        role="img"
        aria-label={t("tools-annotate.layer.ariaLabel")}
      >
        {annotations.map((annot) => (
          <AnnotShape
            key={annot.annotId}
            annot={annot === selectedAnnot && draggedRect && interactionRef.current?.kind !== "draw-shape" && interactionRef.current?.kind !== "draw-freeText" ? previewAnnot(annot, draggedRect, viewport) : annot}
            viewport={viewport}
          />
        ))}

        {inkPoints.length > 1 && (
          <polyline
            points={screenPolygonToSvgPoints(inkPoints)}
            fill="none"
            className="stroke-accent"
            strokeWidth={Math.max(1, style.strokeWidth * viewport.scale)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {draggedRect && (interactionRef.current?.kind === "draw-shape" || interactionRef.current?.kind === "draw-freeText") && (
          <rect x={draggedRect.x} y={draggedRect.y} width={draggedRect.width} height={draggedRect.height} className="fill-accent/10 stroke-accent" strokeDasharray="4 3" />
        )}

        {selectedAnnot && (
          <SelectionOverlay annot={selectedAnnot} viewport={viewport} overrideRect={interactionRef.current?.kind === "move" || interactionRef.current?.kind === "resize" ? draggedRect : null} />
        )}
      </svg>

      {pendingFreeText && (
        <FreeTextEditor
          rect={pendingFreeText}
          color={style.color}
          fontSizePx={style.fontSize * viewport.scale}
          onCancel={() => setPendingFreeText(null)}
          onCommit={(text) => {
            const pdfRect = screenRectToPdf(pendingFreeText, viewport);
            setPendingFreeText(null);
            void commands.annotAdd(docId, { kind: "freeText", page, rect: pdfRect, text, fontSize: style.fontSize, color: style.color });
          }}
        />
      )}

      {notePopover && (
        <NotePopover
          x={notePopover.x}
          y={notePopover.y}
          initialContents={notePopover.contents}
          onCommit={(contents) => void commands.annotUpdate(docId, notePopover.annotId, { contents, color: null, opacity: null, rect: null })}
          onDelete={() => void handleDelete(notePopover.annotId)}
          onClose={() => {
            // The popover's own Escape/blur handling stops propagation (so it doesn't also
            // dismiss something else on the page), which means the window-level Escape handler
            // below — the one that deselects everything else — never runs for this. Without this,
            // a just-placed note (auto-selected so its popover can open) stays selected forever
            // after the popover closes, since nothing else in "note"/other draw modes ever clears
            // selectedId either.
            setNotePopover(null);
            if (selectedId === notePopover.annotId) onSelectedIdChange(null);
          }}
        />
      )}
    </div>
  );
}

function previewAnnot(annot: Annot, previewScreenRect: ScreenRect, viewport: PageViewport): Annot {
  const pdfRect = screenRectToPdf(previewScreenRect, viewport);
  const patch = applyBBoxToAnnot(annot, pdfRect);
  return { ...annot, ...patch } as Annot;
}

// ---- Per-kind SVG rendering -----------------------------------------------

function AnnotShape({ annot, viewport }: { annot: Annot; viewport: PageViewport }) {
  switch (annot.kind) {
    case "highlight":
      return (
        <>
          {annot.quadpoints.map((q, i) => (
            <polygon key={i} points={screenPolygonToSvgPoints(quadToScreenPolygon(q, viewport))} fill={annot.color} fillOpacity={nz(annot.opacity) || 0.4} />
          ))}
        </>
      );
    case "underline":
      return (
        <>
          {annot.quadpoints.map((q, i) => {
            const [, , br, bl] = quadToScreenPolygon(q, viewport);
            return <line key={i} x1={bl.x} y1={bl.y} x2={br.x} y2={br.y} stroke={annot.color} strokeOpacity={nz(annot.opacity) || 1} strokeWidth={Math.max(1.5, 2 * viewport.scale)} />;
          })}
        </>
      );
    case "strikeout":
      return (
        <>
          {annot.quadpoints.map((q, i) => {
            const [tl, tr, br, bl] = quadToScreenPolygon(q, viewport);
            const leftY = (tl.y + bl.y) / 2;
            const rightY = (tr.y + br.y) / 2;
            return <line key={i} x1={tl.x} y1={leftY} x2={tr.x} y2={rightY} stroke={annot.color} strokeOpacity={nz(annot.opacity) || 1} strokeWidth={Math.max(1.5, 2 * viewport.scale)} />;
          })}
        </>
      );
    case "ink":
      return (
        <>
          {annot.strokes.map((s, i) => (
            <polyline
              key={i}
              points={screenPolygonToSvgPoints(s.points.map((p) => pdfPointToScreen(p, viewport)))}
              fill="none"
              stroke={s.color}
              strokeWidth={Math.max(1, nz(s.width) * viewport.scale)}
              strokeOpacity={nz(annot.opacity) || 1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </>
      );
    case "note": {
      const screen = pdfPointToScreen(annot.point, viewport);
      const size = NOTE_ICON_SIZE_PT * viewport.scale;
      return (
        <g transform={`translate(${screen.x}, ${screen.y})`}>
          <rect width={size} height={size} rx={Math.min(4, size / 6)} className="fill-accent stroke-accent-hover" strokeWidth={1} />
          <path d={`M${size * 0.2} ${size * 0.3}h${size * 0.6}M${size * 0.2} ${size * 0.5}h${size * 0.6}M${size * 0.2} ${size * 0.7}h${size * 0.35}`} className="stroke-accent-foreground" strokeWidth={Math.max(1, size * 0.05)} />
        </g>
      );
    }
    case "shape": {
      const rect = pdfRectToScreen(annot.rect, viewport);
      const strokeColor = annot.stroke.color;
      const strokeWidth = strokeColor ? Math.max(1, nz(annot.stroke.width) * viewport.scale) : 0;
      const fillColor = annot.fill.color;
      const fillOpacity = fillColor ? nz(annot.fill.opacity) : 0;
      const strokeOpacity = strokeColor ? nz(annot.stroke.opacity) || 1 : 0;
      if (annot.shape === "rect") {
        return <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} stroke={strokeColor ?? "none"} strokeWidth={strokeWidth} strokeOpacity={strokeOpacity} fill={fillColor ?? "none"} fillOpacity={fillOpacity} />;
      }
      if (annot.shape === "ellipse") {
        return (
          <ellipse
            cx={rect.x + rect.width / 2}
            cy={rect.y + rect.height / 2}
            rx={rect.width / 2}
            ry={rect.height / 2}
            stroke={strokeColor ?? "none"}
            strokeWidth={strokeWidth}
            strokeOpacity={strokeOpacity}
            fill={fillColor ?? "none"}
            fillOpacity={fillOpacity}
          />
        );
      }
      // line / arrow: bottom-left -> top-right of the bbox (documented convention, see file header).
      const p1 = { x: rect.x, y: rect.y + rect.height };
      const p2 = { x: rect.x + rect.width, y: rect.y };
      const markerId = `annot-arrow-${annot.annotId}`;
      return (
        <>
          {annot.shape === "arrow" && (
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill={strokeColor ?? "currentColor"} />
              </marker>
            </defs>
          )}
          <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={strokeColor ?? "none"} strokeWidth={strokeWidth || 1} strokeOpacity={strokeOpacity || 1} markerEnd={annot.shape === "arrow" ? `url(#${markerId})` : undefined} />
        </>
      );
    }
    case "freeText": {
      const rect = pdfRectToScreen(annot.rect, viewport);
      return (
        <foreignObject x={rect.x} y={rect.y} width={Math.max(rect.width, 10)} height={Math.max(rect.height, 10)}>
          <div style={{ color: annot.color, fontSize: nz(annot.fontSize) * viewport.scale, lineHeight: 1.3, wordBreak: "break-word", fontFamily: "inherit" }}>{annot.text}</div>
        </foreignObject>
      );
    }
  }
}

function SelectionOverlay({ annot, viewport, overrideRect }: { annot: Annot; viewport: PageViewport; overrideRect: ScreenRect | null }) {
  const rect = overrideRect ?? pdfRectToScreen(getAnnotBBox(annot), viewport);
  const lineLike = annot.kind === "shape" && isLineLikeShape(annot.shape);
  const handles = handlesForScreenRect(rect, lineLike);
  const showHandles = annot.kind !== "note";
  return (
    <>
      <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill="none" className="stroke-accent" strokeWidth={1.5} strokeDasharray="5 3" />
      {showHandles &&
        handles.map((handle) => (
          <rect
            key={handle.id}
            x={handle.point.x - 4}
            y={handle.point.y - 4}
            width={8}
            height={8}
            className="fill-surface stroke-accent"
            strokeWidth={1.5}
            style={{ cursor: cursorForHandle(handle.id) }}
          />
        ))}
    </>
  );
}
