// Single app-wide `doc_state_changed` listener that keeps every open tab's `DocInfo.revision`/
// `dirty` current, regardless of which tab is active — mount once (AppShell), not per-tab.
import { useEffect } from "react";
import { events } from "../ipc";
import { useViewerStore } from "./store";

export function useDocStateSync(): void {
  useEffect(() => {
    const unlistenPromise = events.docStateChanged.listen((event) => {
      const { docId, revision, dirty } = event.payload;
      useViewerStore.getState().applyDocStateChanged(docId, { revision, dirty });
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
}
