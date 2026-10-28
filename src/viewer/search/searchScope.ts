// Search scope (SEARCH-ORCHESTRATION §2.1 "Âmbito"). The UI keeps a `ScopeChoice` per document and
// resolves it against the current outline/page into what is sent over IPC:
//   - "Documento inteiro"            -> { kind: 'all' }
//   - "Capítulo atual"               -> the TOP-LEVEL (depth 0) entry containing the visible page
//   - "Escolher capítulo…" (tree)    -> any entry, by id
//   - "Páginas X–Y"                  -> 1-based in the UI, 0-based inclusive over IPC
// Both chapter kinds go out as `{ kind: 'outline', itemId }`. A chapter that cannot be resolved (no
// outline, the entry vanished after an edit, no top-level entry holds the page) falls back to the
// whole document, flagged so the UI can say so.
import type { OutlineItem, SearchQuery } from "../../ipc/bindings";
import { findOutlineItem, topLevelItemForPage } from "../outline/outlineStore";

export type ScopeChoice =
  | { kind: "all" }
  | { kind: "currentChapter" }
  | { kind: "chapter"; itemId: string }
  /** 1-based, inclusive; `null` = the field is empty (invalid until filled). */
  | { kind: "pages"; from: number | null; to: number | null };

export const SCOPE_ALL: ScopeChoice = { kind: "all" };

export type ResolvedScope =
  | { kind: "all"; pages: number; /** a chapter was requested but is not available */ fellBack: boolean }
  | { kind: "chapter"; item: OutlineItem; current: boolean; pages: number }
  | { kind: "pages"; from: number; to: number; pages: number }
  | { kind: "invalidPages" };

/** An outline entry whose range is known (the only kind a scope can use). */
export function isUsableItem(item: OutlineItem): item is OutlineItem & { page: number; pageEnd: number } {
  return item.page !== null && item.pageEnd !== null;
}

export function itemPageCount(item: OutlineItem): number {
  return isUsableItem(item) ? item.pageEnd - item.page + 1 : 0;
}

/** `from`/`to` are 1-based and inclusive: both set, integer, 1 <= from <= to <= pageCount. */
export function isValidPageRange(from: number | null, to: number | null, pageCount: number): boolean {
  return (
    from !== null &&
    to !== null &&
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 1 &&
    to <= pageCount &&
    from <= to
  );
}

export function resolveScope(choice: ScopeChoice, items: OutlineItem[], currentPage: number, pageCount: number): ResolvedScope {
  switch (choice.kind) {
    case "all":
      return { kind: "all", pages: pageCount, fellBack: false };
    case "currentChapter": {
      const item = topLevelItemForPage(items, currentPage);
      return item && isUsableItem(item)
        ? { kind: "chapter", item, current: true, pages: itemPageCount(item) }
        : { kind: "all", pages: pageCount, fellBack: true };
    }
    case "chapter": {
      const item = findOutlineItem(items, choice.itemId);
      return item && isUsableItem(item)
        ? { kind: "chapter", item, current: false, pages: itemPageCount(item) }
        : { kind: "all", pages: pageCount, fellBack: true };
    }
    case "pages":
      return isValidPageRange(choice.from, choice.to, pageCount)
        ? { kind: "pages", from: choice.from as number, to: choice.to as number, pages: (choice.to as number) - (choice.from as number) + 1 }
        : { kind: "invalidPages" };
  }
}

/** The IPC scope for a resolved choice; `null` when the page range is invalid (nothing to send). */
export function toQueryScope(scope: ResolvedScope): SearchQuery["scope"] | null {
  switch (scope.kind) {
    case "all":
      return { kind: "all" };
    case "chapter":
      return { kind: "outline", itemId: scope.item.id };
    case "pages":
      return { kind: "pages", from: scope.from - 1, to: scope.to - 1 };
    case "invalidPages":
      return null;
  }
}

/** The ancestors' ids of an entry (to open them in the chapter tree). */
export function ancestorIds(items: OutlineItem[], id: string): string[] {
  const path: string[] = [];
  const walk = (list: OutlineItem[]): boolean => {
    for (const item of list) {
      if (item.id === id) return true;
      path.push(item.id);
      if (walk(item.children)) return true;
      path.pop();
    }
    return false;
  };
  return walk(items) ? [...path] : [];
}
