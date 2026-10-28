// Mock implementation of the "history" domain (CONTRACTS §3/§5).
//
// All the actual undo/redo mechanics (snapshotting, revision bump, event
// emission) live in `mock/state.ts` — this module is just the thin command
// surface over it. Calling undo/redo with nothing on the relevant stack is
// treated as a no-op (returns the current revision, no invalidated pages)
// rather than an error, since a real UI's undo/redo buttons are normally
// disabled in that state anyway.
import type { HistoryState, MutationResult } from "../bindings";
import { type CommandResult, computeDirty, err, findDocById, ok, redoDoc, undoDoc } from "./state";

export async function historyUndo(docId: string): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const result = undoDoc(doc);
  return ok(result ?? { revision: doc.revision, invalidatedPages: [] });
}

export async function historyRedo(docId: string): Promise<CommandResult<MutationResult>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const result = redoDoc(doc);
  return ok(result ?? { revision: doc.revision, invalidatedPages: [] });
}

export async function historyState(docId: string): Promise<CommandResult<HistoryState>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  return ok({ canUndo: doc.undoStack.length > 0, canRedo: doc.redoStack.length > 0, dirty: computeDirty(doc) });
}
