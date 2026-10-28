// Shared "open a document" flow (CONTRACTS §3 doc_open) used by HomeScreen's open/recents/drag-
// drop paths and the recovery dialog — one place that opens a tab, switches to the viewer, and
// reports a typed failure back to the caller, so every entry point behaves identically.
import type { RubricaError } from "../ipc/bindings";
import { commands } from "../ipc";
import { useViewerStore } from "../viewer/store";
import { useAppViewStore } from "./appViewStore";

export type OpenDocumentResult = { ok: true; docId: string } | { ok: false; error: RubricaError };

/** Last path segment of a Windows or POSIX path, for labelling a document by file name. */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export async function openDocumentByPath(path: string): Promise<OpenDocumentResult> {
  const result = await commands.docOpen(path);
  if (result.status === "error") return { ok: false, error: result.error };
  useViewerStore.getState().openTab(result.data);
  useAppViewStore.getState().navigate("viewer");
  return { ok: true, docId: result.data.docId };
}
