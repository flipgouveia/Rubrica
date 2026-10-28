// Cross-instance focus registry for form field editors.
//
// Why this exists: the forms tool renders one `FieldOverlay` per PAGE (so
// the eventual chrome host can mount it directly on top of whichever page
// tile is on screen — see FieldOverlay.tsx's header comment), but "next
// field" navigation (Enter on a field, or the panel's "next field" button)
// must be able to move focus into a field that lives in a DIFFERENT
// `FieldOverlay` instance than the one the command came from. Plain React
// refs don't reach across sibling component subtrees, so each field editor
// registers its own primary focusable element here (keyed by docId+fieldId)
// and `focusFieldElement`/`findFocusedFieldId` do the cross-instance lookup.
//
// Scoped by `docId` (not just `fieldId`) so two open documents' fields never
// collide. A single module-level `Map` is fine — there is exactly one such
// registry needed per running app instance, the same assumption the mock
// engine itself makes about "the" open document set.
const registry = new Map<string, HTMLElement>();

function key(docId: string, fieldId: string): string {
  return `${docId}::${fieldId}`;
}

/** Called from a field editor's ref callback; pass `null` on unmount to unregister. */
export function registerFieldElement(docId: string, fieldId: string, el: HTMLElement | null): void {
  const k = key(docId, fieldId);
  if (el) registry.set(k, el);
  else registry.delete(k);
}

/** Focuses the given field's registered element, if any is currently mounted. Returns whether it succeeded. */
export function focusFieldElement(docId: string, fieldId: string): boolean {
  const el = registry.get(key(docId, fieldId));
  if (!el) return false;
  el.focus();
  return true;
}

/** Finds which registered field (if any) for `docId` currently has DOM focus. */
export function findFocusedFieldId(docId: string): string | null {
  const prefix = `${docId}::`;
  for (const [k, el] of registry.entries()) {
    if (k.startsWith(prefix) && el === document.activeElement) {
      return k.slice(prefix.length);
    }
  }
  return null;
}
