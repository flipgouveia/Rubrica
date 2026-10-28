// Mock implementation of the "pages" domain (CONTRACTS §3/§5).
//
// Structural edits (reorder/delete/insert) remap the `page` field of
// annotations, form fields, and text-run objects (and the fake per-page
// body text) so associated data follows its page — see `mock/state.ts`'s
// header comment. `invalidatedPages` for these is simply "every page after
// the edit", since a structural change can shift how every page's content
// maps to its old tiles.
import type { BlankPageSpec, MutationResult, PageRange } from "../bindings";
import { allPageIndices, commitMutation, type CommandResult, err, findDocById, ok, shiftPagesFrom } from "./state";

export async function pagesReorder(docId: string, order: number[]): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const pageCount = doc.mutable.pages.length;
  const isPermutation = order.length === pageCount && new Set(order).size === pageCount && order.every((i) => i >= 0 && i < pageCount);
  if (!isPermutation) return err("INVALID_ARG", "order must be a permutation of all page indices");

  const result = commitMutation(doc, () => {
    const state = doc.mutable;
    const oldPages = state.pages;
    const oldPageText = state.pageText;
    state.pages = order.map((oldIdx) => oldPages[oldIdx]);
    state.pageText = order.map((oldIdx) => oldPageText[oldIdx]);
    const remap = (oldIdx: number) => order.indexOf(oldIdx);
    for (const annot of state.annotations) annot.page = remap(annot.page);
    for (const field of state.formFields) field.page = remap(field.page);
    for (const run of state.textRuns) run.page = remap(run.page);
    for (const region of state.redactedRects) region.page = remap(region.page);
    return allPageIndices(doc);
  });
  return ok(result);
}

export async function pagesRotate(docId: string, pages: number[], degrees: number): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  for (const p of pages) {
    if (p < 0 || p >= doc.mutable.pages.length) return err("INVALID_ARG", `page ${p} out of range`);
  }
  const result = commitMutation(doc, () => {
    for (const p of pages) {
      const page = doc.mutable.pages[p];
      page.rotation = ((page.rotation + degrees) % 360 + 360) % 360;
    }
    return [...pages];
  });
  return ok(result);
}

export async function pagesDelete(docId: string, pages: number[]): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const pageCount = doc.mutable.pages.length;
  const toDelete = new Set(pages);
  for (const p of pages) {
    if (p < 0 || p >= pageCount) return err("INVALID_ARG", `page ${p} out of range`);
  }
  if (toDelete.size >= pageCount) return err("INVALID_ARG", "cannot delete every page of a document");

  const result = commitMutation(doc, () => {
    const state = doc.mutable;
    const remainingOld = state.pages.map((_, i) => i).filter((i) => !toDelete.has(i));
    const remap = (oldIdx: number): number => remainingOld.indexOf(oldIdx);

    state.pages = remainingOld.map((i) => state.pages[i]);
    state.pageText = remainingOld.map((i) => state.pageText[i]);
    state.annotations = state.annotations.filter((a) => !toDelete.has(a.page)).map((a) => ({ ...a, page: remap(a.page) }));
    state.formFields = state.formFields.filter((f) => !toDelete.has(f.page)).map((f) => ({ ...f, page: remap(f.page) }));
    state.textRuns = state.textRuns.filter((t) => !toDelete.has(t.page)).map((t) => ({ ...t, page: remap(t.page) }));
    state.redactedRects = state.redactedRects.filter((r) => !toDelete.has(r.page)).map((r) => ({ ...r, page: remap(r.page) }));

    return remainingOld.map((_, i) => i);
  });
  return ok(result);
}

export async function pagesInsertBlank(docId: string, at: number, spec: BlankPageSpec): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const insertAt = Math.max(0, Math.min(at, doc.mutable.pages.length));
  const width = spec.width ?? 612;
  const height = spec.height ?? 792;

  const result = commitMutation(doc, () => {
    const state = doc.mutable;
    shiftPagesFrom(state, insertAt, 1);
    state.pages.splice(insertAt, 0, { width, height, rotation: 0 });
    state.pageText.splice(insertAt, 0, "");
    return allPageIndices(doc);
  });
  return ok(result);
}

export async function pagesInsertFromFile(
  docId: string,
  at: number,
  path: string,
  range: PageRange | null,
): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const insertAt = Math.max(0, Math.min(at, doc.mutable.pages.length));
  // No real second file exists in mock mode — fabricate `count` blank-ish
  // pages standing in for whatever the real path/range would have inserted.
  const count = range ? Math.max(1, range.end - range.start + 1) : 1;

  const result = commitMutation(doc, () => {
    const state = doc.mutable;
    shiftPagesFrom(state, insertAt, count);
    for (let i = 0; i < count; i++) {
      state.pages.splice(insertAt + i, 0, { width: 612, height: 792, rotation: 0 });
      state.pageText.splice(insertAt + i, 0, `[mock] inserted from ${path}`);
    }
    return allPageIndices(doc);
  });
  return ok(result);
}
