// The text-edit overlay (TOOL-API.md `overlayLayer`): one instance per
// visible page, absolutely positioned over that page's tiles. Renders a
// subtle hit-target over every text run on the page (`text_objects`),
// handles click-to-select / click-again-to-edit for runs, and — depending
// on the shared `mode` (see `model.ts`) — lets the user click/drag to place
// a new text box or a new image object.
//
// Selection vs. editing (brief deliverables 1 + 4 read together): a single
// click on an unselected run SELECTS it (a visible highlight, distinct from
// editing — this is what the panel's delete button and the Delete/Backspace
// key act on); clicking an ALREADY-selected run opens its inline editor.
// This is the same "click to select, click again to rename" two-step used
// by most desktop file managers — it reconciles "clicking a run opens an
// inline editor" with "clicking a run selects it" without needing a
// separate double-click gesture (a double-click's two rapid clicks satisfy
// this naturally: the first selects, the second — now already selected —
// edits).
//
// Image objects are placed but never made selectable here: `imageobj_add`
// (CONTRACTS §3) returns only a `MutationResult`, no id, and there is no
// `image_objects` getter to diff against afterwards (unlike text runs,
// which round-trip a real `objectId`). Faking a selectable id for an image
// would be dishonest about what the IPC surface actually supports, so a
// freshly-placed image only gets a brief, purely-visual confirmation flash
// here — removing one afterwards is a job for Ctrl+Z, not this tool's own
// delete affordance (see `TextEditPanel.tsx`'s header comment for the full
// reasoning).
import { Fragment, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { AlertTriangle } from "lucide-react";
import { commands } from "../../ipc";
import type { ToolOverlayProps } from "../../chrome/tool-api";
import type { TextRun } from "../../ipc/bindings";
import { Tooltip } from "../../tokens/components";
import { nz, type ScreenPoint, type ScreenRect } from "../shared/coords";
import { deleteSelectedTextObject } from "./actions";
import { clampScreenRectToPage, defaultRectAt, dragRectFromPoints, DRAG_THRESHOLD_PX, rectToScreen, screenDistance, screenRectToPdfRect } from "./geometry";
import { InlineTextEditor } from "./InlineTextEditor";
import { DEFAULT_IMAGE_RECT_SIZE_PT, DEFAULT_TEXT_RECT_SIZE_PT, useTextEditStore } from "./model";
import { substitutionKey, useSubstitutionStore } from "./substitutionStore";
import { useTextRuns } from "./useTextRuns";

const IMAGE_FLASH_MS = 2000;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
}

