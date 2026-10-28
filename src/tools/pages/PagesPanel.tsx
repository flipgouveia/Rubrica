// The pages tool (R4 brief item 2): "upgrade the thumbnail rail into an
// editor". Deliberately self-contained per this agent's brief — R3's
// `src/chrome/TOOL-API.md` extension point doesn't exist yet, so this is a
// standalone component that owns its own docId, not a plugin fragment
// expecting to be hosted inside someone else's rail. `<PagesPanel docId>`
// is the whole public surface; re-hosting it inside chrome later should be
// a wrapper, not a rewrite.
//
// Every mutation goes through the real `commands.pages*` IPC (CONTRACTS
// §3) and relies on the shared `useDocRevision` hook
// (`src/tools/shared/useDocRevision.ts`) to refetch `DocInfo` on every
// `doc_state_changed` for this doc, so `MutationResult.invalidatedPages` is
// honored "for free": a
// fresh `revision` flows into `thumbSrc`, which changes the `<img src>`
// data URL (mock) / query string (real protocol), forcing a visible redraw.
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, isMockEngine, mockThumbUrl, realThumbUrl } from "../../ipc";
import type { DocInfo, PageRange, RubricaError } from "../../ipc/bindings";
import { Button, IconButton } from "../../tokens/components";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { buildReorderedIndices, computeDropIndex, type RectLike } from "./dnd";
import { CloseIcon, RotateLeftIcon, RotateRightIcon, TrashIcon } from "./icons";
import { InsertFromFileDialog } from "./InsertFromFileDialog";
import { PageThumbnail, type SelectModifiers } from "./PageThumbnail";
import { useDocRevision } from "../shared/useDocRevision";

export interface PagesPanelProps {
  /** An already-open document id (see `commands.docOpen`) — this component never opens/closes it. */
  docId: string;
}

/**
 * Builds the thumbnail `<img src>` for one page. Mirrors the seam
 * documented in `mock/render.ts`: use the mock's synchronous data-URL
 * placeholder when running against the mock engine, otherwise construct
 * the real `rubrica-thumb://` custom-protocol URL (CONTRACTS §3) via
 * `ipc/protocolUrl.ts`, never a hand-spelled scheme string (see there) — a
 * revision bump always changes the resulting string either way, which is
 * what makes a plain `<img src=...>` redraw correctly with no extra
 * cache-busting logic.
 */
function thumbSrc(docId: string, page: number, revision: number): string {
  if (isMockEngine) return mockThumbUrl(docId, page, revision);
  return realThumbUrl(docId, page, revision);
}

type ErrorContext = "delete" | "rotate" | "reorder" | "insertBlank" | "insertFromFile";

interface PanelError {
  context: ErrorContext;
  error: RubricaError;
}

function DropIndicator() {
  return <div data-testid="pages-drop-indicator" aria-hidden="true" className="my-1 w-1 self-stretch rounded-full bg-accent" />;
}

