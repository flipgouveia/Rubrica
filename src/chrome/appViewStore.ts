// Top-level navigation: which full-screen area is showing. Not a router (no deep links needed
// for a local desktop app) — just three mutually exclusive views. Opening a document switches to
// "viewer" automatically (see openDocument.ts); tabs stay open in the background when the user
// navigates to "home" or "settings", so returning to "viewer" resumes exactly where they left off.
//
// Settings is the one view that is "visited" rather than "went to": it remembers where it was
// opened from (`previousView`) so closing it returns there — to the open document, not to Home.
//
// Besides that, every view change is recorded in a back/forward history so the mouse's side
// buttons (and the Home screen's "back to document" button) can retrace the user's steps.
import { create } from "zustand";
import { useViewerStore } from "../viewer/store";

export type AppView = "home" | "viewer" | "settings";

interface AppViewState {
  view: AppView;
  /** The view Settings was opened from; only meaningful while `view === "settings"`. */
  previousView: Exclude<AppView, "settings">;
  /** Views the user can step back to (oldest first). */
  backStack: AppView[];
  /** Views the user can step forward to after going back (nearest last). */
  forwardStack: AppView[];
  navigate: (view: AppView) => void;
  /** Leaves Settings for the view it was opened from (Home when that was the viewer but no tab is open any more). */
  goBack: () => void;
  /** Steps back through the navigation history (mouse "back" button). No-op when there is nowhere to go. */
  historyBack: () => void;
  /** Steps forward again after `historyBack` (mouse "forward" button). */
  historyForward: () => void;
}

const HISTORY_LIMIT = 50;

/** "viewer" is only a valid destination while at least one tab is open. */
function isReachable(view: AppView): boolean {
  return view !== "viewer" || useViewerStore.getState().tabs.length > 0;
}

export const useAppViewStore = create<AppViewState>((set, get) => ({
  view: "home",
  previousView: "home",
  backStack: [],
  forwardStack: [],
  navigate: (view) => {
    const { view: current, backStack } = get();
    if (view === current) return;
    // Re-navigating to Settings while already there (e.g. the command palette) must not
    // overwrite where it was originally opened from.
    const previousView =
      view === "settings" && current !== "settings" ? (current as Exclude<AppView, "settings">) : get().previousView;
    set({
      view,
      previousView,
      backStack: [...backStack, current].slice(-HISTORY_LIMIT),
      forwardStack: [],
    });
  },
  goBack: () => {
    const { previousView, backStack } = get();
    const target: AppView = previousView === "viewer" && isReachable("viewer") ? "viewer" : "home";
    // Closing Settings retraces the step that opened it rather than adding a new one.
    const trimmed = backStack[backStack.length - 1] === target ? backStack.slice(0, -1) : backStack;
    set({ view: target, backStack: trimmed, forwardStack: [] });
  },
  historyBack: () => {
    const { view, backStack, forwardStack } = get();
    const stack = [...backStack];
    // Skip entries that no longer make sense (e.g. a viewer whose tabs were all closed) or that
    // equal the current view.
    while (stack.length > 0) {
      const candidate = stack.pop() as AppView;
      if (candidate === view || !isReachable(candidate)) continue;
      set({
        view: candidate,
        backStack: stack,
        forwardStack: [...forwardStack, view].slice(-HISTORY_LIMIT),
        previousView: candidate === "settings" ? get().previousView : candidate,
      });
      return;
    }
    set({ backStack: [] });
  },
  historyForward: () => {
    const { view, backStack, forwardStack } = get();
    const stack = [...forwardStack];
    while (stack.length > 0) {
      const candidate = stack.pop() as AppView;
      if (candidate === view || !isReachable(candidate)) continue;
      set({
        view: candidate,
        forwardStack: stack,
        backStack: [...backStack, view].slice(-HISTORY_LIMIT),
      });
      return;
    }
    set({ forwardStack: [] });
  },
}));
