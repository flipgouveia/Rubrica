// Store-level actions shared between the panel and every page overlay
// instance. `deleteSelectedTextObject` in particular needs to be callable
// from the PANEL's delete button — which has no reference to whichever page
// overlay instance currently "owns" the selection (they're unrelated
// siblings in the tree, see `model.ts`'s header comment) — so it reads/
// writes the shared stores directly via `getState()` instead of being a
// method on any one component.
import { commands } from "../../ipc";
import { useTextEditStore } from "./model";
import { substitutionKey, useSubstitutionStore } from "./substitutionStore";

/**
 * Deletes the currently selected text run (CONTRACTS §3 `object_delete`).
 * Only ever targets a text run: an image just placed this session has no
 * known `objectId` to select in the first place (see `TextEditPanel.tsx`'s
 * header comment for why), so `selection` can never point at one.
 * Returns whether the delete actually went through.
 */
export async function deleteSelectedTextObject(): Promise<boolean> {
  const { selection, setSelection } = useTextEditStore.getState();
  if (!selection) return false;
  const result = await commands.objectDelete(selection.docId, selection.objectId);
  if (result.status !== "ok") {
    console.error(`[text-edit] object_delete(${selection.objectId}) failed: ${result.error.message}`);
    return false;
  }
  useSubstitutionStore.getState().clearSubstituted(substitutionKey(selection.docId, selection.objectId));
  setSelection(null);
  return true;
}
