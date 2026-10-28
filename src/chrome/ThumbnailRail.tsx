// View-only thumbnail rail (brief item 2 — "thumbnail rail (view-only here — R4 adds editing
// interactions on top via the TOOL-API's rail extension point)"). Click scrolls the viewer to
// that page; the currently-visible page gets a ring highlight. Virtualized the same way as
// ViewerSurface so the 500-page fixture stays smooth here too.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import type { PageSize } from "../ipc/bindings";
import type { DocId } from "../viewer/types";
import { useViewerStore } from "../viewer/store";
import { Thumbnail } from "./Thumbnail";
import { useActiveRailExtension } from "./tool-api";

const THUMB_HEIGHT = 140;
const ROW_GAP = 14;

interface ThumbnailRailProps {
  docId: DocId;
  pageCount: number;
  currentPage: number;
  revision: number;
  pages: PageSize[];
}

export function ThumbnailRail({ docId, pageCount, currentPage, revision, pages }: ThumbnailRailProps) {
  const { t } = useTranslation("chrome");
  const scrollRef = useRef<HTMLDivElement>(null);
  const RailExtension = useActiveRailExtension();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const rowVirtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => THUMB_HEIGHT + ROW_GAP,
    overscan: 4,
  });

  // Keep the current page's thumbnail in view as the viewer scrolls, without fighting a manual
  // rail scroll: only jump when currentPage has actually scrolled out of the visible range.
  useEffect(() => {
    const inView = rowVirtualizer.getVirtualItems().some((item) => item.index === currentPage);
    if (!inView) rowVirtualizer.scrollToIndex(currentPage, { align: "auto" });
  }, [currentPage, rowVirtualizer]);

  const toggleSelected = (page: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  return (
    <div ref={scrollRef} className="h-full w-36 shrink-0 overflow-auto border-r border-border bg-surface" aria-label={t("chrome:chrome.rail.label")}>
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((item) => {
          const page = item.index;
          const pageSize = pages[page];
          const aspect = (pageSize?.width ?? 612) / (pageSize?.height ?? 792);
          return (
            <div
              key={item.key}
              className="absolute left-0 flex w-full flex-col items-center gap-1"
              style={{ top: item.start, height: item.size }}
            >
              <button
                type="button"
                className={clsx(
                  "relative overflow-hidden rounded-sm border bg-white",
                  page === currentPage ? "border-accent ring-2 ring-accent" : "border-border",
                )}
                style={{ width: THUMB_HEIGHT * aspect, height: THUMB_HEIGHT }}
                onClick={() => useViewerStore.getState().scrollToPage(docId, page)}
              >
                <Thumbnail docId={docId} page={page} revision={revision} alt={t("chrome:chrome.rail.pageAlt", { page: page + 1 })} className="h-full w-full object-contain" />
                {RailExtension && (
                  <RailExtension docId={docId} page={page} index={page} selected={selected.has(page)} toggleSelected={() => toggleSelected(page)} />
                )}
              </button>
              <span className="text-[11px] text-muted-text">{page + 1}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
