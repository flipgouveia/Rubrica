// Mock implementation of the "redact" domain (CONTRACTS §3/§5).
//
// ARCHITECTURE.md is explicit that redaction removes the underlying
// objects (unlike whiteout, which is just an opaque `shape` annotation) —
// the mock honors that: any text-run object or rect-based annotation fully
// contained in a redacted rect on the same page is dropped, not just
// visually covered.
import type { MutationResult, Rect } from "../bindings";
import { commitMutation, type CommandResult, err, findDocById, ok } from "./state";

function contains(outer: Rect, inner: Rect): boolean {
  const ox = outer.x ?? 0;
  const oy = outer.y ?? 0;
  const ow = outer.width ?? 0;
  const oh = outer.height ?? 0;
  const ix = inner.x ?? 0;
  const iy = inner.y ?? 0;
  const iw = inner.width ?? 0;
  const ih = inner.height ?? 0;
  return ix >= ox && iy >= oy && ix + iw <= ox + ow && iy + ih <= oy + oh;
}

export async function redactApply(docId: string, page: number, rects: Rect[]): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  if (page < 0 || page >= doc.mutable.pages.length) return err("INVALID_ARG", `page ${page} out of range`);

  const result = commitMutation(doc, () => {
    const state = doc.mutable;
    state.redactedRects.push({ page, rects });
    const isRedacted = (r: Rect) => rects.some((rect) => contains(rect, r));
    state.textRuns = state.textRuns.filter((run) => !(run.page === page && isRedacted(run.rect)));
    state.annotations = state.annotations.filter((annot) => {
      if (annot.page !== page) return true;
      if (!("rect" in annot)) return true;
      return !isRedacted(annot.rect);
    });
    return [page];
  });
  return ok(result);
}
