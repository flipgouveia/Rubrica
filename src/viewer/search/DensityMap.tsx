// Density map (search v2, docs/mockups/search-v2.html "Mapa de densidade"): a 30px strip glued to
// the right of the page scroller that shows where the search hits are — one bucket per page (a
// run of pages when the document has more pages than the strip has pixels), darker with more
// hits (log scale), chapter ticks, the rectangle of the area on screen and an amber triangle at
// the active hit. Hover/focus shows "p. 16–17 · 4 zonas · 3.2 Por incumprimento"; clicking jumps
// to the first hit from there.
//
// The strip's width is reserved whether or not there are results (the empty gutter just looks
// like a wider margin): otherwise every keystroke that flips "has results" would resize the
// scroller and make the fit-width zoom jump. Search state is read only through `selectors.ts`.
//
// Accessibility: the picture is `role="img"` with a textual summary; because an image's children
// are presentational, the keyboard alternative is a sibling group of real buttons laid over the
// buckets (one per non-empty bucket, roving tabindex, arrow keys, Enter) whose labels spell out
// the pages, the count and the chapter, so nothing depends on colour.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { clsx } from "clsx";
import type { PageSize } from "../../ipc/bindings";
import { deepestItemForPage, useOutline } from "../outline/outlineStore";
import type { DocId } from "../types";
import {
  activeMarkerPosition,
  bucketAtFraction,
  computeBuckets,
  chapterTicks,
  pageAtFraction,
  summarizeHits,
  viewportRect,
} from "./DensityMapModel";
import type { DensityBucket, ViewportRect } from "./DensityMapModel";
import { activateFirstHitFrom, useActiveHit, useHasResults, useHitCountsByPage, useResultKind } from "./selectors";

const DEFAULT_TRACK_HEIGHT = 600;

interface DensityMapProps {
  docId: DocId;
  pages: readonly PageSize[];
  zoom: number;
  /** The page scroller the strip mirrors (its scroll position drives the viewport rectangle). */
  scrollEl: HTMLElement | null;
}

function pagesLabel(t: TFunction, fromPage: number, toPage: number): string {
  return fromPage === toPage
    ? t("viewer.density.pageSingle", { page: fromPage + 1 })
    : t("viewer.density.pageRange", { from: fromPage + 1, to: toPage + 1 });
}

export function DensityMap({ docId, pages, zoom, scrollEl }: DensityMapProps) {
  const hasResults = useHasResults(docId);
  if (!hasResults) return <div data-testid="density-gutter" aria-hidden="true" className="w-[30px] shrink-0" />;
  return <DensityStrip docId={docId} pages={pages} zoom={zoom} scrollEl={scrollEl} />;
}

function useTrackHeight(trackRef: React.RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(DEFAULT_TRACK_HEIGHT);
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight > 0 ? el.clientHeight : DEFAULT_TRACK_HEIGHT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [trackRef]);
  return height;
}

function useViewport(scrollEl: HTMLElement | null, pages: readonly PageSize[], zoom: number): ViewportRect | null {
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    if (!scrollEl) return;
    const read = () => setScroll((prev) => (prev.top === scrollEl.scrollTop && prev.height === scrollEl.clientHeight ? prev : { top: scrollEl.scrollTop, height: scrollEl.clientHeight }));
    read();
    scrollEl.addEventListener("scroll", read, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(scrollEl);
    return () => {
      scrollEl.removeEventListener("scroll", read);
      observer?.disconnect();
    };
  }, [scrollEl]);
  return useMemo(
    () => (scrollEl ? viewportRect({ pages, zoom, scrollTop: scroll.top, clientHeight: scroll.height }) : null),
    [scrollEl, pages, zoom, scroll],
  );
}

