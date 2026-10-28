// Tracks which text runs were most recently reported as font-substituted.
//
// CONTRACTS §3: `textobj_set_text` returns `SetTextResult { fontSubstituted
// }`, but that flag is only ever returned once, at edit time — `TextRun`
// itself (from `text_objects`) has no persistent "was this substituted"
// field. If the UI wants to keep showing a substitution badge on a run
// after the fact (e.g. the page scrolls out of view and back, remounting
// the overlay and re-fetching `text_objects`), it has to remember that
// itself. A zustand store, keyed by docId+objectId, does that job across
// every page overlay instance for the doc (same reasoning as `model.ts`'s
// header comment).
import { create } from "zustand";

interface SubstitutionState {
  substitutedKeys: ReadonlySet<string>;
  markSubstituted: (key: string) => void;
  clearSubstituted: (key: string) => void;
}

export const useSubstitutionStore = create<SubstitutionState>((set) => ({
  substitutedKeys: new Set(),
  markSubstituted: (key) =>
    set((state) => (state.substitutedKeys.has(key) ? state : { substitutedKeys: new Set(state.substitutedKeys).add(key) })),
  clearSubstituted: (key) =>
    set((state) => {
      if (!state.substitutedKeys.has(key)) return state;
      const next = new Set(state.substitutedKeys);
      next.delete(key);
      return { substitutedKeys: next };
    }),
}));

// `objectId` is only opaque-unique WITHIN one document (CONTRACTS §3) —
// namespace by docId so two open documents can never collide. Encoded as a
// JSON array (not a plain string join) so this stays injective no matter
// what characters either opaque id happens to contain.
export function substitutionKey(docId: string, objectId: string): string {
  return JSON.stringify([docId, objectId]);
}
