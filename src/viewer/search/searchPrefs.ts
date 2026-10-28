// Search preferences (CONTRACTS v1.2.0 §8): mode, proximity window, ignore accents, exclude
// headers/footers, sort order and the four highlight colours. Same pattern as
// `src/chrome/prefsStore.ts`: one `prefs_get`/`prefs_set` key per field (string values), loaded once,
// persisted by the setters themselves. They are APP-WIDE (not per document): the next search, in
// any tab, starts from the last choice. `search.lastMode` / `search.panelWidth` (the layout of the
// panel, not of the query) stay in `searchController.ts`.
//
// A setter called before `load()` finishes wins over the stored value for that field (otherwise a
// slow `prefs_get` would undo the user's very first click).
import { create } from "zustand";
import { commands } from "../../ipc";
import {
  DEFAULT_HIGHLIGHT_COLORS,
  HIGHLIGHT_SLOTS,
  isHexColor,
  normalizeHex,
  parseHighlightColors,
} from "./searchColors";

export type QueryMode = "phrase" | "proximity";
export type SortOrder = "compact" | "position";

export const PROXIMITY_WINDOW_MIN = 20;
export const PROXIMITY_WINDOW_MAX = 5000;
export const PROXIMITY_WINDOW_DEFAULT = 500;
/** Quick picks next to the free number field (mockup state D). */
export const PROXIMITY_WINDOW_PRESETS: readonly number[] = [100, 250, 500, 1000];

export const PREF_KEYS = {
  mode: "search.mode",
  proximityWindow: "search.proximityWindow",
  ignoreDiacritics: "search.ignoreDiacritics",
  excludeHeadersFooters: "search.excludeHeadersFooters",
  sort: "search.sort",
  highlightColors: "search.highlightColors",
} as const;

interface PrefValues {
  mode: QueryMode;
  proximityWindow: number;
  ignoreDiacritics: boolean;
  excludeHeadersFooters: boolean;
  sort: SortOrder;
  highlightColors: string[];
}

interface SearchPrefsState extends PrefValues {
  loaded: boolean;
  load: () => Promise<void>;
  setMode: (mode: QueryMode) => void;
  toggleMode: () => void;
  setProximityWindow: (window: number) => void;
  setIgnoreDiacritics: (value: boolean) => void;
  setExcludeHeadersFooters: (value: boolean) => void;
  setSort: (sort: SortOrder) => void;
  setHighlightColor: (slot: number, hex: string) => void;
  resetHighlightColors: () => void;
}

function defaults(): PrefValues {
  return {
    mode: "phrase",
    proximityWindow: PROXIMITY_WINDOW_DEFAULT,
    ignoreDiacritics: true,
    excludeHeadersFooters: false,
    sort: "compact",
    highlightColors: [...DEFAULT_HIGHLIGHT_COLORS],
  };
}

export function clampWindow(value: number): number {
  const rounded = Math.round(value);
  return Math.min(PROXIMITY_WINDOW_MAX, Math.max(PROXIMITY_WINDOW_MIN, rounded));
}

export function isValidWindow(value: number): boolean {
  return Number.isInteger(value) && value >= PROXIMITY_WINDOW_MIN && value <= PROXIMITY_WINDOW_MAX;
}

function persist(key: string, value: string): void {
  try {
    void Promise.resolve(commands.prefsSet(key, value)).catch(() => undefined);
  } catch {
    // prefs are best-effort: a failing store must never break the search UI
  }
}

async function read(key: string): Promise<string | null> {
  try {
    const result = await commands.prefsGet(key);
    return result.status === "ok" ? result.data : null;
  } catch {
    return null;
  }
}

/** Fields the user already changed in this session: `load()` must not overwrite them. */
const touched = new Set<keyof PrefValues>();
let loadPromise: Promise<void> | null = null;

export const useSearchPrefs = create<SearchPrefsState>((set, get) => {
  const change = <K extends keyof PrefValues>(field: K, value: PrefValues[K], key: string, serialized: string) => {
    touched.add(field);
    persist(key, serialized);
    set({ [field]: value } as Pick<PrefValues, K>);
  };

  return {
    ...defaults(),
    loaded: false,

    load: () => {
      loadPromise ??= (async () => {
        const [mode, window, accents, furniture, sort, colors] = await Promise.all(Object.values(PREF_KEYS).map(read));
        const next: Partial<PrefValues> = {};
        if (mode === "phrase" || mode === "proximity") next.mode = mode;
        const parsedWindow = window === null ? NaN : Number(window);
        if (isValidWindow(parsedWindow)) next.proximityWindow = parsedWindow;
        if (accents === "true" || accents === "false") next.ignoreDiacritics = accents === "true";
        if (furniture === "true" || furniture === "false") next.excludeHeadersFooters = furniture === "true";
        if (sort === "compact" || sort === "position") next.sort = sort;
        const parsedColors = parseHighlightColors(colors);
        if (parsedColors) next.highlightColors = parsedColors;
        for (const field of touched) delete next[field];
        set({ ...next, loaded: true });
      })();
      return loadPromise;
    },

    setMode: (mode) => change("mode", mode, PREF_KEYS.mode, mode),
    toggleMode: () => get().setMode(get().mode === "phrase" ? "proximity" : "phrase"),
    setProximityWindow: (window) => {
      const value = clampWindow(window);
      change("proximityWindow", value, PREF_KEYS.proximityWindow, String(value));
    },
    setIgnoreDiacritics: (value) => change("ignoreDiacritics", value, PREF_KEYS.ignoreDiacritics, String(value)),
    setExcludeHeadersFooters: (value) => change("excludeHeadersFooters", value, PREF_KEYS.excludeHeadersFooters, String(value)),
    setSort: (sort) => change("sort", sort, PREF_KEYS.sort, sort),

    setHighlightColor: (slot, hex) => {
      if (slot < 0 || slot >= HIGHLIGHT_SLOTS || !isHexColor(hex)) return;
      const colors = get().highlightColors.map((color, i) => (i === slot ? normalizeHex(hex) : color));
      change("highlightColors", colors, PREF_KEYS.highlightColors, JSON.stringify(colors));
    },
    resetHighlightColors: () => {
      const colors = [...DEFAULT_HIGHLIGHT_COLORS];
      change("highlightColors", colors, PREF_KEYS.highlightColors, JSON.stringify(colors));
    },
  };
});

/** Back to the built-in defaults, forgetting that anything was loaded or touched (tests only). */
export function resetSearchPrefsForTests(): void {
  touched.clear();
  loadPromise = null;
  useSearchPrefs.setState({ ...defaults(), loaded: false });
}