export function PagesPanel({ docId }: PagesPanelProps) {
  const { t } = useTranslation(["tools-pages", "common"]);

  const [docInfo, setDocInfo] = useState<DocInfo | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [insertFileOpen, setInsertFileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState<PanelError | null>(null);

  const thumbRefs = useRef(new Map<number, HTMLDivElement>());
  const anchorIndexRef = useRef<number | null>(null);
  const activePointerId = useRef<number | null>(null);

  const loadDocInfo = useCallback(async (id: string) => {
    const result = await commands.docListOpen();
    if (result.status === "ok") {
      setDocInfo(result.data.find((doc) => doc.docId === id) ?? null);
    }
  }, []);

  useDocRevision(docId, loadDocInfo);

  // Defensive pruning only — a mutation *this panel* drives clears the
  // selection itself (see the handlers below), since after a structural
  // edit a numeric index no longer names the same page. This just protects
  // against an external change (e.g. another view undoing/redoing this doc)
  // shrinking the page count out from under a stale selection.
  useEffect(() => {
    if (!docInfo) return;
    setSelected((prev) => {
      const filtered = new Set([...prev].filter((index) => index < docInfo.pageCount));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [docInfo]);

  const registerRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) thumbRefs.current.set(index, el);
    else thumbRefs.current.delete(index);
  }, []);

  const handleSelect = useCallback((index: number, modifiers: SelectModifiers) => {
    setSelected((prev) => {
      if (modifiers.shift && anchorIndexRef.current !== null) {
        const anchor = anchorIndexRef.current;
        const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
        const range = new Set<number>();
        for (let i = lo; i <= hi; i++) range.add(i);
        return range;
      }
      if (modifiers.ctrl) {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      }
      return new Set([index]);
    });
    if (!modifiers.shift) anchorIndexRef.current = index;
  }, []);

  const getCurrentRects = useCallback((count: number): RectLike[] => {
    const rects: RectLike[] = [];
    for (let i = 0; i < count; i++) {
      const rect = thumbRefs.current.get(i)?.getBoundingClientRect();
      rects.push(rect ?? { left: 0, top: 0, right: 0, bottom: 0 });
    }
    return rects;
  }, []);

  const handleHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
      if (busy) return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Not implemented in every environment (older WebView2, some test
        // DOMs) — the drag still works via bubbled pointermove/pointerup.
      }
      activePointerId.current = event.pointerId;
      setDragIndex(index);
      setDropIndex(index);
    },
    [busy],
  );

  const handleGridPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragIndex === null || !docInfo) return;
      if (activePointerId.current !== null && event.pointerId !== activePointerId.current) return;
      const rects = getCurrentRects(docInfo.pageCount);
      setDropIndex(computeDropIndex({ x: event.clientX, y: event.clientY }, rects, dragIndex));
    },
    [dragIndex, docInfo, getCurrentRects],
  );

  const finishDrag = useCallback(
    async (from: number, to: number) => {
      if (!docInfo) return;
      const order = docInfo.pages.map((_, i) => i);
      const newOrder = buildReorderedIndices(order, from, to);
      const changed = newOrder.some((value, i) => value !== order[i]);
      if (!changed) return;
      setBusy(true);
      const result = await commands.pagesReorder(docId, newOrder);
      setBusy(false);
      if (result.status === "error") {
        setPanelError({ context: "reorder", error: result.error });
        return;
      }
      setSelected(new Set());
    },
    [docInfo, docId],
  );

  const handleGridPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragIndex === null) return;
      if (activePointerId.current !== null && event.pointerId !== activePointerId.current) return;
      const from = dragIndex;
      const to = dropIndex ?? dragIndex;
      setDragIndex(null);
      setDropIndex(null);
      activePointerId.current = null;
      void finishDrag(from, to);
    },
    [dragIndex, dropIndex, finishDrag],
  );

  const handleGridPointerCancel = useCallback(() => {
    setDragIndex(null);
    setDropIndex(null);
    activePointerId.current = null;
  }, []);

  const handleRotate = useCallback(
    async (degrees: number) => {
      if (!docInfo || selected.size === 0 || busy) return;
      setBusy(true);
      const result = await commands.pagesRotate(docId, Array.from(selected), degrees);
      setBusy(false);
      if (result.status === "error") setPanelError({ context: "rotate", error: result.error });
    },
    [docInfo, selected, busy, docId],
  );

  // New pages land right after the current selection, or at the end when
  // nothing is selected — the brief's own suggested "simple affordance"
  // (CONTRACTS' `pages_insert_*` `at` is a plain 0-based index either way).
  const insertionIndex = useCallback((): number => {
    if (!docInfo) return 0;
    if (selected.size === 0) return docInfo.pageCount;
    return Math.max(...selected) + 1;
  }, [docInfo, selected]);

  const handleInsertBlank = useCallback(async () => {
    if (!docInfo || busy) return;
    const at = insertionIndex();
    setBusy(true);
    // `BlankPageSpec.width`/`.height` are plain (non-optional) f64 on the Rust side — despite the
    // generated TS type showing `number | null` (the mock engine DOES treat a null width/height as
    // "use the default page size", per `mock/pages.ts`'s own `spec.width ?? 612`, but the real
    // engine has no such fallback and rejects a null outright). Matching `PageThumbnail.tsx`'s own
    // existing `?? 612` / `?? 792` fallback (US Letter, in points) for consistency.
    const result = await commands.pagesInsertBlank(docId, at, { width: 612, height: 792 });
    setBusy(false);
    if (result.status === "error") {
      setPanelError({ context: "insertBlank", error: result.error });
      return;
    }
    setSelected(new Set());
  }, [docInfo, busy, docId, insertionIndex]);

  const handleDeleteClick = useCallback(() => {
    if (selected.size > 0) setDeleteOpen(true);
  }, [selected]);

  const handleCancelDelete = useCallback(() => setDeleteOpen(false), []);

  const handleConfirmDelete = useCallback(async () => {
    if (!docInfo) return;
    setBusy(true);
    const result = await commands.pagesDelete(docId, Array.from(selected));
    setBusy(false);
    setDeleteOpen(false);
    if (result.status === "error") {
      setPanelError({ context: "delete", error: result.error });
      return;
    }
    setSelected(new Set());
  }, [docInfo, docId, selected]);

  const handleCancelInsertFromFile = useCallback(() => setInsertFileOpen(false), []);

  const handleConfirmInsertFromFile = useCallback(
    async (file: File, range: PageRange | null) => {
      if (!docInfo || busy) return;
      const at = insertionIndex();
      setBusy(true);
      const result = await commands.pagesInsertFromFile(docId, at, file.name, range);
      setBusy(false);
      if (result.status === "error") {
        setPanelError({ context: "insertFromFile", error: result.error });
        return;
      }
      setInsertFileOpen(false);
      setSelected(new Set());
    },
    [docInfo, busy, docId, insertionIndex],
  );

  function describeError(panelErr: PanelError): string {
    if (panelErr.context === "delete" && panelErr.error.code === "INVALID_ARG") {
      return t("tools-pages:tools-pages.errors.cannotDeleteAllPages");
    }
    return t("tools-pages:tools-pages.errors.generic", { message: panelErr.error.message });
  }

  const children: ReactNode[] = [];
  if (docInfo) {
    docInfo.pages.forEach((pageSize, index) => {
      if (dragIndex !== null && dropIndex === index) {
        children.push(<DropIndicator key={`drop-${index}`} />);
      }
      children.push(
        <PageThumbnail
          key={index}
          index={index}
          page={pageSize}
          thumbSrc={thumbSrc(docId, index, docInfo.revision)}
          selected={selected.has(index)}
          dragging={dragIndex === index}
          disabled={busy}
          onSelect={handleSelect}
          onDeleteKey={handleDeleteClick}
          onHandlePointerDown={handleHandlePointerDown}
          registerRef={registerRef}
        />,
      );
    });
    if (dragIndex !== null && dropIndex === docInfo.pages.length) {
      children.push(<DropIndicator key="drop-end" />);
    }
  }

  return (
    <div className="flex h-full flex-col bg-background text-text">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="font-display text-base font-semibold">{t("tools-pages:tools-pages.panel.title")}</h2>
        {selected.size > 0 && (
          <span className="text-sm text-muted-text">{t("tools-pages:tools-pages.panel.selectedCount", { count: selected.size })}</span>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-2">
        <IconButton
          aria-label={t("tools-pages:tools-pages.actions.rotateLeft")}
          onClick={() => void handleRotate(-90)}
          disabled={busy || selected.size === 0}
        >
          <RotateLeftIcon />
        </IconButton>
        <IconButton
          aria-label={t("tools-pages:tools-pages.actions.rotateRight")}
          onClick={() => void handleRotate(90)}
          disabled={busy || selected.size === 0}
        >
          <RotateRightIcon />
        </IconButton>
        <IconButton
          aria-label={t("tools-pages:tools-pages.actions.delete")}
          variant="danger"
          onClick={handleDeleteClick}
          disabled={busy || selected.size === 0}
        >
          <TrashIcon />
        </IconButton>
        <div className="mx-1 h-6 w-px bg-border" aria-hidden="true" />
        <Button variant="secondary" size="sm" onClick={() => void handleInsertBlank()} disabled={busy || !docInfo}>
          {t("tools-pages:tools-pages.actions.insertBlank")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setInsertFileOpen(true)} disabled={busy || !docInfo}>
          {t("tools-pages:tools-pages.actions.insertFromFile")}
        </Button>
      </div>

      {panelError && (
        <div
          role="alert"
          className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <span>{describeError(panelError)}</span>
          <IconButton aria-label={t("tools-pages:tools-pages.errors.dismiss")} size="sm" onClick={() => setPanelError(null)}>
            <CloseIcon />
          </IconButton>
        </div>
      )}

      {!docInfo ? (
        <p className="px-4 py-6 text-sm text-muted-text">{t("tools-pages:tools-pages.panel.empty")}</p>
      ) : (
        <>
          <p className="px-4 pt-3 text-xs text-muted-text">{t("tools-pages:tools-pages.panel.insertHint")}</p>
          <div
            data-testid="pages-grid"
            onPointerMove={handleGridPointerMove}
            onPointerUp={handleGridPointerUp}
            onPointerCancel={handleGridPointerCancel}
            className="flex flex-1 flex-wrap content-start items-stretch gap-4 overflow-auto p-4"
          >
            {children}
          </div>
        </>
      )}

      <DeleteConfirmDialog
        open={deleteOpen}
        count={selected.size}
        busy={busy}
        onCancel={handleCancelDelete}
        onConfirm={() => void handleConfirmDelete()}
      />
      <InsertFromFileDialog
        open={insertFileOpen}
        busy={busy}
        onCancel={handleCancelInsertFromFile}
        onConfirm={(file, range) => void handleConfirmInsertFromFile(file, range)}
      />
    </div>
  );
}
