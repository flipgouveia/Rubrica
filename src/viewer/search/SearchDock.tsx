// Docked search panel (Ctrl+Shift+F / expand button, mockup section 1): a resizable right column.
// It is a flex sibling of the viewer, so the viewer shrinks (never overlaid) and ViewerSurface's
// ResizeObserver recomputes "fit to width" for the new width.
import { useRef, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { CaseSensitive, Minimize2, WholeWord, X } from "lucide-react";
import { IconButton } from "../../tokens/components";
import type { DocId } from "../types";
import { closeSearch, persistPanelWidth, setSearchMode } from "./searchController";
import { SearchNotice } from "./SearchNotices";
import { SearchOptions } from "./SearchOptions";
import { SearchCount, SearchField, SearchNavButtons, SearchProgress, SortSelect } from "./SearchParts";
import { SearchResultsList } from "./SearchResultsList";
import {
  DOCKED_WIDTH_MAX,
  DOCKED_WIDTH_MIN,
  useSearchStore,
} from "./searchStore";

const KEYBOARD_RESIZE_STEP = 16;
const KEY_NEXT = "Enter";
const KEY_PREVIOUS = "Shift+Enter";
const KEY_CLOSE = "Esc";

function ResizeHandle() {
  const { t } = useTranslation("viewer");
  const width = useSearchStore((s) => s.panelWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The panel is anchored to the right edge: dragging left makes it wider.
    useSearchStore.getState().setPanelWidth(drag.current.startWidth + (drag.current.startX - e.clientX));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    persistPanelWidth(useSearchStore.getState().panelWidth);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowLeft" ? KEYBOARD_RESIZE_STEP : e.key === "ArrowRight" ? -KEYBOARD_RESIZE_STEP : 0;
    if (delta === 0) return;
    e.preventDefault();
    useSearchStore.getState().setPanelWidth(useSearchStore.getState().panelWidth + delta);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("viewer.search.resize")}
      aria-valuemin={DOCKED_WIDTH_MIN}
      aria-valuemax={DOCKED_WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") persistPanelWidth(useSearchStore.getState().panelWidth);
      }}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none"
    />
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span>
      <kbd className="rounded-[4px] border border-b-2 border-border-strong bg-surface px-1 py-0.5 font-mono text-[10px]">{keys}</kbd> {label}
    </span>
  );
}

export function SearchDock({ docId, inputRef }: { docId: DocId; inputRef: Ref<HTMLInputElement> }) {
  const { t } = useTranslation("viewer");
  const width = useSearchStore((s) => s.panelWidth);
  const caseSensitive = useSearchStore((s) => s.byDoc[docId]?.caseSensitive ?? false);
  const wholeWord = useSearchStore((s) => s.byDoc[docId]?.wholeWord ?? false);

  return (
    <aside
      data-testid="search-panel"
      data-mode="docked"
      role="search"
      style={{ width }}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-surface text-sm text-text"
    >
      <ResizeHandle />
      <div className="flex items-center justify-between border-b border-border py-1 pl-3 pr-1.5 text-[13px] font-semibold">
        <span>{t("viewer.search.panelTitle")}</span>
        <span className="flex items-center gap-0.5">
          <IconButton aria-label={t("viewer.search.compact")} size="sm" onClick={() => setSearchMode("compact")}>
            <Minimize2 className="h-4 w-4" />
          </IconButton>
          <IconButton data-testid="search-close" aria-label={t("viewer.search.close")} size="sm" onClick={() => closeSearch(docId)}>
            <X className="h-4 w-4" />
          </IconButton>
        </span>
      </div>

      <div className="flex items-center gap-1 p-2">
        <SearchField docId={docId} inputRef={inputRef} />
        <IconButton
          aria-label={t("viewer.search.caseSensitive")}
          aria-pressed={caseSensitive}
          size="sm"
          onClick={() => useSearchStore.getState().toggleCaseSensitive(docId)}
        >
          <CaseSensitive className="h-4 w-4" />
        </IconButton>
        <IconButton
          aria-label={t("viewer.search.wholeWord")}
          aria-pressed={wholeWord}
          size="sm"
          onClick={() => useSearchStore.getState().toggleWholeWord(docId)}
        >
          <WholeWord className="h-4 w-4" />
        </IconButton>
      </div>

      <SearchOptions docId={docId} />

      <div className="shrink-0 border-t border-border">
        <SearchProgress docId={docId} className="mx-2 mt-1.5 h-[3px] overflow-hidden rounded-sm bg-border" />
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-muted-text">
          <SearchCount docId={docId} variant="dock" className="min-w-0 truncate tabular-nums" />
          <span className="flex shrink-0 items-center gap-0.5">
            <SortSelect />
            <SearchNavButtons docId={docId} />
          </span>
        </div>
      </div>

      <SearchNotice docId={docId} variant="dock" />
      <SearchResultsList docId={docId} />
      <div className="mt-auto flex justify-end gap-2.5 border-t border-border px-2.5 py-1.5 text-[11px] text-muted-text">
        <Hint keys={KEY_NEXT} label={t("viewer.search.hintNext")} />
        <Hint keys={KEY_PREVIOUS} label={t("viewer.search.hintPrevious")} />
        <Hint keys={KEY_CLOSE} label={t("viewer.search.hintClose")} />
      </div>
    </aside>
  );
}
