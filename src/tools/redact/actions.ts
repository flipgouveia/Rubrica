// Thin IO wrapper around `selectionToMarks.ts`'s pure conversion — reads the viewer's live text
// selection (`useSelectionStore`, read-only import; this tool never mutates viewer state) and the
// real `text_page_layout` command, then writes the resulting rects into this tool's own pending-
// marks store (`model.ts`). Kept separate from `selectionToMarks.ts` so that file stays free of
// React/IPC/store dependencies and directly unit-testable (mirrors `tools/annotate/selection.ts`'s
// split between pure geometry and its call sites).
import { commands } from "../../ipc";
import type { CharBox } from "../../ipc/bindings";
import { isCollapsed, useSelectionStore } from "../../viewer/selection/selectionStore";
import type { DocId } from "../../viewer/types";
import { useRedactStore } from "./model";
import { computeMarksFromSelection } from "./selectionToMarks";

async function fetchPageLayout(docId: DocId, page: number): Promise<CharBox[]> {
  const result = await commands.textPageLayout(docId, page);
  return result.status === "ok" ? result.data : [];
}

/**
 * Converts the viewer's current text selection (if any, non-collapsed, and belonging to `docId`)
 * into pending redaction marks — one per visual row per page it spans. Returns how many marks
 * were added (0 if there was nothing to convert), used by both the panel's "mark selection"
 * button and the `redact.markSelection` shortcut.
 */
export async function markSelectionAsPendingMarks(docId: DocId): Promise<number> {
  const selection = useSelectionStore.getState().selection;
  const marks = await computeMarksFromSelection(docId, selection, (page) => fetchPageLayout(docId, page));
  const { addMark } = useRedactStore.getState();
  for (const mark of marks) addMark(docId, mark.page, mark.rect);
  return marks.length;
}

/** Whether `docId` currently has a non-collapsed text selection worth converting — drives the panel's "mark selection" button `disabled` state. */
export function useHasMarkableSelection(docId: DocId): boolean {
  return useSelectionStore((state) => !!state.selection && state.selection.docId === docId && !isCollapsed(state.selection));
}
