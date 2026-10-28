// Live `history_state` for one doc (CONTRACTS §3), refreshed on every `doc_state_changed` —
// undo/redo/dirty all flow through that one event, so a single listener here keeps the
// toolbar's undo/redo buttons and dirty indicator honest without each polling separately.
import { useEffect, useState } from "react";
import { commands, events } from "../ipc";
import type { HistoryState } from "../ipc/bindings";
import type { DocId } from "./types";

const EMPTY: HistoryState = { canUndo: false, canRedo: false, dirty: false };

export function useHistoryState(docId: DocId | null): HistoryState {
  const [state, setState] = useState<HistoryState>(EMPTY);

  useEffect(() => {
    if (!docId) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void commands.historyState(docId).then((result) => {
        if (!cancelled && result.status === "ok") setState(result.data);
      });
    };
    refresh();
    const unlistenPromise = events.docStateChanged.listen((event) => {
      if (event.payload.docId === docId) refresh();
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [docId]);

  return state;
}