function DensityStrip({ docId, pages, zoom, scrollEl }: DensityMapProps) {
  const { t } = useTranslation("viewer");
  const pageCount = pages.length;
  const counts = useHitCountsByPage(docId);
  const active = useActiveHit(docId);
  const kind = useResultKind(docId);
  const outline = useOutline(docId);
  const trackRef = useRef<HTMLDivElement>(null);
  const trackHeight = useTrackHeight(trackRef);
  const viewport = useViewport(scrollEl, pages, zoom);

  const buckets = useMemo(() => computeBuckets({ pageCount, counts, trackHeightPx: trackHeight }), [pageCount, counts, trackHeight]);
  const outlineItems = outline.status === "ready" ? outline.items : null;
  const ticks = useMemo(() => (outlineItems ? chapterTicks(outlineItems, pageCount) : []), [outlineItems, pageCount]);
  const summary = useMemo(() => summarizeHits(counts), [counts]);
  const markerAt = active ? activeMarkerPosition(active.page, pageCount) : null;
  const activeBucketIndex = active ? (buckets.find((b) => active.page >= b.fromPage && active.page <= b.toPage)?.index ?? null) : null;

  const [hovered, setHovered] = useState<number | null>(null);
  const [roving, setRoving] = useState(0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabbable = Math.min(roving, Math.max(0, buckets.length - 1));

  const unitOf = (count: number) => t(kind === "proximity" ? "viewer.density.unitZones" : "viewer.density.unitResults", { count });
  const describe = (bucket: DensityBucket): string => {
    const chapter = outlineItems ? deepestItemForPage(outlineItems, bucket.fromPage) : null;
    const params = { pages: pagesLabel(t, bucket.fromPage, bucket.toPage), count: bucket.count, unit: unitOf(bucket.count) };
    return chapter ? t("viewer.density.tooltipChapter", { ...params, chapter: chapter.title }) : t("viewer.density.tooltip", params);
  };
  const jump = (bucket: DensityBucket) => activateFirstHitFrom(docId, bucket.fromPage);

  const fractionOf = (event: MouseEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
  };
  const onTrackMove = (event: MouseEvent<HTMLDivElement>) => {
    setHovered(bucketAtFraction(buckets, fractionOf(event), trackHeight)?.index ?? null);
  };
  // Clicking the empty part of the strip behaves like clicking a scrollbar: first hit from there on.
  const onTrackClick = (event: MouseEvent<HTMLDivElement>) => {
    const fraction = fractionOf(event);
    const bucket = bucketAtFraction(buckets, fraction, trackHeight);
    activateFirstHitFrom(docId, bucket ? bucket.fromPage : pageAtFraction(fraction, pageCount));
  };

  const focusBucket = (index: number) => {
    const next = Math.max(0, Math.min(buckets.length - 1, index));
    setRoving(next);
    buttonRefs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        focusBucket(tabbable + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        focusBucket(tabbable - 1);
        break;
      case "Home":
        focusBucket(0);
        break;
      case "End":
        focusBucket(buckets.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // Keep the keyboard group's roving stop on the active hit's bucket when the active hit moves.
  useEffect(() => {
    if (activeBucketIndex !== null) setRoving(activeBucketIndex);
  }, [activeBucketIndex]);

  const hoveredBucket = hovered !== null ? (buckets[hovered] ?? null) : null;
  const summaryText = summary
    ? t("viewer.density.summary", {
        count: summary.total,
        unit: unitOf(summary.total),
        from: summary.firstPage + 1,
        to: summary.lastPage + 1,
        densest: summary.densestPage + 1,
      })
    : t("viewer.density.summaryEmpty");

  return (
    <div data-testid="density-strip" className="relative z-10 w-[30px] shrink-0 border-l border-border bg-surface/85">
      <div ref={trackRef} className="absolute inset-2" onMouseMove={onTrackMove} onMouseLeave={() => setHovered(null)} onClick={onTrackClick}>
        <div role="img" aria-label={summaryText} data-testid="density-map" className="absolute inset-0">
          {ticks.map((fraction) => (
            <div key={fraction} data-testid="density-tick" className="absolute -left-2 -right-2 h-px bg-border-strong" style={{ top: `${fraction * 100}%` }} />
          ))}
          {buckets.map((bucket) => (
            <div
              key={bucket.fromPage}
              data-testid="density-bucket"
              data-from-page={bucket.fromPage}
              data-to-page={bucket.toPage}
              data-count={bucket.count}
              className="absolute left-0 right-0 rounded-[1px] bg-accent"
              style={{ top: `${bucket.top * 100}%`, height: `${bucket.height * 100}%`, minHeight: 2, opacity: bucket.opacity }}
            />
          ))}
          {viewport && (
            <div
              data-testid="density-viewport"
              className="absolute -left-[5px] -right-[5px] rounded-[3px] border-[1.5px] border-text opacity-55"
              style={{ top: `${viewport.top * 100}%`, height: `${viewport.height * 100}%`, minHeight: 4 }}
            />
          )}
          {markerAt !== null && (
            <div
              data-testid="density-active"
              className="absolute -left-[7px] h-0 w-0 border-y-[5px] border-l-[6px] border-y-transparent border-l-[var(--search-active)]"
              style={{ top: `calc(${markerAt * 100}% - 5px)` }}
            />
          )}
        </div>

        <div role="group" aria-label={t("viewer.density.navLabel")} className="absolute inset-0" onKeyDown={onKeyDown}>
          {buckets.map((bucket) => {
            const isActive = bucket.index === activeBucketIndex;
            const label = t("viewer.density.jump", { pages: pagesLabel(t, bucket.fromPage, bucket.toPage) });
            return (
              <button
                key={bucket.fromPage}
                ref={(el) => {
                  buttonRefs.current[bucket.index] = el;
                }}
                type="button"
                data-testid="density-jump"
                aria-label={isActive ? `${label}. ${t("viewer.density.activeResult")}` : label}
                aria-description={describe(bucket)}
                aria-current={isActive ? "true" : undefined}
                tabIndex={bucket.index === tabbable ? 0 : -1}
                className={clsx(
                  "absolute -left-1 -right-1 cursor-pointer rounded-[2px] bg-transparent p-0",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring",
                )}
                style={{ top: `${bucket.top * 100}%`, height: `${bucket.height * 100}%`, minHeight: 6 }}
                onClick={(event) => {
                  event.stopPropagation();
                  jump(bucket);
                }}
                onFocus={() => {
                  setRoving(bucket.index);
                  setHovered(bucket.index);
                }}
                onBlur={() => setHovered((current) => (current === bucket.index ? null : current))}
              />
            );
          })}
        </div>

        {hoveredBucket && (
          <div
            data-testid="density-tooltip"
            aria-hidden="true"
            className="pointer-events-none absolute right-full z-20 mr-3 -translate-y-1/2 whitespace-nowrap rounded-sm bg-text px-2 py-1 text-xs text-background shadow-menu"
            style={{ top: `${(hoveredBucket.top + hoveredBucket.height / 2) * 100}%` }}
          >
            {describe(hoveredBucket)}
          </div>
        )}
      </div>
    </div>
  );
}
