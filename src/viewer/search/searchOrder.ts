// The VISIBLE order of the result list (SEARCH-ORCHESTRATION §2.1 "Lista de resultados"): hits are
// grouped by `outlineItemId` (the deepest outline entry holding the start page) and ordered either
//   - "position": groups and hits in document order, or
//   - "compact" (proximity, once the engine ranked the zones): hits by `score` inside each group,
//     groups by their best (lowest-score) hit; ties fall back to document order.
// "X de N", ↑/↓, Enter and F3 all walk `flat`, so they always follow what the list shows.
// Pure functions: the store calls them whenever hits, ranking or the sort preference change.
import type { SearchHit } from "../../ipc/bindings";

/** Identity of one hit: start page (0-based) + position within that page's hits. */
export interface HitRef {
  page: number;
  hitIndex: number;
}

export interface HitGroup {
  /** Deepest outline entry id; `null` = hits before the first chapter (or a PDF without outline). */
  id: string | null;
  refs: HitRef[];
}

export interface HitOrder {
  /** Every hit in visible order (group by group). */
  flat: HitRef[];
  groups: HitGroup[];
  /** False when no hit has an outline entry: the list is flat, with no group headers. */
  grouped: boolean;
}

/** Key under which a group's collapsed state is stored. */
export const NO_GROUP_KEY = "\u0000none";

export function groupKey(id: string | null): string {
  return id ?? NO_GROUP_KEY;
}

function documentOrder(hitsByPage: Record<number, SearchHit[]>): HitRef[] {
  const refs: HitRef[] = [];
  const pages = Object.keys(hitsByPage)
    .map(Number)
    .sort((a, b) => a - b);
  for (const page of pages) {
    for (let hitIndex = 0; hitIndex < hitsByPage[page].length; hitIndex++) refs.push({ page, hitIndex });
  }
  return refs;
}

export function buildHitOrder(hitsByPage: Record<number, SearchHit[]>, compact: boolean): HitOrder {
  const docOrder = documentOrder(hitsByPage);
  const hitOf = (ref: HitRef) => hitsByPage[ref.page][ref.hitIndex];
  const scoreOf = (ref: HitRef) => hitOf(ref).score ?? Number.POSITIVE_INFINITY;
  const grouped = docOrder.some((ref) => hitOf(ref).outlineItemId !== null);

  // Groups in order of their first hit (document order); a null group only exists when `grouped`.
  const byKey = new Map<string, HitGroup>();
  const groups: HitGroup[] = [];
  for (const ref of docOrder) {
    const id = grouped ? hitOf(ref).outlineItemId : null;
    const key = groupKey(id);
    let group = byKey.get(key);
    if (!group) {
      group = { id, refs: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.refs.push(ref);
  }

  if (compact) {
    // (not `a - b`: two unscored hits would be Infinity - Infinity = NaN)
    const compare = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
    const byScore = (a: HitRef, b: HitRef) => compare(scoreOf(a), scoreOf(b)) || a.page - b.page || a.hitIndex - b.hitIndex;
    for (const group of groups) group.refs.sort(byScore);
    // Array.sort is stable: equal best scores keep their document order.
    groups.sort((a, b) => compare(scoreOf(a.refs[0]), scoreOf(b.refs[0])));
  }

  return { flat: groups.flatMap((group) => group.refs), groups, grouped };
}
