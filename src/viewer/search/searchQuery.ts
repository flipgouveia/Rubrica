// Builds the `SearchQuery` (CONTRACTS v1.2.0 §3) from the UI state: the document's query text, case /
// whole-word toggles and scope, plus the app-wide preferences (mode, window, accents, headers and
// footers). One pure function (`buildSearchQuery`) serves both the React effect that decides WHEN to
// (re)search and the controller that actually starts the search, so they can never disagree about
// the search key. A change of ANY input changes the key and so re-runs the search.
import { useMemo } from "react";
import type { SearchQuery } from "../../ipc/bindings";
import { useOutline, useOutlineStore, type OutlineState } from "../outline/outlineStore";
import { getTabByDocId, useTabByDocId } from "../store";
import type { DocId } from "../types";
import { positiveTerms } from "./queryTerms";
import { useSearchPrefs, type QueryMode } from "./searchPrefs";
import { resolveScope, toQueryScope, type ResolvedScope, type ScopeChoice } from "./searchScope";
import { getDocSearch, useSearchStore, type DocSearch } from "./searchStore";

export interface QueryInputs {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  scope: ScopeChoice;
  mode: QueryMode;
  window: number;
  ignoreDiacritics: boolean;
  excludeHeadersFooters: boolean;
  outline: OutlineState;
  /** 0-based page in view (what "Capítulo atual" resolves against). */
  currentPage: number;
  pageCount: number;
}

/** Why there is nothing to search: `empty` = no text yet (not an error), `terms` = a proximity query with only exclusions, `scope` = invalid page range, `outline` = the chapter list is still loading. */
export type QueryProblem = "empty" | "terms" | "scope" | "outline";

export type QueryBuild =
  | { ok: true; query: SearchQuery; scope: ResolvedScope }
  | { ok: false; problem: QueryProblem; scope: ResolvedScope | null };

const NEEDS_OUTLINE = new Set<ScopeChoice["kind"]>(["currentChapter", "chapter"]);

export function buildSearchQuery(inputs: QueryInputs): QueryBuild {
  const items = inputs.outline.status === "ready" ? inputs.outline.items : [];
  const scope =
    NEEDS_OUTLINE.has(inputs.scope.kind) && inputs.outline.status === "loading"
      ? null
      : resolveScope(inputs.scope, items, inputs.currentPage, inputs.pageCount);

  if (!inputs.text.trim()) return { ok: false, problem: "empty", scope };
  if (scope === null) return { ok: false, problem: "outline", scope };
  const queryScope = toQueryScope(scope);
  if (queryScope === null) return { ok: false, problem: "scope", scope };
  if (inputs.mode === "proximity" && positiveTerms(inputs.text).length === 0) return { ok: false, problem: "terms", scope };

  return {
    ok: true,
    scope,
    query: {
      text: inputs.text,
      mode: inputs.mode,
      proximity: inputs.mode === "proximity" ? { window: inputs.window } : null,
      scope: queryScope,
      caseSensitive: inputs.caseSensitive,
      wholeWord: inputs.wholeWord,
      ignoreDiacritics: inputs.ignoreDiacritics,
      excludeHeadersFooters: inputs.excludeHeadersFooters,
    },
  };
}

/** Fingerprint of everything that decides what a search returns for a document. */
export function searchKeyFor(query: SearchQuery, revision: number): string {
  return JSON.stringify([query, revision]);
}

function inputsOf(doc: DocSearch, outline: OutlineState, currentPage: number, pageCount: number): QueryInputs {
  const prefs = useSearchPrefs.getState();
  return {
    text: doc.query,
    caseSensitive: doc.caseSensitive,
    wholeWord: doc.wholeWord,
    scope: doc.scope,
    mode: prefs.mode,
    window: prefs.proximityWindow,
    ignoreDiacritics: prefs.ignoreDiacritics,
    excludeHeadersFooters: prefs.excludeHeadersFooters,
    outline,
    currentPage,
    pageCount,
  };
}

/** The query a document would run right now, read straight from the stores (controller side). */
export function currentQueryBuild(docId: DocId): QueryBuild | null {
  const doc = getDocSearch(docId);
  const tab = getTabByDocId(docId);
  if (!doc || !tab) return null;
  // Same key as `useOutline` (orchestrator-owned): `${docId}@${revision}`.
  const outline = useOutlineStore.getState().byKey[`${docId}@${tab.info.revision}`] ?? ({ status: "loading" } as OutlineState);
  return buildSearchQuery(inputsOf(doc, outline, tab.currentPage, tab.info.pageCount));
}

/** The reactive twin of `currentQueryBuild`: recomputed when any input changes. */
export function useSearchQuery(docId: DocId | null): QueryBuild {
  const doc = useSearchStore((s) => (docId ? s.byDoc[docId] : undefined));
  const tab = useTabByDocId(docId);
  const outline = useOutline(docId);
  const mode = useSearchPrefs((s) => s.mode);
  const window = useSearchPrefs((s) => s.proximityWindow);
  const ignoreDiacritics = useSearchPrefs((s) => s.ignoreDiacritics);
  const excludeHeadersFooters = useSearchPrefs((s) => s.excludeHeadersFooters);
  const text = doc?.query ?? "";
  const caseSensitive = doc?.caseSensitive ?? false;
  const wholeWord = doc?.wholeWord ?? false;
  const scope = doc?.scope;
  const currentPage = tab?.currentPage ?? 0;
  const pageCount = tab?.info.pageCount ?? 0;

  return useMemo(
    () =>
      buildSearchQuery({
        text,
        caseSensitive,
        wholeWord,
        scope: scope ?? { kind: "all" },
        mode,
        window,
        ignoreDiacritics,
        excludeHeadersFooters,
        outline,
        currentPage,
        pageCount,
      }),
    [text, caseSensitive, wholeWord, scope, mode, window, ignoreDiacritics, excludeHeadersFooters, outline, currentPage, pageCount],
  );
}

