// Virtualized result list (B6, mockup states 1/A/B): hits grouped by the deepest outline entry
// (collapsible, with a sticky header and a count), one row per HIT — "p. N" (or "p. N–M" plus "Atravessa
// a mudança de página" when it spans a page break), the window length in proximity, and a two-line
// snippet with every term coloured by its position (`context.terms`). Without an outline the list is
// flat. The ORDER shown is the store's `flat` order ("por posição" / "mais compactas"), which is also
// what "X de N" and next/previous walk. Only the rows in view are mounted.
import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SearchHit } from "../../ipc/bindings";
import { flattenOutline, useOutline } from "../outline/outlineStore";
import type { DocId } from "../types";
import { highlightFill } from "./searchColors";
import { groupKey, type HitGroup, type HitRef } from "./searchOrder";
import { useSearchPrefs } from "./searchPrefs";
import { useSearchStore } from "./searchStore";

const GROUP_HEIGHT = 30;
const ROW_HEIGHT = 58;
const ROW_HEIGHT_WITH_META = 74;

type Row =
  | { kind: "group"; group: HitGroup; collapsed: boolean }
  | { kind: "hit"; ref: HitRef; flatIndex: number };

/** The snippet of one hit: before + the matched text with each term in its position's colour + after. */
function Snippet({ hit, colors }: { hit: SearchHit; colors: readonly string[] }) {
  const { before, matched, after, terms } = hit.context;
  const pieces: { text: string; term: number | null }[] = [];
  if (terms.length === 0) {
    pieces.push({ text: matched, term: 0 });
  } else {
    let cursor = 0;
    for (const term of [...terms].sort((a, b) => a.start - b.start)) {
      if (term.start < cursor || term.len <= 0) continue; // overlapping/degenerate: skip
      if (term.start > cursor) pieces.push({ text: matched.slice(cursor, term.start), term: null });
      pieces.push({ text: matched.slice(term.start, term.start + term.len), term: term.term });
      cursor = term.start + term.len;
    }
    if (cursor < matched.length) pieces.push({ text: matched.slice(cursor), term: null });
  }
  return (
    <>
      {before}
      {pieces.map((piece, i) =>
        piece.term === null ? (
          <Fragment key={i}>{piece.text}</Fragment>
        ) : (
          <mark key={i} data-term={piece.term} className="rounded-[2px] px-px text-inherit" style={{ background: highlightFill(colors, piece.term) }}>
            {piece.text}
          </mark>
        ),
      )}
      {after}
    </>
  );
}

