// Shared hook: re-run `load` whenever the given document's revision changes
// (per CONTRACTS §4, `doc_state_changed` fires after every mutation, undo,
// redo, and save). Every tool's data hook (annotations list, form fields,
// page list) is "fetch the current snapshot, then resubscribe" — this
// factors that out so the three tools don't each reinvent the listener
// lifecycle and stay consistent about it (brief: "mock revision bumps drive
// tile invalidation so the UI proves its refresh path").
import { useEffect, useRef } from "react";
import { events } from "../../ipc";

/**
 * Calls `load(docId)` once immediately (and whenever `docId` changes), and
 * again every time `doc_state_changed` fires for that `docId`. `load` should
 * be stable (wrap it in `useCallback` at the call site) since it's the
 * effect's own dependency.
 */
export function useDocRevision(docId: string | null, load: (docId: string) => void): void {
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!docId) return;
    loadRef.current(docId);
    const unlistenPromise = events.docStateChanged.listen((event) => {
      if (event.payload.docId !== docId) return;
      loadRef.current(docId);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [docId]);
}
