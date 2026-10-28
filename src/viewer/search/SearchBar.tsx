// Compact search bar (Ctrl+F, mockup state 0): one floating line at the viewer's top-right, over
// the grey margin, with input, count, previous/next, expand and close. It is positioned inside a
// zero-width slot at the viewer's right edge (see SearchPanel), so it can never land on the tool
// panel, and scrolling to a hit keeps the hit below it (COMPACT_BAR_INSET).
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, X } from "lucide-react";
import { IconButton } from "../../tokens/components";
import type { DocId } from "../types";
import { closeSearch, setSearchMode } from "./searchController";
import { SearchNotice } from "./SearchNotices";
import { SearchCount, SearchField, SearchNavButtons, SearchProgress } from "./SearchParts";

export function SearchBar({ docId, inputRef }: { docId: DocId; inputRef: Ref<HTMLInputElement> }) {
  const { t } = useTranslation("viewer");
  return (
    <div
      data-testid="search-panel"
      data-mode="compact"
      role="search"
      className="absolute right-10 top-3 flex w-[min(420px,calc(100vw-2rem))] flex-col text-xs text-muted-text"
    >
      <div className="relative flex items-center gap-1 rounded-md border border-border bg-surface-raised p-1.5 shadow-menu">
        <SearchField
          docId={docId}
          inputRef={inputRef}
          className="h-7 min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-2 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
        <SearchCount docId={docId} variant="bar" className="whitespace-nowrap px-1 tabular-nums" />
        <SearchNavButtons docId={docId} />
        <IconButton aria-label={t("viewer.search.expand")} size="sm" onClick={() => setSearchMode("docked")}>
          <Maximize2 className="h-4 w-4" />
        </IconButton>
        <IconButton data-testid="search-close" aria-label={t("viewer.search.close")} size="sm" onClick={() => closeSearch(docId)}>
          <X className="h-4 w-4" />
        </IconButton>
        <SearchProgress docId={docId} className="absolute inset-x-2 bottom-0 h-[2px] overflow-hidden rounded-sm" />
      </div>
      <SearchNotice docId={docId} variant="bar" />
    </div>
  );
}
