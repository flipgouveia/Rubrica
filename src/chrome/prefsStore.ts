// App-wide preferences (CONTRACTS §3 prefs_get/prefs_set, R3 brief: Settings screen — language,
// theme, accent colour, .bak toggle). Night-mode preference lives in `src/viewer/nightModeStore.ts` instead
// (it drives tile rendering directly, so the viewer owns it) even though Settings surfaces both
// from the same screen. Persisted one key per field so a future pref doesn't need a schema
// migration; loaded once at startup (see `usePrefsLoader` in AppShell) and kept in sync with
// i18n / the `data-theme` and `data-accent` attributes as a side effect of the setters themselves, so no component
// needs its own `useEffect` to apply a changed preference.
import { create } from "zustand";
import i18n, { DEFAULT_LANGUAGE, FALLBACK_LANGUAGE } from "../i18n";
import { commands } from "../ipc";
import { DEFAULT_ACCENT, isAccentId, type AccentId } from "../tokens/accentPresets";

export type ThemePref = "system" | "light" | "dark";
export type AppLanguage = typeof DEFAULT_LANGUAGE | typeof FALLBACK_LANGUAGE;

const KEYS = {
  language: "app.language",
  theme: "app.theme",
  backupOnSave: "app.backupOnSave",
  accentColor: "ui.accentColor",
} as const;

function applyTheme(theme: ThemePref): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** The accent's per-theme values are CSS blocks keyed on `data-accent` (tokens.css); the default has none. */
function applyAccent(accent: AccentId): void {
  const root = document.documentElement;
  if (accent === DEFAULT_ACCENT) root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", accent);
}

interface PrefsState {
  loaded: boolean;
  language: AppLanguage;
  theme: ThemePref;
  backupOnSave: boolean;
  accentColor: AccentId;
  load: () => Promise<void>;
  setLanguage: (language: AppLanguage) => void;
  setTheme: (theme: ThemePref) => void;
  setBackupOnSave: (value: boolean) => void;
  setAccentColor: (accent: AccentId) => void;
}

export const usePrefsStore = create<PrefsState>((set) => ({
  loaded: false,
  language: DEFAULT_LANGUAGE,
  theme: "system",
  backupOnSave: true,
  accentColor: DEFAULT_ACCENT,

  load: async () => {
    const [language, theme, backupOnSave, accentColor] = await Promise.all([
      commands.prefsGet(KEYS.language),
      commands.prefsGet(KEYS.theme),
      commands.prefsGet(KEYS.backupOnSave),
      commands.prefsGet(KEYS.accentColor),
    ]);
    const nextLanguage = (language.status === "ok" && language.data === FALLBACK_LANGUAGE ? FALLBACK_LANGUAGE : DEFAULT_LANGUAGE) as AppLanguage;
    const nextTheme: ThemePref = theme.status === "ok" && (theme.data === "light" || theme.data === "dark") ? theme.data : "system";
    const nextBackup = backupOnSave.status === "ok" && backupOnSave.data !== null ? backupOnSave.data === "true" : true;

    // An unknown id (a preset removed in a later version, a hand-edited db) falls back to the default.
    const nextAccent = accentColor.status === "ok" && isAccentId(accentColor.data) ? accentColor.data : DEFAULT_ACCENT;

    void i18n.changeLanguage(nextLanguage);
    applyTheme(nextTheme);
    applyAccent(nextAccent);
    set({ loaded: true, language: nextLanguage, theme: nextTheme, backupOnSave: nextBackup, accentColor: nextAccent });
  },

  setLanguage: (language) => {
    void i18n.changeLanguage(language);
    void commands.prefsSet(KEYS.language, language);
    set({ language });
  },

  setTheme: (theme) => {
    applyTheme(theme);
    void commands.prefsSet(KEYS.theme, theme);
    set({ theme });
  },

  setBackupOnSave: (value) => {
    void commands.prefsSet(KEYS.backupOnSave, String(value));
    set({ backupOnSave: value });
  },

  setAccentColor: (accent) => {
    applyAccent(accent);
    void commands.prefsSet(KEYS.accentColor, accent);
    set({ accentColor: accent });
  },
}));
