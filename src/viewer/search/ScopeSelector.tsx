// Scope selector (mockup states 1, C, E): whole document · current chapter (the TOP-LEVEL outline
// entry holding the visible page) · "choose chapter" tree with page ranges · a page range (1-based
// here, 0-based over IPC). Every option shows its page count. Without an outline the chapter options
// are disabled and the popover says why; the page range always works.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronDown, ChevronRight, FileText } from "lucide-react";
import type { OutlineItem } from "../../ipc/bindings";
import { topLevelItemForPage, useOutline } from "../outline/outlineStore";
import { useTabByDocId } from "../store";
import type { DocId } from "../types";
import { scopeLabel } from "./searchLabels";
import { ancestorIds, isUsableItem, itemPageCount, resolveScope, SCOPE_ALL, type ScopeChoice } from "./searchScope";
import { useSearchStore } from "./searchStore";
import { useDismissable } from "./useDismissable";

const rangeOf = (item: OutlineItem) => `${(item.page ?? 0) + 1}–${(item.pageEnd ?? 0) + 1}`;

function Option({
  selected,
  disabled,
  title,
  onClick,
  icon,
  children,
  count,
}: {
  selected: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
  count?: string;
}) {
  return (
    <span title={disabled ? title : undefined} className="block">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={selected}
        onClick={onClick}
        className={
          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60 " +
          (selected ? "bg-accent/12 font-semibold text-accent" : "text-text hover:bg-border/40")
        }
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {count && <small className="shrink-0 text-[11px] font-normal text-muted-text">{count}</small>}
      </button>
    </span>
  );
}