export function SearchResultsList({ docId }: { docId: DocId }) {
  const { t } = useTranslation("viewer");
  const hitsByPage = useSearchStore((s) => s.byDoc[docId]?.hitsByPage);
  const groups = useSearchStore((s) => s.byDoc[docId]?.groups);
  const grouped = useSearchStore((s) => s.byDoc[docId]?.grouped ?? false);
  const collapsed = useSearchStore((s) => s.byDoc[docId]?.collapsed);
  const activeIndex = useSearchStore((s) => s.byDoc[docId]?.activeIndex ?? -1);
  const total = useSearchStore((s) => s.byDoc[docId]?.flat.length ?? 0);
  const colors = useSearchPrefs((s) => s.highlightColors);
  const outline = useOutline(docId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    if (outline.status === "ready") for (const item of flattenOutline(outline.items)) map.set(item.id, item.title);
    return map;
  }, [outline]);

  // Rows in visible order; a collapsed group keeps its place in `flat` (so the counts and next/previous
  // still cover it) but contributes only its header.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let flatIndex = 0;
    for (const group of groups ?? []) {
      const isCollapsed = grouped && Boolean(collapsed?.[groupKey(group.id)]);
      if (grouped) out.push({ kind: "group", group, collapsed: isCollapsed });
      for (const ref of group.refs) {
        if (!isCollapsed) out.push({ kind: "hit", ref, flatIndex });
        flatIndex++;
      }
    }
    return out;
  }, [groups, grouped, collapsed]);

  const stickyIndexes = useMemo(() => rows.flatMap((row, i) => (row.kind === "group" ? [i] : [])), [rows]);
  const activeSticky = useRef(-1);
  const rangeExtractor = useCallback(
    (range: Range) => {
      activeSticky.current = [...stickyIndexes].reverse().find((i) => range.startIndex >= i) ?? -1;
      const indexes = new Set([...(activeSticky.current >= 0 ? [activeSticky.current] : []), ...defaultRangeExtractor(range)]);
      return [...indexes].sort((a, b) => a - b);
    },
    [stickyIndexes],
  );

  const rowHeight = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return ROW_HEIGHT;
      if (row.kind === "group") return GROUP_HEIGHT;
      return hitsByPage?.[row.ref.page]?.[row.ref.hitIndex]?.spansPages ? ROW_HEIGHT_WITH_META : ROW_HEIGHT;
    },
    [rows, hitsByPage],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: rowHeight,
    overscan: 6,
    rangeExtractor,
  });

  const activeRow = useMemo(() => rows.findIndex((row) => row.kind === "hit" && row.flatIndex === activeIndex), [rows, activeIndex]);
  useEffect(() => {
    if (activeRow >= 0) virtualizer.scrollToIndex(activeRow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRow]);

  if (!hitsByPage || !groups || total === 0) return null;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-t border-border" data-testid="search-results">
      <ul aria-label={t("viewer.search.resultsList")} className="relative m-0 list-none p-0" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;

          if (row.kind === "group") {
            const title = row.group.id === null ? t("viewer.search.groupNoChapter") : (titles.get(row.group.id) ?? row.group.id);
            const sticky = item.index === activeSticky.current;
            return (
              <li
                key={`group:${groupKey(row.group.id)}`}
                data-testid="search-group"
                style={sticky ? { position: "sticky", top: 0, zIndex: 1, height: item.size } : { position: "absolute", top: 0, left: 0, width: "100%", height: item.size, transform: `translateY(${item.start}px)` }}
                className="flex items-center border-b border-border bg-background"
              >
                <button
                  type="button"
                  aria-expanded={!row.collapsed}
                  aria-label={t(row.collapsed ? "viewer.search.groupExpand" : "viewer.search.groupCollapse", { title })}
                  onClick={() => useSearchStore.getState().toggleGroup(docId, row.group.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left text-xs font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
                >
                  {row.collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                  <span className="min-w-0 truncate">{title}</span>
                </button>
                <span aria-label={t("viewer.search.groupCount", { title, count: row.group.refs.length })} className="pr-2.5 text-xs font-medium tabular-nums text-muted-text">
                  {row.group.refs.length}
                </span>
              </li>
            );
          }

          const { ref, flatIndex } = row;
          const hit = hitsByPage[ref.page]?.[ref.hitIndex];
          if (!hit) return null;
          const { before, matched, after } = hit.context;
          const isActive = flatIndex === activeIndex;
          const span = hit.spansPages;
          return (
            <li
              key={`${ref.page}:${ref.hitIndex}`}
              aria-posinset={flatIndex + 1}
              aria-setsize={total}
              className="absolute left-0 top-0 w-full"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <button
                type="button"
                aria-label={`${t("viewer.search.hitLabel", { page: ref.page + 1 })}: ${before}${matched}${after}`}
                aria-current={isActive ? "true" : undefined}
                onClick={() => useSearchStore.getState().setActiveIndex(docId, flatIndex)}
                className={
                  "grid h-full w-full grid-cols-[3rem_1fr] gap-2 border-b border-border/60 px-2.5 py-1.5 text-left " +
                  (isActive
                    ? "bg-accent/10 shadow-[inset_3px_0_0_var(--rubrica-accent)]"
                    : "hover:bg-border/40 focus-visible:bg-border/40")
                }
              >
                <span className="pt-0.5 text-[11px] tabular-nums text-muted-text">
                  {span ? t("viewer.search.pageRange", { from: span[0] + 1, to: span[1] + 1 }) : t("viewer.search.pageShort", { page: ref.page + 1 })}
                  {hit.score !== null && <small className="block text-[10px]">{t("viewer.search.windowLength", { count: hit.score })}</small>}
                </span>
                {/* The clamp lives on an inner element: a grid item is blockified, which turns the clamp's `-webkit-box` into `flow-root` and disables it. */}
                <span className="min-w-0">
                  <span className="line-clamp-2 text-[12.5px] leading-[1.45] text-text">
                    <Snippet hit={hit} colors={colors} />
                  </span>
                  {span && <span className="mt-0.5 block text-[10.5px] text-muted-text">{t("viewer.search.spansPages")}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
