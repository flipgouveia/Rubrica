// Mock implementation of the "textedit" domain (CONTRACTS §3/§5).
//
// `TextRun` (the real return type) has no `page` field — `mock/state.ts`
// stores `MockTextRunState`, which extends `TextRun` with one. Returning
// those arrays directly type-checks fine against `TextRun[]`: an array of a
// type with *extra* fields is structurally assignable to an array of the
// narrower interface (only object *literals* trigger excess-property
// checks, not already-typed values), so no field-stripping step is needed.
import type { ImageObjectSpec, MutationResult, SetTextResult, TextObjectSpec, TextRun } from "../bindings";
import { commitMutation, type CommandResult, err, findDocById, generateId, ok } from "./state";

export async function textObjects(docId: string, page: number): Promise<CommandResult<TextRun[]>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  return ok(doc.mutable.textRuns.filter((run) => run.page === page));
}

/**
 * Fabricates `fontSubstituted` from the run's `embeddedFontUsable` flag —
 * if the original embedded font isn't usable, editing forces a substitute,
 * same as the real PDFium-backed engine would report.
 */
export async function textobjSetText(docId: string, objectId: string, text: string): Promise<CommandResult<SetTextResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const run = doc.mutable.textRuns.find((r) => r.objectId === objectId);
  if (!run) return err("NOT_FOUND", `no text object with id "${objectId}"`);
  const page = run.page;
  const fontSubstituted = !run.embeddedFontUsable;

  const result = commitMutation(doc, () => {
    const target = doc.mutable.textRuns.find((r) => r.objectId === objectId);
    if (target) target.text = text;
    return [page];
  });
  return ok({ ...result, fontSubstituted });
}

export async function textobjAdd(docId: string, page: number, spec: TextObjectSpec): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  if (page < 0 || page >= doc.mutable.pages.length) return err("INVALID_ARG", `page ${page} out of range`);

  const result = commitMutation(doc, () => {
    // `spec.color` styles the object but `TextRun` (the read shape) has no
    // color field to persist it into — accepted and intentionally dropped,
    // matching the asymmetry between the write spec and the read shape.
    doc.mutable.textRuns.push({
      page,
      objectId: generateId("textobj"),
      rect: spec.rect,
      text: spec.text,
      fontName: "Helvetica",
      fontSize: spec.fontSize ?? 12,
      embeddedFontUsable: true,
    });
    return [page];
  });
  return ok(result);
}

/**
 * CONTRACTS §3 defines no getter for images, only `imageobj_add` — so
 * there's nothing for the mock to track beyond the mutation itself. This is
 * a legitimate no-op body, not a shortcut: an add-only command has no state
 * to keep.
 */
export async function imageobjAdd(docId: string, page: number, spec: ImageObjectSpec): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  if (page < 0 || page >= doc.mutable.pages.length) return err("INVALID_ARG", `page ${page} out of range`);
  void spec; // rect/path accepted, nothing to persist (see doc comment above).

  const result = commitMutation(doc, () => [page]);
  return ok(result);
}

export async function objectDelete(docId: string, objectId: string): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const run = doc.mutable.textRuns.find((r) => r.objectId === objectId);
  if (!run) return err("NOT_FOUND", `no object with id "${objectId}"`);
  const page = run.page;

  const result = commitMutation(doc, () => {
    doc.mutable.textRuns = doc.mutable.textRuns.filter((r) => r.objectId !== objectId);
    return [page];
  });
  return ok(result);
}
