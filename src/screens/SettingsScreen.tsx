// Settings screen (brief item 3): language pt-PT/en, theme, accent colour, .bak toggle, night-mode defaults.
// Also surfaces the live shortcut map (src/chrome/shortcuts.ts) so "every tool reachable by
// keyboard" (CONTRACTS §7) is discoverable in-app, not just in TOOL-API.md.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button, IconButton } from "../tokens/components";
import { useAppViewStore } from "../chrome/appViewStore";
import { ACCENT_PRESETS, type AccentId } from "../tokens/accentPresets";
import type { AppLanguage, ThemePref } from "../chrome/prefsStore";
import { usePrefsStore } from "../chrome/prefsStore";
import { formatCombo, useShortcutList } from "../chrome/shortcuts";
import type { NightModeStyle } from "../viewer/nightModeStore";
import { useNightModeStore } from "../viewer/nightModeStore";
import { ColorPalette } from "../viewer/search/ColorPalette";
import { HIGHLIGHT_SLOTS } from "../viewer/search/searchColors";
import { useSearchPrefs } from "../viewer/search/searchPrefs";

function SegmentedControl<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border-strong p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={
            value === option.value
              ? "rounded-sm bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
              : "rounded-sm px-3 py-1.5 text-sm text-text hover:bg-border/40"
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Radio group of accent swatches. Native radios (visually hidden) give the arrow-key behaviour for free. */
function AccentPicker({ value, onChange, label }: { value: AccentId; onChange: (value: AccentId) => void; label: string }) {
  const { t } = useTranslation("screens");
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-3">
      {ACCENT_PRESETS.map((preset) => {
        const name = t(`screens.settings.accent.${preset.id}`);
        return (
          <label key={preset.id} title={name} className="cursor-pointer">
            <input
              type="radio"
              name="accent-color"
              value={preset.id}
              checked={value === preset.id}
              onChange={() => onChange(preset.id)}
              className="peer sr-only"
            />
            <span className="sr-only">{name}</span>
            <span
              aria-hidden="true"
              data-accent-swatch={preset.id}
              className="block h-8 w-8 rounded-full border border-black/10 peer-checked:outline-2 peer-checked:outline-offset-2 peer-checked:outline-text peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-focus-visible:ring-focus-ring"
              style={{ background: preset.light.accent }}
            />
          </label>
        );
      })}
    </div>
  );
}

export function SettingsScreen() {
  const { t } = useTranslation(["screens", "common"]);
  const goBack = useAppViewStore((s) => s.goBack);
  const language = usePrefsStore((s) => s.language);
  const theme = usePrefsStore((s) => s.theme);
  const accentColor = usePrefsStore((s) => s.accentColor);
  const backupOnSave = usePrefsStore((s) => s.backupOnSave);
  const setLanguage = usePrefsStore((s) => s.setLanguage);
  const setTheme = usePrefsStore((s) => s.setTheme);
  const setAccentColor = usePrefsStore((s) => s.setAccentColor);
  const setBackupOnSave = usePrefsStore((s) => s.setBackupOnSave);
  const nightEnabled = useNightModeStore((s) => s.enabled);
  const nightStyle = useNightModeStore((s) => s.style);
  const toggleNightMode = useNightModeStore((s) => s.toggle);
  const setNightStyle = useNightModeStore((s) => s.setStyle);
  const shortcuts = useShortcutList();
  const resetHighlightColors = useSearchPrefs((s) => s.resetHighlightColors);
  // The search panel may never have been mounted (no document open): load the stored colours here too.
  useEffect(() => {
    void useSearchPrefs.getState().load();
  }, []);
  // Escape closes Settings, like the back button. A plain listener rather than a registered shortcut:
  // Escape is already an "always" binding (clear selection) and a second one would be flagged as a
  // collision. It listens in the CAPTURE phase because that global binding runs first in the bubble
  // phase and calls preventDefault, which would swallow every Escape here. Skipped while a dialog is
  // open (the command palette — it closes itself) or while typing in a field (the hex input).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      const typing = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type === "text") || (target instanceof HTMLElement && target.isContentEditable);
      if (typing || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      goBack();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [goBack]);

  return (
    <div className="h-full overflow-auto bg-background">
      <header className="flex items-center gap-3 border-b border-border px-8 py-5">
        <IconButton aria-label={t("common:common.actions.close")} onClick={goBack}>
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <h1 className="font-display text-2xl font-semibold text-text">{t("screens:screens.settings.title")}</h1>
      </header>

      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-8 py-8">
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-base font-semibold text-text">{t("screens:screens.settings.language.title")}</h2>
          <SegmentedControl<AppLanguage>
            value={language}
            onChange={setLanguage}
            options={[
              { value: "pt-PT", label: t("screens:screens.settings.language.ptPT") },
              { value: "en", label: t("screens:screens.settings.language.en") },
            ]}
          />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-display text-base font-semibold text-text">{t("screens:screens.settings.theme.title")}</h2>
          <SegmentedControl<ThemePref>
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: t("screens:screens.settings.theme.system") },
              { value: "light", label: t("screens:screens.settings.theme.light") },
              { value: "dark", label: t("screens:screens.settings.theme.dark") },
            ]}
          />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-display text-base font-semibold text-text">{t("screens:screens.settings.accent.title")}</h2>
          <AccentPicker value={accentColor} onChange={setAccentColor} label={t("screens:screens.settings.accent.title")} />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-display text-base font-semibold text-text">{t("screens:screens.settings.nightMode.title")}</h2>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={nightEnabled} onChange={toggleNightMode} />
            {t("screens:screens.settings.nightMode.enabled")}
          </label>
          <SegmentedControl<NightModeStyle>
            value={nightStyle}
            onChange={setNightStyle}
            options={[
              { value: "sepia", label: t("screens:screens.settings.nightMode.sepia") },
              { value: "invert", label: t("screens:screens.settings.nightMode.invert") },
            ]}
          />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-display text-base font-semibold text-text">{t("screens:screens.settings.backup.title")}</h2>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={backupOnSave} onChange={(e) => setBackupOnSave(e.target.checked)} />
            {t("screens:screens.settings.backup.description")}
          </label>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="settings-search-title">
          <h2 id="settings-search-title" className="font-display text-base font-semibold text-text">
            {t("screens:screens.settings.search.title")}
          </h2>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-text">{t("screens:screens.settings.search.colorsTitle")}</h3>
            <p className="m-0 text-sm text-muted-text">{t("screens:screens.settings.search.colorsDescription")}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: HIGHLIGHT_SLOTS }, (_, slot) => (
              <fieldset key={slot} className="m-0 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium text-text">{t("screens:screens.settings.search.colorN", { n: slot + 1 })}</legend>
                <ColorPalette slot={slot} />
              </fieldset>
            ))}
          </div>
          <div>
            <Button variant="secondary" size="sm" onClick={resetHighlightColors}>
              {t("screens:screens.settings.search.reset")}
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-display text-base font-semibold text-text">{t("screens:screens.settings.shortcuts.title")}</h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {shortcuts
              .filter((shortcut) => shortcut.scope === "always")
              .map((shortcut) => (
                <li key={shortcut.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-text">{t(shortcut.labelKey)}</span>
                  <kbd className="rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-text">
                    {formatCombo(shortcut.keys)}
                  </kbd>
                </li>
              ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
