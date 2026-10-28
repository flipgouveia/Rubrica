// Pure page-grouping for pending marks. CONTRACTS' `redact_apply(docId, page, rects[])` takes
// ONE page per call (§3, explicit: "one page at a time"), so a multi-page set of pending marks
// becomes one call per page, looped sequentially (see `apply.ts`). `groupMarksByPage` is the pure
// part of that split: turning a flat list of marks into page-grouped rect batches, sorted by page
// for a predictable apply order (and a predictable undo-stack order — page N's redaction always
// lands before page N+1's, so undoing a multi-page redaction unwinds highest page first).
//
// `groupMarksForDisplay` is the same grouping, but keeping full `PendingMark` objects instead of
// flattening to bare `Rect`s — what the panel's review list (brief item 3: "grouped by page is a
// nice touch") actually renders.
import type { Rect } from "../../ipc/bindings";
import type { PendingMark } from "./model";

export interface MarkGroup {
  page: number;
  rects: Rect[];
  markIds: string[];
}

export function groupMarksByPage(marks: readonly PendingMark[]): MarkGroup[] {
  const byPage = new Map<number, MarkGroup>();
  for (const mark of marks) {
    let group = byPage.get(mark.page);
    if (!group) {
      group = { page: mark.page, rects: [], markIds: [] };
      byPage.set(mark.page, group);
    }
    group.rects.push(mark.rect);
    group.markIds.push(mark.id);
  }
  return Array.from(byPage.values()).sort((a, b) => a.page - b.page);
}

export interface MarkDisplayGroup {
  page: number;
  marks: PendingMark[];
}

export function groupMarksForDisplay(marks: readonly PendingMark[]): MarkDisplayGroup[] {
  const byPage = new Map<number, PendingMark[]>();
  for (const mark of marks) {
    const list = byPage.get(mark.page);
    if (list) list.push(mark);
    else byPage.set(mark.page, [mark]);
  }
  return Array.from(byPage.entries())
    .sort(([a], [b]) => a - b)
    .map(([page, pageMarks]) => ({ page, marks: pageMarks }));
}
