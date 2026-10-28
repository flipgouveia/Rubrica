// Text shown in the search status area, derived from one document's search state. Pure, so the
// bar and the panel agree and the logic is unit-testable without rendering.
import type { TFunction } from "i18next";
import type { ResolvedScope, ScopeChoice } from "./searchScope";
import type { DocSearch } from "./searchStore";

/** The text of the closed scope selector: what the current choice resolves to right now. */
export function scopeLabel(t: TFunction, choice: ScopeChoice, resolved: ResolvedScope): string {
  switch (resolved.kind) {
    case "all":
      return choice.kind === "currentChapter" ? t("viewer:viewer.search.scopeCurrentChapter") : t("viewer:viewer.search.scopeAll");
    case "chapter": {
      const named = t("viewer:viewer.search.scopeChapterNamed", {
        title: resolved.item.title,
        from: (resolved.item.page ?? 0) + 1,
        to: (resolved.item.pageEnd ?? 0) + 1,
      });
      return resolved.current ? t("viewer:viewer.search.scopeCurrentChapterNamed", { title: named }) : named;
    }
    case "pages":
      return t("viewer:viewer.search.scopePagesRange", { from: resolved.from, to: resolved.to });
    case "invalidPages":
      return t("viewer:viewer.search.scopePages");
  }
}

export type SearchVariant = "bar" | "dock";

export function searchTotal(doc: DocSearch | undefined): number {
  return doc?.flat.length ?? 0;
}

/**
 * "3 de 12" (bar), "3 de 12 resultados" / "3 de 6 zonas · 7 páginas" (panel), "A pesquisar… página 7 de
 * 500 · 12 resultados", "Sem resultados" (bar; the panel shows its own empty state), or "" for an empty
 * query or a failed search. Proximity results are "zonas", phrase results "resultados".
 */
export function countText(t: TFunction, doc: DocSearch | undefined, variant: SearchVariant): string {
  if (!doc || !doc.query) return "";
  const total = doc.flat.length;
  const zones = doc.resultMode === "proximity";
  if (!doc.done) {
    const found = total > 0 ? t(zones ? "viewer:viewer.search.progressZones" : "viewer:viewer.search.progressFound", { count: total }) : "";
    if (variant === "bar") return found || t("viewer:viewer.search.searching");
    if (doc.pageCount === 0) return found ? `${t("viewer:viewer.search.searching")} · ${found}` : t("viewer:viewer.search.searching");
    const page = Math.min(Math.max(doc.pagesSearched, 1), doc.pageCount);
    const progress = t("viewer:viewer.search.progress", { page, total: doc.pageCount });
    return found ? `${progress} · ${found}` : progress;
  }
  if (doc.error) return "";
  if (total === 0) return variant === "bar" ? t("viewer:viewer.search.noResults") : "";
  if (variant === "bar") return t("viewer:viewer.search.hitCount", { current: doc.activeIndex + 1, total });
  if (!zones) return t("viewer:viewer.search.resultCount", { current: doc.activeIndex + 1, total });
  const zoneCount = t("viewer:viewer.search.zoneCount", { current: doc.activeIndex + 1, total });
  return doc.pageCount > 0 ? `${zoneCount} · ${t("viewer:viewer.search.scopePagesCount", { count: doc.pageCount })}` : zoneCount;
}

/** True when the search finished with nothing to show because the document has no text layer at all. */
export function isTextless(doc: DocSearch | undefined): boolean {
  return Boolean(doc && doc.done && doc.textless && doc.flat.length === 0);
}
