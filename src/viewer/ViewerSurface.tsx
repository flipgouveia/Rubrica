// Virtualized page list (brief item 1: "virtualized page canvas ... smooth 500-page behavior").
// Only visible pages + a small overscan ring are ever mounted — @tanstack/react-virtual handles
// the windowing math; this component just feeds it page sizes (which depend on continuous zoom,
// so they're re-measured whenever zoom changes) and turns scroll position back into "current
// page" for the thumbnail rail / page indicator.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TabState } from "./store";
import { useViewerStore } from "./store";
import { PageCanvas } from "./PageCanvas";
import { DensityMap } from "./search/DensityMap";
import { clampZoom } from "./types";
import { zoomedListY, zoomedScrollLeft } from "./zoomAnchor";

const PAGE_GAP = 16;
const VIEWPORT_PADDING = 24;

interface ViewerSurfaceProps {
  tab: TabState;
}

export function ViewerSurface({ tab }: ViewerSurfaceProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The density map mirrors the scroller, so it needs the element itself, not just the ref.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollNode = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const setZoom = useViewerStore((s) => s.setZoom);
  const setCurrentPage = useViewerStore((s) => s.setCurrentPage);
  const clearPendingScroll = useViewerStore((s) => s.clearPendingScroll);

  const { docId, info, zoom, zoomMode, currentPage, pendingScrollTo } = tab;
  const pageCount = info.pageCount;

  const rowVirtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (info.pages[index]?.height ?? 792) * zoom + PAGE_GAP,
    overscan: 2,
  });

  // Zoom changes keep the document point under `zoomAnchorRef` (the cursor for Ctrl+wheel, else the
  // top of the viewport, horizontally centred) in place. The new scroll offsets can only be applied
  // once the virtualizer has re-measured, because until then the list is still as tall as before and
  // the browser would clamp them: layout effect 1 (below) computes them and asks for the re-measure,
  // layout effect 2 applies them on the render that follows.
  const zoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const lastZoomRef = useRef(zoom);
  const pendingScrollRef = useRef<{ top: number; left: number; armed: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const from = lastZoomRef.current;
    lastZoomRef.current = zoom;
    rowVirtualizer.measure();
    if (!el || from === zoom) return;
    const anchor = zoomAnchorRef.current ?? { x: el.clientWidth / 2, y: 0 };
    zoomAnchorRef.current = null;
    const listY = el.scrollTop + anchor.y - VIEWPORT_PADDING;
    const heights = info.pages.map((page) => page.height ?? 792);
    const widest = info.pages.reduce((max, page) => Math.max(max, page.width ?? 612), 0);
    pendingScrollRef.current = {
      top: Math.max(0, zoomedListY(heights, PAGE_GAP, from, zoom, listY) + VIEWPORT_PADDING - anchor.y),
      left: zoomedScrollLeft(widest, el.clientWidth - 2 * VIEWPORT_PADDING, VIEWPORT_PADDING, from, zoom, el.scrollLeft, anchor.x),
      armed: false,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, rowVirtualizer]);

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const el = scrollRef.current;
    if (!pending || !el) return;
    if (!pending.armed) {
      pending.armed = true; // still the commit that changed zoom
      return;
    }
    pendingScrollRef.current = null;
    el.scrollTop = pending.top;
    el.scrollLeft = pending.left;
  });

  // A native, non-passive listener: React registers `onWheel` as passive, so its `preventDefault()`
  // is ignored and the wheel would still scroll the page while it zooms.
  useEffect(() => {
    const el = scrollEl;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const current = useViewerStore.getState().tabs.find((t) => t.docId === docId);
      if (!current) return;
      const deltaY = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 33 : e.deltaY;
      const next = clampZoom(current.zoom * Math.exp(-deltaY * 0.0015));
      if (next === current.zoom) return;
      const rect = el.getBoundingClientRect();
      zoomAnchorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      setZoom(docId, next, "custom");
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollEl, docId, setZoom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || zoomMode === "custom") return;

    const recompute = () => {
      const containerWidth = el.clientWidth - 2 * VIEWPORT_PADDING;
      const containerHeight = el.clientHeight - 2 * VIEWPORT_PADDING;
      const pageSize = info.pages[currentPage] ?? info.pages[0];
      if (!pageSize || containerWidth <= 0) return;
      const widthPt = pageSize.width ?? 612;
      const heightPt = pageSize.height ?? 792;
      const nextZoom =
        zoomMode === "fit-width" ? containerWidth / widthPt : Math.min(containerHeight / heightPt, containerWidth / widthPt);
      setZoom(docId, clampZoom(nextZoom), zoomMode);
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomMode, docId, currentPage, info.pages]);

  useEffect(() => {
    if (pendingScrollTo === null) return;
    rowVirtualizer.scrollToIndex(pendingScrollTo, { align: "start" });
    clearPendingScroll(docId);
  }, [pendingScrollTo, docId, rowVirtualizer, clearPendingScroll]);

  const items = rowVirtualizer.getVirtualItems();
  // `range` is the on-screen window; `items[0]` is the first OVERSCANNED row, up to 2 pages above it,
  // which would make the page indicator (and the outline's current entry) lag behind the scroll.
  const topVisibleIndex = rowVirtualizer.range?.startIndex ?? items[0]?.index;
  useEffect(() => {
    if (topVisibleIndex === undefined || topVisibleIndex === currentPage) return;
    setCurrentPage(docId, topVisibleIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topVisibleIndex, docId]);

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div
        ref={setScrollNode}
        className="relative h-full min-w-0 flex-1 overflow-auto bg-background px-6 py-6"
        style={{ paddingLeft: VIEWPORT_PADDING, paddingRight: VIEWPORT_PADDING, paddingTop: VIEWPORT_PADDING, paddingBottom: VIEWPORT_PADDING }}
        data-testid="viewer-scroll"
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {items.map((item) => {
            const pageSize = info.pages[item.index];
            if (!pageSize) return null;
            return (
              <div key={item.key} className="absolute left-0 flex w-max min-w-full justify-center" style={{ top: item.start, height: item.size }}>
                <PageCanvas
                  docId={docId}
                  page={item.index}
                  widthPt={pageSize.width ?? 612}
                  heightPt={pageSize.height ?? 792}
                  zoom={zoom}
                  rotation={0}
                  revision={info.revision}
                />
              </div>
            );
          })}
        </div>
      </div>
      {/* Outside the scrolling element, so it never scrolls. Its 30px are reserved even without results,
          so a search that starts or stops having hits does not resize the scroller and re-fit the width. */}
      <DensityMap docId={docId} pages={info.pages} zoom={zoom} scrollEl={scrollEl} />
    </div>
  );
}
