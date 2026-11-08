// Shared "open a document" flow (CONTRACTS §3 doc_open) used by HomeScreen's open/recents/drag-
// drop paths and the recovery dialog — one place that opens a tab, switches to the viewer, and
// reports a typed failure back to the caller, so every entry point behaves identically.
import type { RubricaError } from "../ipc/bindings";
import { commands } from "../ipc";
import { useViewerStore } from "../viewer/store";
import { useAppViewStore } from "./appViewStore";
import { useOpeningStore } from "./openingStore";

export type OpenDocumentResult = { ok: true; docId: string } | { ok: false; error: RubricaError };

/** Last path segment of a Windows or POSIX path, for labelling a document by file name. */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

const inFlight = new Map<string, Promise<OpenDocumentResult>>();

/** Windows paths are case-insensitive and may use either separator. */
function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return normalize(a) === normalize(b);
}

export async function openDocumentByPath(path: string): Promise<OpenDocumentResult> {
  // Already open: switch to its tab instead of starting a second session on the same file.
  const existing = useViewerStore.getState().tabs.find((tab) => samePath(tab.info.path, path));
  if (existing) {
    useViewerStore.getState().setActiveTab(existing.docId);
    useAppViewStore.getState().navigate("viewer");
    return { ok: true, docId: existing.docId };
  }
  // The same file asked for twice while it is still opening (an impatient double click) shares
  // the one in-flight open instead of starting a second session.
  const pending = inFlight.get(path);
  if (pending) return pending;
  const opening = openFromEngine(path).finally(() => inFlight.delete(path));
  inFlight.set(path, opening);
  return opening;
}

async function openFromEngine(path: string): Promise<OpenDocumentResult> {
  useOpeningStore.getState().begin(path);
  try {
    const result = await commands.docOpen(path);
    if (result.status === "error") return { ok: false, error: result.error };
    useViewerStore.getState().openTab(result.data);
    useAppViewStore.getState().navigate("viewer");
    return { ok: true, docId: result.data.docId };
  } finally {
    useOpeningStore.getState().end(path);
  }
}
