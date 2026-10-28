// Small pieces shared by the compact bar and the docked panel: the query field, the count/status
// label, the prev/next buttons and the thin progress bar. Everything reads the per-document
// search state straight from the store, so the two layouts cannot disagree.
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { IconButton } from "../../tokens/components";
import type { DocId } from "../types";
import { countText, searchTotal, type SearchVariant } from "./searchLabels";
import { useSearchPrefs } from "./searchPrefs";
import { useSearchStore } from "./searchStore";

interface PartProps {
  docId: DocId;
}

export function SearchField({ docId, inputRef, className }: PartProps & { inputRef: Ref<HTMLInputElement>; className?: string }) {
  const { t } = useTranslation("viewer");
  const query = useSearchStore((s) => s.byDoc[docId]?.query ?? "");
  return (
    <input
      ref={inputRef}
      data-testid="search-input"
      type="text"
      value={query}
      onChange={(e) => useSearchStore.getState().setQuery(docId, e.target.value)}
      onKeyDown={(e) => {
        // Enter / Shift+Enter belong to the field (a global Enter shortcut would hijack buttons);
        // F3, Esc and Ctrl+F are registered through the shortcut map (SearchPanel.tsx).
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (e.shiftKey) useSearchStore.getState().prevMatch(docId);
        else useSearchStore.getState().nextMatch(docId);
      }}
      placeholder={t("viewer.search.placeholder")}
      className={
        className ??
        "h-8 min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-2 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      }
    />
  );
}

export function SearchCount({ docId, variant, className }: PartProps & { variant: SearchVariant; className?: string }) {
  const { t } = useTranslation("viewer");
  const doc = useSearchStore((s) => s.byDoc[docId]);
  return (
    <span
      data-testid="search-count"
      data-total={searchTotal(doc)}
      data-done={doc?.done ? "true" : "false"}
      data-query={doc?.query ?? ""}
      aria-live="polite"
      className={className ?? "whitespace-nowrap tabular-nums"}
    >
      {countText(t, doc, variant)}
    </span>
  );
}

export function SearchNavButtons({ docId }: PartProps) {
  const { t } = useTranslation("viewer");
  const total = useSearchStore((s) => s.byDoc[docId]?.flat.length ?? 0);
  return (
    <>
      <IconButton
        aria-label={t("viewer.search.previous")}
        size="sm"
        disabled={total === 0}
        onClick={() => useSearchStore.getState().prevMatch(docId)}
      >
        <ChevronUp className="h-4 w-4" />
      </IconButton>
      <IconButton
        aria-label={t("viewer.search.next")}
        size="sm"
        disabled={total === 0}
        onClick={() => useSearchStore.getState().nextMatch(docId)}
      >
        <ChevronDown className="h-4 w-4" />
      </IconButton>
    </>
  );
}

/** Thin bar shown while a search runs ("página X de N"); renders nothing otherwise. */
export function SearchProgress({ docId, className }: PartProps & { className?: string }) {
  const { t } = useTranslation("viewer");
  const doc = useSearchStore((s) => s.byDoc[docId]);
  if (!doc || !doc.query.trim() || doc.done || !doc.searchId) return null;
  const max = Math.max(doc.pageCount, 1);
  const now = Math.min(doc.pagesSearched, max);
  return (
    <div
      role="progressbar"
      aria-label={t("viewer.search.searching")}
      aria-valuemin={0}
      aria-valuemax={doc.pageCount}
      aria-valuenow={now}
      className={className ?? "h-[3px] overflow-hidden rounded-sm bg-border"}
    >
      <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${(now / max) * 100}%` }} />
    </div>
  );
}

/** "Mais compactas" / "Por posição" — proximity only (phrase results are always in document order). */
export function SortSelect({ className }: { className?: string }) {
  const { t } = useTranslation("viewer");
  const mode = useSearchPrefs((s) => s.mode);
  const sort = useSearchPrefs((s) => s.sort);
  const setSort = useSearchPrefs((s) => s.setSort);
  if (mode !== "proximity") return null;
  return (
    <select
      aria-label={t("viewer.search.sortLabel")}
      data-testid="search-sort"
      value={sort}
      onChange={(e) => setSort(e.target.value === "position" ? "position" : "compact")}
      className={
        className ??
        "h-7 min-w-0 rounded-sm border border-transparent bg-transparent px-1 text-xs text-text hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      }
    >
      <option value="compact">{t("viewer.search.sortCompact")}</option>
      <option value="position">{t("viewer.search.sortPosition")}</option>
    </select>
  );
}
