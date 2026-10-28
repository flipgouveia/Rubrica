// "Índice" tab of the side panel (docs/mockups/search-v2.html, "Painel Índice"): the PDF's
// bookmarks as a collapsible tree with page numbers. Click/Enter goes to the page; the DEEPEST
// entry that contains the visible page carries an accent bar and follows the scroll (this is not
// the search scope's "current chapter", which is the top-level entry); with a search showing
// results, every entry shows how many hits it holds, counting its sub-entries.
//
// ARIA: a flat tree (`role="tree"`, rows are `treeitem`s with aria-level/posinset/setsize, no nested
// groups) with one tab stop (roving tabindex): Up/Down move, Right expands or enters the first
// child, Left collapses or goes to the parent, Home/End, Enter/Space navigate.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { OutlineItem } from "../../ipc/bindings";
import { useHasResults, useHitCountsByOutlineItem } from "../search/selectors";
import { useTabByDocId, useViewerStore } from "../store";
import type { DocId } from "../types";
import { aggregateHitCounts, defaultExpanded, highlightedRowId, visibleRows } from "./outlineModel";
import { deepestItemForPage, useOutline } from "./outlineStore";

const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();

export function OutlinePanel({ docId }: { docId: DocId }) {
  const { t } = useTranslation("viewer");
  const outline = useOutline(docId);
  const revision = useTabByDocId(docId)?.info.revision ?? 0;

  if (outline.status === "loading") {
    return (
      <p role="status" className="p-4 text-sm text-muted-text">
        {t("viewer.outline.loading")}
      </p>
    );
  }
  if (outline.status === "error") {
    return (
      <p role="alert" className="p-4 text-sm text-danger">
        {t("viewer.outline.error")}
      </p>
    );
  }
  if (outline.items.length === 0) {
    return (
      <p role="status" className="p-4 text-sm text-muted-text">
        {t("viewer.outline.empty")}
      </p>
    );
  }
  // Re-seed the expansion state when an edit changes the outline.
  return <OutlineTree key={revision} docId={docId} items={outline.items} />;
}

