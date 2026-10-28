// Top-level navigation: which full-screen area is showing. Not a router (no deep links needed
// for a local desktop app) — just three mutually exclusive views. Opening a document switches to
// "viewer" automatically (see openDocument.ts); tabs stay open in the background when the user
// navigates to "home" or "settings", so returning to "viewer" resumes exactly where they left off.
//
// Settings is the one view that is "visited" rather than "went to": it remembers where it was
// opened from (`previousView`) so closing it returns there — to the open document, not to Home.
import { create } from "zustand";
import { useViewerStore } from "../viewer/store";

export type AppView = "home" | "viewer" | "settings";

interface AppViewState {
  view: AppView;
  /** The view Settings was opened from; only meaningful while `view === "settings"`. */
  previousView: Exclude<AppView, "settings">;
  navigate: (view: AppView) => void;
  /** Leaves Settings for the view it was opened from (Home when that was the viewer but no tab is open any more). */
  goBack: () => void;
}

export const useAppViewStore = create<AppViewState>((set, get) => ({
  view: "home",
  previousView: "home",
  navigate: (view) => {
    const { view: current } = get();
    // Re-navigating to Settings while already there (e.g. the command palette) must not
    // overwrite where it was originally opened from.
    if (view === "settings" && current !== "settings") set({ view, previousView: current });
    else set({ view });
  },
  goBack: () => {
    const { previousView } = get();
    const hasTabs = useViewerStore.getState().tabs.length > 0;
    set({ view: previousView === "viewer" && hasTabs ? "viewer" : "home" });
  },
}));
