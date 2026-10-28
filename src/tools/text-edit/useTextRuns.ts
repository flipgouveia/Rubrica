// Fetches a page's text runs (CONTRACTS §3 `text_objects`) and keeps them
// fresh via `useDocRevision` — the same "fetch, then resubscribe to
// doc_state_changed" shape `useAnnotations`/`useFormFields` already use.
// Always re-fetches the whole array rather than patching it in place: the
// brief is explicit that indices/order can shift after any mutation on the
// page (an edit, add, or delete).
import { useCallback, useState } from "react";
import { commands } from "../../ipc";
import type { TextRun } from "../../ipc/bindings";
import { useDocRevision } from "../shared/useDocRevision";
import { useTextEditStore } from "./model";

export interface UseTextRunsResult {
  textRuns: TextRun[];
  /** Re-fetches immediately, without waiting for a `doc_state_changed` round-trip. */
  refresh: () => Promise<TextRun[]>;
}

export function useTextRuns(docId: string | null, page: number): UseTextRunsResult {
  const [textRuns, setTextRuns] = useState<TextRun[]>([]);

  const load = useCallback(
    async (id: string): Promise<TextRun[]> => {
      const result = await commands.textObjects(id, page);
      const list = result.status === "ok" ? result.data : [];
      setTextRuns(list);
      return list;
    },
    [page],
  );

  useDocRevision(docId, load);

  const refresh = useCallback(async (): Promise<TextRun[]> => {
    if (!docId) return [];
    return load(docId);
  }, [docId, load]);

  return { textRuns, refresh };
}

/**
 * The currently selected text run's live data for `docId`, or `null` when
 * nothing is selected (or the selection belongs to a different document —
 * only one document can be "active" in the chrome at a time in practice,
 * but the store itself doesn't assume that). Used by the panel to show a
 * preview/substitution badge without inventing a second "selected object"
 * data source alongside `text_objects`.
 */
export function useSelectedTextRun(docId: string): TextRun | null {
  const selection = useTextEditStore((s) => s.selection);
  const relevant = selection !== null && selection.docId === docId;
  const { textRuns } = useTextRuns(docId, relevant && selection ? selection.page : -1);
  if (!relevant || !selection) return null;
  return textRuns.find((r) => r.objectId === selection.objectId) ?? null;
}
