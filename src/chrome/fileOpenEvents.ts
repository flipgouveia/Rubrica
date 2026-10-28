// R7 (Windows citizenship, deliverable 2): the one `src/**` file the R7
// brief pre-approves ("a minimal file-open event listener wiring point").
// Listens for the ad hoc `rubrica://open-file` Tauri event `os_integration.rs`
// emits — not part of CONTRACTS §4 (that event surface is frozen and
// tauri-specta-generated); this is hand-rolled, OS-integration-only glue.
//
// Two cases land here identically:
//  - Cold start with a file argument (double-clicked a .pdf, association
//    routes to `Rubrica.exe "<path>"`) — delivered after the
//    `rubrica://frontend-ready` handshake below, so a path that arrived
//    before this listener attached is never lost.
//  - A second launch attempt while Rubrica is already running — the
//    single-instance plugin (Rust) focuses this window and forwards the
//    same event, so the file opens as a new tab here instead of a second
//    process.
import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { openDocumentByPath } from "./openDocument";

const OPEN_FILE_EVENT = "rubrica://open-file";
const FRONTEND_READY_EVENT = "rubrica://frontend-ready";

let started = false;

/** Call once, on app mount. No-op outside a real Tauri window (mock/dev). */
export function startFileOpenListener(): void {
  if (started || !isTauri()) return;
  started = true;

  void listen<string>(OPEN_FILE_EVENT, (event) => {
    void openDocumentByPath(event.payload);
  });

  void emit(FRONTEND_READY_EVENT);
}
