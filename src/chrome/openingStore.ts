// Tracks documents that are currently being opened (`doc_open` in flight). Opening a very large
// PDF can take many seconds; without this the UI just sat on the previous screen. The overlay in
// AppShell reads it to show a spinner with the file name.
import { create } from "zustand";

interface OpeningState {
  /** Paths being opened right now, oldest first. */
  paths: string[];
  begin: (path: string) => void;
  end: (path: string) => void;
}

export const useOpeningStore = create<OpeningState>((set) => ({
  paths: [],
  begin: (path) => set((s) => ({ paths: [...s.paths, path] })),
  end: (path) =>
    set((s) => {
      const index = s.paths.indexOf(path);
      if (index === -1) return s;
      return { paths: [...s.paths.slice(0, index), ...s.paths.slice(index + 1)] };
    }),
}));