function rectStyle(rect: ScreenRect): { left: number; top: number; width: number; height: number } {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

export function TextEditOverlay({ viewport, isActive }: ToolOverlayProps) {
  const { t } = useTranslation("tools-textedit");
  const docId = viewport.docId;
  const page = viewport.page;

  const { textRuns } = useTextRuns(docId, page);
  const mode = useTextEditStore((s) => s.mode);
  const newTextStyle = useTextEditStore((s) => s.newTextStyle);
  const imagePath = useTextEditStore((s) => s.imagePath);
  const selection = useTextEditStore((s) => s.selection);
  const setSelection = useTextEditStore((s) => s.setSelection);
  const substitutedKeys = useSubstitutionStore((s) => s.substitutedKeys);
  const markSubstituted = useSubstitutionStore((s) => s.markSubstituted);
  const clearSubstituted = useSubstitutionStore((s) => s.clearSubstituted);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<ScreenPoint | null>(null);
  const [dragRect, setDragRect] = useState<ScreenRect | null>(null);
  const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
  const [pendingNewText, setPendingNewText] = useState<ScreenRect | null>(null);
  const [imageFlash, setImageFlash] = useState<ScreenRect | null>(null);

  const widthPx = viewport.widthPt * viewport.zoom;
  const heightPx = viewport.heightPt * viewport.zoom;
  const selectedHere = selection !== null && selection.docId === docId && selection.page === page ? selection.objectId : null;

  function toLocalPoint(event: { clientX: number; clientY: number }): ScreenPoint {
    const bounds = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
  }

  function handleRunClick(run: TextRun): void {
    if (editingObjectId) return; // an editor is already open elsewhere on this page; ignore stray clicks until it settles
    if (selectedHere === run.objectId) {
      setEditingObjectId(run.objectId);
    } else {
      setSelection({ docId, page, objectId: run.objectId });
    }
  }

  async function commitRunEdit(run: TextRun, text: string): Promise<void> {
    setEditingObjectId(null);
    const result = await commands.textobjSetText(docId, run.objectId, text);
    const key = substitutionKey(docId, run.objectId);
    if (result.status === "ok") {
      if (result.data.fontSubstituted) markSubstituted(key);
      else clearSubstituted(key);
      setSelection({ docId, page, objectId: run.objectId });
    } else {
      console.error(`[text-edit] textobj_set_text failed: ${result.error.message}`);
    }
  }

  async function commitNewText(rect: ScreenRect, text: string): Promise<void> {
    setPendingNewText(null);
    const pdfRect = screenRectToPdfRect(rect, viewport);
    const result = await commands.textobjAdd(docId, page, { rect: pdfRect, text, fontSize: newTextStyle.fontSize, color: newTextStyle.color });
    if (result.status !== "ok") console.error(`[text-edit] textobj_add failed: ${result.error.message}`);
  }

  async function placeImage(rect: ScreenRect): Promise<void> {
    const path = imagePath.trim();
    if (!path) return; // the panel explains a path is required before placing; nothing to do here
    const pdfRect = screenRectToPdfRect(rect, viewport);
    const result = await commands.imageobjAdd(docId, page, { rect: pdfRect, path });
    if (result.status === "ok") {
      setImageFlash(rect);
      window.setTimeout(() => setImageFlash(null), IMAGE_FLASH_MS);
    } else {
      console.error(`[text-edit] imageobj_add failed: ${result.error.message}`);
    }
  }

  // ---- Pointer handling (add-text / add-image draw-or-click) --------------

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (mode === "select" || event.button !== 0) return;
    const point = toLocalPoint(event);
    dragStartRef.current = point;
    setDragRect({ x: point.x, y: point.y, width: 0, height: 0 });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Not implemented in every environment — see AnnotationLayer.tsx's identical guard.
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = dragStartRef.current;
    if (!start) return;
    setDragRect(dragRectFromPoints(start, toLocalPoint(event)));
  }

  async function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): Promise<void> {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    setDragRect(null);
    if (!start) return;
    const point = toLocalPoint(event);
    const dragged = screenDistance(start, point) >= DRAG_THRESHOLD_PX;
    const sizePt = mode === "addImage" ? DEFAULT_IMAGE_RECT_SIZE_PT : DEFAULT_TEXT_RECT_SIZE_PT;
    const rawRect = dragged ? dragRectFromPoints(start, point) : defaultRectAt(start, sizePt, viewport.zoom);
    const finalRect = clampScreenRectToPage(rawRect, widthPx, heightPx);
    if (finalRect.width < 2 || finalRect.height < 2) return;

    if (mode === "addText") setPendingNewText(finalRect);
    else if (mode === "addImage") await placeImage(finalRect);
  }

  function handleContainerClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (mode !== "select" || event.target !== event.currentTarget) return;
    if (selectedHere) setSelection(null);
  }

  // ---- Keyboard: delete selected run / escape ------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) return; // the inline editor handles its own Escape/Enter
      if (event.key === "Escape") {
        if (pendingNewText) setPendingNewText(null);
        else if (selectedHere) setSelection(null);
        return;
      }
      if (!isActive || !selectedHere) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        void deleteSelectedTextObject();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive, selectedHere, pendingNewText, setSelection]);

  // ---- Rendering ------------------------------------------------------------

  return (
    <div
      ref={containerRef}
      className="absolute left-0 top-0"
      style={{ width: widthPx, height: heightPx, cursor: mode === "select" ? "default" : "crosshair" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => void handlePointerUp(event)}
      onPointerCancel={() => {
        dragStartRef.current = null;
        setDragRect(null);
      }}
      onClick={handleContainerClick}
      role="group"
      aria-label={t("tools-textedit.overlay.ariaLabel")}
      data-testid="text-edit-overlay"
    >
      {textRuns.map((run) => {
        if (editingObjectId === run.objectId) return null;
        const rect = rectToScreen(run.rect, viewport);
        const selected = selectedHere === run.objectId;
        const substituted = substitutedKeys.has(substitutionKey(docId, run.objectId));
        return (
          <Fragment key={run.objectId}>
            <div
              role="button"
              tabIndex={mode === "select" ? 0 : -1}
              aria-label={t("tools-textedit.overlay.runLabel", { text: run.text })}
              aria-pressed={selected}
              data-testid={`text-edit-run-${run.objectId}`}
              onClick={(event) => {
                if (mode !== "select") return;
                event.stopPropagation();
                handleRunClick(run);
              }}
              onKeyDown={(event) => {
                if (mode === "select" && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  handleRunClick(run);
                }
              }}
              className={clsx(
                "absolute border transition-colors",
                mode === "select" ? "cursor-pointer" : "pointer-events-none",
                selected ? "border-accent bg-accent/10" : "border-transparent hover:border-accent/50 hover:bg-accent/5",
              )}
              style={rectStyle(rect)}
            />
            {substituted && (
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <span
                    aria-label={t("tools-textedit.overlay.fontSubstitutedBadge")}
                    data-testid={`text-edit-font-substituted-badge-${run.objectId}`}
                    className="pointer-events-auto absolute z-10 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-danger-foreground"
                    style={{ left: rect.x + rect.width - 8, top: rect.y - 8 }}
                  >
                    <AlertTriangle className="h-2.5 w-2.5" />
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Content>{t("tools-textedit.overlay.fontSubstitutedTooltip")}</Tooltip.Content>
              </Tooltip.Root>
            )}
          </Fragment>
        );
      })}

      {dragRect && (mode === "addText" || mode === "addImage") && (
        <div className="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/10" style={rectStyle(dragRect)} />
      )}

      {textRuns.map((run) =>
        editingObjectId === run.objectId ? (
          <InlineTextEditor
            key={run.objectId}
            rect={rectToScreen(run.rect, viewport)}
            initialValue={run.text}
            fontSizePx={(nz(run.fontSize) || 12) * viewport.zoom}
            color="#000000"
            commitOnEmpty
            onCommit={(text) => void commitRunEdit(run, text)}
            onCancel={() => setEditingObjectId(null)}
          />
        ) : null,
      )}

      {pendingNewText && (
        <InlineTextEditor
          rect={pendingNewText}
          initialValue=""
          fontSizePx={newTextStyle.fontSize * viewport.zoom}
          color={newTextStyle.color}
          commitOnEmpty={false}
          placeholder={t("tools-textedit.overlay.newTextPlaceholder")}
          onCommit={(text) => void commitNewText(pendingNewText, text)}
          onCancel={() => setPendingNewText(null)}
        />
      )}

      {imageFlash && (
        <div
          className="pointer-events-none absolute flex items-center justify-center border-2 border-dashed border-accent bg-accent/10 text-center text-xs font-medium text-accent"
          style={rectStyle(imageFlash)}
        >
          {t("tools-textedit.overlay.imagePlacedLabel")}
        </div>
      )}
    </div>
  );
}