function OutlineTree({ docId, items }: { docId: DocId; items: OutlineItem[] }) {
  const { t } = useTranslation("viewer");
  const ids = useId();
  const currentPage = useTabByDocId(docId)?.currentPage ?? 0;
  const hasResults = useHasResults(docId);
  const ownCounts = useHitCountsByOutlineItem(docId);

  // Until the user opens or closes something, the open entries follow the visible page; after that
  // the user's choice is kept (the current entry then shows through its collapsed ancestor).
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string> | null>(null);
  const expanded = useMemo(() => userExpanded ?? defaultExpanded(items, currentPage), [userExpanded, items, currentPage]);
  const rows = useMemo(() => visibleRows(items, expanded), [items, expanded]);
  const currentId = useMemo(() => deepestItemForPage(items, currentPage)?.id ?? null, [items, currentPage]);
  const markerId = highlightedRowId(items, currentId, expanded);
  const totals = useMemo(() => aggregateHitCounts(items, hasResults ? ownCounts : EMPTY_COUNTS), [items, hasResults, ownCounts]);

  const [focusId, setFocusId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const tabStopId = rows.some((row) => row.item.id === focusId) ? focusId : (rows.find((row) => row.item.id === markerId)?.item.id ?? rows[0]?.item.id);

  // Keep the marked row in view as the viewer scrolls (without stealing focus).
  useEffect(() => {
    if (markerId) rowRefs.current.get(markerId)?.scrollIntoView({ block: "nearest" });
  }, [markerId]);

  const toggle = (id: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    setUserExpanded(next);
  };
  const go = (item: OutlineItem) => {
    if (item.page !== null) useViewerStore.getState().scrollToPage(docId, item.page);
  };
  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    rowRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset.id;
    const index = rows.findIndex((row) => row.item.id === id);
    if (index === -1) return;
    const { item, parentId } = rows[index];
    const hasChildren = item.children.length > 0;
    const isOpen = hasChildren && expanded.has(item.id);
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[index + 1]?.item.id);
        break;
      case "ArrowUp":
        focusRow(rows[index - 1]?.item.id);
        break;
      case "Home":
        focusRow(rows[0].item.id);
        break;
      case "End":
        focusRow(rows[rows.length - 1].item.id);
        break;
      case "ArrowRight":
        if (hasChildren && !isOpen) toggle(item.id, true);
        else if (isOpen) focusRow(item.children[0].id);
        break;
      case "ArrowLeft":
        if (isOpen) toggle(item.id, false);
        else focusRow(parentId ?? undefined);
        break;
      case "Enter":
      case " ":
        go(item);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div role="tree" aria-label={t("viewer.outline.treeLabel")} className="p-1.5 text-[13px]" onKeyDown={onKeyDown}>
      {rows.map(({ item, level, posInSet, setSize }) => {
        const hasChildren = item.children.length > 0;
        const isOpen = hasChildren && expanded.has(item.id);
        const isCurrent = item.id === currentId;
        const isMarked = item.id === markerId;
        const hits = totals.get(item.id) ?? 0;
        const navigable = item.page !== null;
        return (
          <div
            key={item.id}
            ref={(el) => {
              if (el) rowRefs.current.set(item.id, el);
              else rowRefs.current.delete(item.id);
            }}
            role="treeitem"
            data-id={item.id}
            data-current={isMarked ? (isCurrent ? "true" : "contains") : undefined}
            aria-level={level}
            aria-posinset={posInSet}
            aria-setsize={setSize}
            aria-expanded={hasChildren ? isOpen : undefined}
            aria-selected={isCurrent}
            aria-disabled={navigable ? undefined : true}
            // The name is the title alone; page, count and "current" are the description (the
            // chevron button inside would otherwise leak its own label into the name).
            aria-labelledby={`${ids}-title-${item.id}`}
            aria-describedby={[isCurrent && "current", hits > 0 && "hits", "page"]
              .filter(Boolean)
              .map((part) => `${ids}-${part}-${item.id}`)
              .join(" ")}
            tabIndex={item.id === tabStopId ? 0 : -1}
            title={navigable ? t("viewer.outline.goTo", { title: item.title, page: (item.page ?? 0) + 1 }) : undefined}
            className={clsx(
              "relative flex items-center gap-1.5 rounded-sm py-[5px] pr-1.5 text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              navigable ? "cursor-pointer hover:bg-accent/5" : "cursor-default text-muted-text",
              isMarked && "bg-accent/10",
            )}
            style={{ paddingLeft: 6 + (level - 1) * 16 }}
            onClick={() => {
              setFocusId(item.id);
              go(item);
            }}
            onFocus={(event) => {
              if (event.target === event.currentTarget) setFocusId(item.id);
            }}
          >
            {isMarked && (
              <span
                aria-hidden="true"
                className={clsx("absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-sm bg-accent", !isCurrent && "opacity-50")}
              />
            )}
            {hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={t(isOpen ? "viewer.outline.collapse" : "viewer.outline.expand", { title: item.title })}
                className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-text hover:text-text"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(item.id, !isOpen);
                }}
              >
                {isOpen ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
              </button>
            ) : (
              <span aria-hidden="true" className="h-4 w-4 shrink-0" />
            )}
            <span id={`${ids}-title-${item.id}`} className={clsx("min-w-0 flex-1 truncate", hits > 0 && level === 1 && "font-semibold")}>
              {item.title}
            </span>
            {isCurrent && (
              <span id={`${ids}-current-${item.id}`} className="sr-only">
                {t("viewer.outline.current")}
              </span>
            )}
            {hits > 0 && (
              <span
                id={`${ids}-hits-${item.id}`}
                data-testid="outline-hit-count"
                className="shrink-0 rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent"
              >
                <span aria-hidden="true">{hits}</span>
                <span className="sr-only">{t("viewer.outline.hitCount", { count: hits })}</span>
              </span>
            )}
            {navigable ? (
              <span id={`${ids}-page-${item.id}`} className="shrink-0 text-[11px] tabular-nums text-muted-text">
                <span aria-hidden="true">{(item.page ?? 0) + 1}</span>
                <span className="sr-only">{t("viewer.outline.page", { page: (item.page ?? 0) + 1 })}</span>
              </span>
            ) : (
              <span id={`${ids}-page-${item.id}`} className="shrink-0 text-[11px] italic text-muted-text">
                {t("viewer.outline.noPage")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
