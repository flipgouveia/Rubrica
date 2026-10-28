// What the panel says when there is no list to show (mockup state F and the error cases):
//   - "Este documento não tem texto pesquisável" (`textless`, a scanned PDF),
//   - "Sem resultados" — in proximity "Nenhuma zona com os N termos em W caracteres." with the actions
//     "Aumentar janela para 2W" and "Pesquisar no documento inteiro" when they would change something,
//   - the invalid-query message (engine INVALID_ARG, or a proximity query with only exclusions),
//   - an invalid page range, and a failed search.
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { DocId } from "../types";
import { positiveTerms } from "./queryTerms";
import type { SearchVariant } from "./searchLabels";
import { isTextless } from "./searchLabels";
import { PROXIMITY_WINDOW_MAX, useSearchPrefs } from "./searchPrefs";
import { useSearchQuery } from "./searchQuery";
import { useSearchStore } from "./searchStore";

function Card({ title, role = "status", variant, children }: { title?: string; role?: "status" | "alert"; variant: SearchVariant; children?: ReactNode }) {
  return (
    <div
      role={role}
      className={
        variant === "dock"
          ? "border-t border-border px-4 py-5 text-center text-[13px] text-muted-text"
          : "mt-1 rounded-md border border-border bg-surface-raised px-4 py-3 text-center text-[13px] shadow-menu"
      }
    >
      {title && <strong className="mb-1 block text-sm text-text">{title}</strong>}
      {children}
    </div>
  );
}

function ActionLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm text-[13px] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {children}
    </button>
  );
}

export function SearchNotice({ docId, variant }: { docId: DocId; variant: SearchVariant }) {
  const { t } = useTranslation("viewer");
  const doc = useSearchStore((s) => s.byDoc[docId]);
  const build = useSearchQuery(docId);

  if (!doc || !doc.query.trim()) return null;
  if (!build.ok && build.problem === "terms") return <Card variant={variant} role="alert" title={t("viewer.search.invalidQuery")} />;
  if (!build.ok && build.problem === "scope") return <Card variant={variant} role="alert" title={t("viewer.search.scopeInvalidRange")} />;
  if (doc.done && doc.error) {
    return doc.error.kind === "invalid" ? (
      <Card variant={variant} role="alert" title={t("viewer.search.invalidQuery")} />
    ) : (
      <Card variant={variant} role="alert">
        {t("viewer.search.searchFailed", { message: doc.error.message })}
      </Card>
    );
  }
  if (isTextless(doc)) {
    return (
      <Card variant={variant} title={t("viewer.search.noTextTitle")}>
        {t("viewer.search.noTextBody")}
      </Card>
    );
  }
  // "Sem resultados" lives in the compact bar's counter; the panel gets the fuller message below.
  if (variant === "bar" || !doc.done || doc.flat.length > 0 || !doc.searchQuery) return null;

  const query = doc.searchQuery;
  const proximity = query.mode === "proximity";
  const window = query.proximity?.window ?? 0;
  const widened = Math.min(window * 2, PROXIMITY_WINDOW_MAX);
  const canWiden = proximity && window < PROXIMITY_WINDOW_MAX;
  const canWiden2 = canWiden && widened > window;
  const canSearchAll = query.scope.kind !== "all";
  return (
    <Card variant={variant} title={t("viewer.search.noResults")}>
      {proximity && <p className="m-0">{t("viewer.search.noZones", { count: positiveTerms(query.text).length, window })}</p>}
      {(canWiden2 || canSearchAll) && (
        <p className="m-0 mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          {canWiden2 && (
            <ActionLink onClick={() => useSearchPrefs.getState().setProximityWindow(widened)}>
              {t("viewer.search.widenWindow", { window: widened })}
            </ActionLink>
          )}
          {canSearchAll && (
            <ActionLink onClick={() => useSearchStore.getState().setScope(docId, { kind: "all" })}>{t("viewer.search.searchWholeDocument")}</ActionLink>
          )}
        </p>
      )}
    </Card>
  );
}