function ChapterTree({
  items,
  selectedId,
  expanded,
  toggle,
  choose,
}: {
  items: OutlineItem[];
  selectedId: string | null;
  expanded: Set<string>;
  toggle: (id: string) => void;
  choose: (item: OutlineItem) => void;
}) {
  const { t } = useTranslation("viewer");
  return (
    <ul className="m-0 list-none p-0">
      {items.map((item) => {
        const open = expanded.has(item.id);
        const usable = isUsableItem(item);
        return (
          <li key={item.id}>
            <div className="flex items-center" style={{ paddingLeft: item.depth * 14 }}>
              {item.children.length > 0 ? (
                <button
                  type="button"
                  aria-label={t(open ? "viewer.search.groupCollapse" : "viewer.search.groupExpand", { title: item.title })}
                  aria-expanded={open}
                  onClick={() => toggle(item.id)}
                  className="grid h-6 w-5 shrink-0 place-items-center text-muted-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}
              <button
                type="button"
                disabled={!usable}
                aria-pressed={selectedId === item.id}
                onClick={() => choose(item)}
                className={
                  "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 " +
                  (selectedId === item.id ? "bg-accent/12 font-semibold text-accent" : "text-text hover:bg-border/40")
                }
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {usable && <span className="shrink-0 text-[11px] tabular-nums text-muted-text">{rangeOf(item)}</span>}
              </button>
            </div>
            {open && item.children.length > 0 && (
              <ChapterTree items={item.children} selectedId={selectedId} expanded={expanded} toggle={toggle} choose={choose} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function parsePage(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function ScopeSelector({ docId }: { docId: DocId }) {
  const { t } = useTranslation("viewer");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { ref, onKeyDown } = useDismissable<HTMLDivElement>(open, close);
  const choice = useSearchStore((s) => s.byDoc[docId]?.scope ?? SCOPE_ALL);
  const tab = useTabByDocId(docId);
  const outline = useOutline(docId);
  const pageCount = tab?.info.pageCount ?? 0;
  const currentPage = tab?.currentPage ?? 0;
  const items = useMemo(() => (outline.status === "ready" ? outline.items : []), [outline]);
  const hasOutline = items.length > 0;
  const resolved = resolveScope(choice, items, currentPage, pageCount);
  const currentChapter = topLevelItemForPage(items, currentPage);
  const selectedChapterId = choice.kind === "chapter" ? choice.itemId : null;

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [fromDraft, setFromDraft] = useState(choice.kind === "pages" ? String(choice.from ?? "") : "1");
  const [toDraft, setToDraft] = useState(choice.kind === "pages" ? String(choice.to ?? "") : String(pageCount));

  const setScope = (scope: ScopeChoice) => useSearchStore.getState().setScope(docId, scope);
  const toggleOpen = () => {
    if (!open && selectedChapterId) setExpanded(new Set([...expanded, ...ancestorIds(items, selectedChapterId)]));
    setOpen(!open);
  };
  const commitPages = (from: string, to: string) => setScope({ kind: "pages", from: parsePage(from), to: parsePage(to) });
  const noOutlineHint = outline.status !== "loading" && !hasOutline ? t("viewer.search.scopeNoOutline") : undefined;

  return (
    <div className="flex items-center gap-1.5 px-2 pb-2">
      <span className="shrink-0 text-xs text-muted-text">{t("viewer.search.scope")}</span>
      <div ref={ref} onKeyDown={onKeyDown} className="relative min-w-0 flex-1">
        <button
          type="button"
          data-testid="search-scope"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggleOpen}
          className="flex h-7 w-full items-center gap-1.5 rounded-sm border border-border-strong bg-surface px-2 text-left text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {choice.kind === "all" ? <FileText className="h-3.5 w-3.5 shrink-0" /> : <BookOpen className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{scopeLabel(t, choice, resolved)}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-text" />
        </button>

        {open && (
          <div
            role="dialog"
            aria-label={t("viewer.search.scope")}
            className="absolute left-0 top-full z-30 mt-1 w-[min(300px,calc(100vw-2rem))] rounded-md border border-border bg-surface-raised p-1.5 text-sm text-text shadow-menu"
          >
            <Option
              selected={choice.kind === "all"}
              icon={<FileText className="h-3.5 w-3.5 shrink-0" />}
              count={t("viewer.search.scopePageCount", { count: pageCount })}
              onClick={() => {
                setScope({ kind: "all" });
                close();
              }}
            >
              {t("viewer.search.scopeAll")}
            </Option>
            <Option
              selected={choice.kind === "currentChapter"}
              disabled={!hasOutline}
              title={noOutlineHint}
              icon={<BookOpen className="h-3.5 w-3.5 shrink-0" />}
              count={currentChapter ? t("viewer.search.scopePageCount", { count: itemPageCount(currentChapter) }) : undefined}
              onClick={() => {
                setScope({ kind: "currentChapter" });
                close();
              }}
            >
              {currentChapter
                ? t("viewer.search.scopeCurrentChapterNamed", { title: currentChapter.title })
                : t("viewer.search.scopeCurrentChapter")}
            </Option>

            <hr className="my-1.5 border-border" />
            <p className="m-0 px-2 pb-1 text-[11px] text-muted-text">{t("viewer.search.scopeChooseChapter")}</p>
            {hasOutline ? (
              <div className="max-h-40 overflow-auto pl-1" data-testid="scope-tree">
                <ChapterTree
                  items={items}
                  selectedId={selectedChapterId}
                  expanded={expanded}
                  toggle={(id) =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  choose={(item) => {
                    setScope({ kind: "chapter", itemId: item.id });
                    close();
                  }}
                />
              </div>
            ) : (
              noOutlineHint && (
                <p role="note" className="m-0 mx-1 rounded-sm bg-text px-2 py-1 text-[11.5px] text-background">
                  {noOutlineHint}
                </p>
              )
            )}

            <hr className="my-1.5 border-border" />
            <div className="flex items-center gap-1.5 px-2 py-1 text-xs">
              <span className={choice.kind === "pages" ? "font-semibold text-accent" : undefined}>{t("viewer.search.scopePages")}</span>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={fromDraft}
                aria-label={t("viewer.search.scopePagesFrom")}
                onChange={(e) => {
                  setFromDraft(e.target.value);
                  commitPages(e.target.value, toDraft);
                }}
                className="h-7 w-14 rounded-sm border border-border-strong bg-surface px-2 text-right tabular-nums"
              />
              <span>{t("viewer.search.scopePagesTo")}</span>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={toDraft}
                aria-label={t("viewer.search.scopePagesUntil")}
                onChange={(e) => {
                  setToDraft(e.target.value);
                  commitPages(fromDraft, e.target.value);
                }}
                className="h-7 w-14 rounded-sm border border-border-strong bg-surface px-2 text-right tabular-nums"
              />
            </div>
            {resolved.kind === "invalidPages" ? (
              <p role="alert" className="m-0 px-2 pb-1 text-[11px] text-danger">
                {t("viewer.search.scopeInvalidRange")}
              </p>
            ) : (
              <p className="m-0 px-2 pb-1 text-[11px] text-muted-text">{t("viewer.search.scopePagesHint", { count: pageCount })}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
