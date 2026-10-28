// Mock implementation of the "document" domain (CONTRACTS §3/§5).
//
// See `mock/state.ts`'s header comment for the doc_open path convention,
// docId scheme, and close/save/revision semantics this relies on.
import type { DocInfo, OutlineItem } from "../bindings";
import { recordRecent } from "./app";
import { type CommandResult, closeDoc, err, findDocById, getDocInfo, listOpenDocs, ok, openDocByPath, saveDoc } from "./state";

export async function docOpen(path: string): Promise<CommandResult<DocInfo>> {
  const doc = openDocByPath(path);
  if (!doc) {
    return err(
      "NOT_FOUND",
      `mock engine: no fake document matches path "${path}" (pass a path containing "book", "500", "form" or "text")`,
    );
  }
  recordRecent(doc.path);
  return ok(getDocInfo(doc));
}

export async function docClose(docId: string): Promise<CommandResult<null>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  closeDoc(doc);
  return ok(null);
}

export async function docSave(docId: string): Promise<CommandResult<null>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  await saveDoc(doc);
  return ok(null);
}

export async function docSaveAs(docId: string, path: string): Promise<CommandResult<null>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  doc.path = path;
  await saveDoc(doc);
  recordRecent(path);
  return ok(null);
}

export async function docListOpen(): Promise<CommandResult<DocInfo[]>> {
  return ok(listOpenDocs().map(getDocInfo));
}

/** CONTRACTS v1.2.0: only the "book" fake document has an outline; the others return `[]`. */
export async function docOutline(docId: string): Promise<CommandResult<OutlineItem[]>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  return ok(structuredClone(doc.outline));
}
