// How many tiles of each document are still waiting for their image. Tiles register while they
// load and unregister when they settle (or unmount), and the viewer shows ONE spinner per
// document while the count is above zero, instead of one per tile.
import { create } from "zustand";

interface TileLoadingState {
  pending: Record<string, number>;
  begin: (docId: string) => void;
  end: (docId: string) => void;
}

export const useTileLoadingStore = create<TileLoadingState>((set) => ({
  pending: {},
  begin: (docId) => set((s) => ({ pending: { ...s.pending, [docId]: (s.pending[docId] ?? 0) + 1 } })),
  end: (docId) =>
    set((s) => {
      const next = (s.pending[docId] ?? 0) - 1;
      const pending = { ...s.pending };
      if (next > 0) pending[docId] = next;
      else delete pending[docId];
      return { pending };
    }),
}));

/** True while any tile of the document is still loading (re-renders only when that flips). */
export function useDocTilesLoading(docId: string): boolean {
  return useTileLoadingStore((s) => (s.pending[docId] ?? 0) > 0);
}
