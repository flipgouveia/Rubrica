// Pure helpers of the outline panel: which rows are visible, the path to an entry, per-entry
// aggregated search counts and which entries start expanded. No React, no stores.
import type { OutlineItem } from "../../ipc/bindings";
import { deepestItemForPage } from "./outlineStore";

export interface OutlineRow {
  item: OutlineItem;
  parentId: string | null;
  /** 1-based, as `aria-level` wants it. */
  level: number;
  /** 1-based position among its siblings and number of siblings (`aria-posinset` / `aria-setsize`). */
  posInSet: number;
  setSize: number;
}

/** The rows to show, in document order: children only below expanded entries. */
export function visibleRows(items: readonly OutlineItem[], expanded: ReadonlySet<string>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (siblings: readonly OutlineItem[], parentId: string | null, level: number) => {
    siblings.forEach((item, index) => {
      rows.push({ item, parentId, level, posInSet: index + 1, setSize: siblings.length });
      if (item.children.length > 0 && expanded.has(item.id)) walk(item.children, item.id, level + 1);
    });
  };
  walk(items, null, 1);
  return rows;
}

/** Ids from the root entry down to (excluding) `id`; `[]` for a root entry or an unknown id. */
export function ancestorIds(items: readonly OutlineItem[], id: string): string[] {
  const path: string[] = [];
  const search = (siblings: readonly OutlineItem[]): boolean => {
    for (const item of siblings) {
      if (item.id === id) return true;
      path.push(item.id);
      if (search(item.children)) return true;
      path.pop();
    }
    return false;
  };
  return search(items) ? path : [];
}

/**
 * Search hits per entry INCLUDING its descendants. `ownCounts` is what the selectors give: hits per
 * deepest entry, so a chapter's own number is the sum over its whole subtree.
 */
export function aggregateHitCounts(items: readonly OutlineItem[], ownCounts: ReadonlyMap<string, number>): Map<string, number> {
  const totals = new Map<string, number>();
  const sum = (item: OutlineItem): number => {
    const total = item.children.reduce((acc, child) => acc + sum(child), ownCounts.get(item.id) ?? 0);
    totals.set(item.id, total);
    return total;
  };
  items.forEach(sum);
  return totals;
}

/** Entries open at first: the path to the entry that contains `page`, so the current one is visible. */
export function defaultExpanded(items: OutlineItem[], page: number): Set<string> {
  const current = deepestItemForPage(items, page);
  return new Set(current ? ancestorIds(items, current.id) : []);
}

/**
 * The row that carries the "you are here" marker: the current entry itself or — when it is hidden
 * inside a collapsed entry — the outermost collapsed entry that contains it.
 */
export function highlightedRowId(items: readonly OutlineItem[], currentId: string | null, expanded: ReadonlySet<string>): string | null {
  if (!currentId) return null;
  const collapsed = ancestorIds(items, currentId).find((id) => !expanded.has(id));
  return collapsed ?? currentId;
}
