// Fetches a page's annotations and keeps them fresh via `useDocRevision`
// (CONTRACTS §4: `doc_state_changed` fires after every mutation/undo/redo).
import { useCallback, useState } from "react";
import { commands } from "../../ipc";
import type { Annot } from "../../ipc/bindings";
import { useDocRevision } from "../shared/useDocRevision";
import { useAnnotateStore } from "./store";

export interface UseAnnotationsResult {
  annotations: Annot[];
  /** Re-fetches immediately, without waiting for a `doc_state_changed` round-trip — used right after a mutation this component itself just issued, when the caller needs the fresh list synchronously (e.g. to find a just-created annotation's id; see `AnnotationLayer.tsx`'s note-placement flow). */
  refresh: () => Promise<Annot[]>;
}

export function useAnnotations(docId: string | null, page: number): UseAnnotationsResult {
  const [annotations, setAnnotations] = useState<Annot[]>([]);

  const load = useCallback(
    async (id: string): Promise<Annot[]> => {
      const result = await commands.annotList(id, page);
      const list = result.status === "ok" ? result.data : [];
      setAnnotations(list);
      return list;
    },
    [page],
  );

  useDocRevision(docId, load);

  const refresh = useCallback(async (): Promise<Annot[]> => {
    if (!docId) return [];
    return load(docId);
  }, [docId, load]);

  return { annotations, refresh };
}

/**
 * The currently selected annotation's live data for `docId`, or `null` when nothing is selected
 * (or the selection belongs to a different document/page). Independently re-fetches the owning
 * page's own list rather than trusting a per-page `AnnotationLayer` instance to push its value up
 * — with `overlayAlwaysOn` mounting one instance per visible page (see `AnnotateOverlay.tsx`),
 * a push-based value could race across instances when the selection jumps from one visible page
 * straight to another. Same pattern as `text-edit/useTextRuns.ts`'s `useSelectedTextRun`.
 */
export function useSelectedAnnot(docId: string): Annot | null {
  const selection = useAnnotateStore((s) => s.selection);
  const relevant = selection !== null && selection.docId === docId;
  // A real bug a review caught: this used to pass the real `docId` through even when nothing
  // relevant is selected, paired with a sentinel `page: -1` — `annotList`'s Rust signature takes
  // `page: u32`, so that IPC call was guaranteed to fail on every single call, repeated on every
  // doc revision for as long as the panel stayed open with nothing selected. Passing `null` here
  // instead means `useDocRevision`'s own `if (!docId) return` skips the fetch entirely — matching
  // what "nothing to select is relevant" actually means, not "call anyway with a page that can't
  // exist".
  const { annotations } = useAnnotations(relevant ? docId : null, relevant && selection ? selection.page : -1);
  if (!relevant || !selection) return null;
  return annotations.find((a) => a.annotId === selection.id) ?? null;
}
