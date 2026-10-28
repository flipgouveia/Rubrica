// Night reading mode (R3 brief: "invert/sepia canvas filter over tiles — view-only, persisted
// in prefs"). View-only by construction: it's a CSS filter applied to the tile layer in
// PageCanvas.tsx, never touches document content or any IPC mutation command.
import { create } from "zustand";
import { commands } from "../ipc";

export type NightModeStyle = "invert" | "sepia";

const KEYS = {
  enabled: "nightMode.enabled",
  style: "nightMode.style",
} as const;

/** CSS `filter` value for the tile layer. `undefined` when off (no filter applied). */
export function nightModeFilter(enabled: boolean, style: NightModeStyle): string | undefined {
  if (!enabled) return undefined;
  return style === "invert" ? "invert(1) hue-rotate(180deg)" : "sepia(0.55) brightness(0.92) contrast(1.05)";
}

interface NightModeState {
  loaded: boolean;
  enabled: boolean;
  style: NightModeStyle;
  load: () => Promise<void>;
  toggle: () => void;
  setStyle: (style: NightModeStyle) => void;
}

export const useNightModeStore = create<NightModeState>((set, get) => ({
  loaded: false,
  enabled: false,
  style: "sepia",

  load: async () => {
    const [enabled, style] = await Promise.all([commands.prefsGet(KEYS.enabled), commands.prefsGet(KEYS.style)]);
    set({
      loaded: true,
      enabled: enabled.status === "ok" && enabled.data === "true",
      style: style.status === "ok" && style.data === "invert" ? "invert" : "sepia",
    });
  },

  toggle: () => {
    const next = !get().enabled;
    void commands.prefsSet(KEYS.enabled, String(next));
    set({ enabled: next });
  },

  setStyle: (style) => {
    void commands.prefsSet(KEYS.style, style);
    set({ style });
  },
}));
