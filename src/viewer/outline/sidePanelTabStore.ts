// Which tab of the left side panel ("Miniaturas" / "Índice") is selected. One choice for the whole
// app (not per document), remembered across launches through `prefs_get`/`prefs_set` under
// `ui.sidePanelTab`. Anything but "outline" reads back as the default, thumbnails.
import { create } from "zustand";
import { commands } from "../../ipc";

export type SidePanelTab = "thumbnails" | "outline";

export const SIDE_PANEL_TAB_KEY = "ui.sidePanelTab";

interface SidePanelTabState {
  tab: SidePanelTab;
  /** True once the stored choice was read, or the user picked a tab (which wins over a late read). */
  settled: boolean;
  load: () => Promise<void>;
  setTab: (tab: SidePanelTab) => void;
}

export const useSidePanelTabStore = create<SidePanelTabState>((set, get) => ({
  tab: "thumbnails",
  settled: false,

  load: async () => {
    if (get().settled) return;
    try {
      const stored = await commands.prefsGet(SIDE_PANEL_TAB_KEY);
      if (get().settled) return;
      set({ settled: true, tab: stored.status === "ok" && stored.data === "outline" ? "outline" : "thumbnails" });
    } catch {
      set({ settled: true });
    }
  },

  setTab: (tab) => {
    set({ tab, settled: true });
    void commands.prefsSet(SIDE_PANEL_TAB_KEY, tab);
  },
}));
