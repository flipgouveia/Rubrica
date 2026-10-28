// Orchestrates the actual `redact_apply` calls once the user has confirmed (brief item 4).
// CONTRACTS' `redact_apply(docId, page, rects[])` takes ONE page per call, so a pending-mark set
// spanning N pages becomes N sequential calls — sequential (not `Promise.all`) both because each
// call is meant to be its own undo-stack entry in a stable order, and because every domain's
// mutation shares one document state (real and mock alike): concurrent calls would race on the
// same underlying document/session.
import { commands } from "../../ipc";
import type { RubricaError } from "../../ipc/bindings";
import type { DocId } from "../../viewer/types";
import { groupMarksByPage } from "./grouping";
import type { PendingMark } from "./model";

export interface ApplyResult {
  /** Ids of every pending mark that was successfully redacted, in application order — the caller should remove exactly these from the pending-marks store, even on a partial failure. */
  appliedMarkIds: string[];
  /** Set only if a `redact_apply` call failed partway through a multi-page apply; every mark on an earlier page's group already applied is still reflected in `appliedMarkIds`. */
  error?: RubricaError;
}

export async function applyPendingMarks(docId: DocId, marks: readonly PendingMark[]): Promise<ApplyResult> {
  const groups = groupMarksByPage(marks);
  const appliedMarkIds: string[] = [];
  for (const group of groups) {
    const result = await commands.redactApply(docId, group.page, group.rects);
    if (result.status === "error") {
      return { appliedMarkIds, error: result.error };
    }
    appliedMarkIds.push(...group.markIds);
  }
  return { appliedMarkIds };
}
