// The option rows of the docked panel, in the order of the mockup: mode (Frase/Proximidade) and
// window, the window presets, the term chips (proximity only), the scope selector and the two
// toggles. Everything reads/writes the app-wide preferences (`searchPrefs.ts`) and the per-document
// scope; the panel re-runs the search by itself when the resulting query changes.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocId } from "../types";
import { ScopeSelector } from "./ScopeSelector";
import {
  isValidWindow,
  PROXIMITY_WINDOW_MAX,
  PROXIMITY_WINDOW_MIN,
  PROXIMITY_WINDOW_PRESETS,
  useSearchPrefs,
  type QueryMode,
} from "./searchPrefs";
import { TermChips } from "./TermChips";

function ModeAndWindow() {
  const { t } = useTranslation("viewer");
  const mode = useSearchPrefs((s) => s.mode);
  const window = useSearchPrefs((s) => s.proximityWindow);
  const setMode = useSearchPrefs((s) => s.setMode);
  const setWindow = useSearchPrefs((s) => s.setProximityWindow);
  const [draft, setDraft] = useState(String(window));
  useEffect(() => setDraft(String(window)), [window]);
  const invalid = !isValidWindow(Number(draft)) || draft.trim() === "";

  const modes: { value: QueryMode; label: string }[] = [
    { value: "phrase", label: t("viewer.search.modePhrase") },
    { value: "proximity", label: t("viewer.search.modeProximity") },
  ];

  return (
    <>
      <div className="flex items-center gap-1.5 px-2 pb-2">
        <div role="group" aria-label={t("viewer.search.modeLabel")} className="inline-flex shrink-0 overflow-hidden rounded-md border border-border-strong">
          {modes.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={mode === option.value}
              onClick={() => setMode(option.value)}
              className={
                "px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring " +
                (mode === option.value ? "bg-accent font-semibold text-accent-foreground" : "text-muted-text hover:bg-border/40")
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        {mode === "proximity" && (
          <>
            <label htmlFor="search-window" className="ml-1.5 shrink-0 text-xs text-muted-text">
              {t("viewer.search.window")}
            </label>
            <input
              id="search-window"
              data-testid="search-window"
              type="number"
              min={PROXIMITY_WINDOW_MIN}
              max={PROXIMITY_WINDOW_MAX}
              value={draft}
              aria-label={t("viewer.search.windowInput")}
              aria-invalid={invalid}
              onChange={(e) => {
                setDraft(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value.trim() !== "" && isValidWindow(n)) setWindow(n);
              }}
              onBlur={() => setDraft(String(window))}
              className={
                "h-7 w-16 rounded-sm border bg-surface px-2 text-right text-sm tabular-nums text-text " +
                (invalid ? "border-danger" : "border-border-strong")
              }
            />
            <span className="shrink-0 text-xs text-muted-text">{t("viewer.search.windowUnit")}</span>
          </>
        )}
      </div>
      {mode === "proximity" && (
        <div className="px-2 pb-2">
          <div role="group" aria-label={t("viewer.search.windowPresets")} className="flex gap-1">
            {PROXIMITY_WINDOW_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={window === preset}
                onClick={() => setWindow(preset)}
                className={
                  "rounded-full border px-[7px] py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring " +
                  (window === preset ? "border-accent font-semibold text-accent" : "border-border text-muted-text hover:bg-border/40")
                }
              >
                {preset}
              </button>
            ))}
          </div>
          {invalid && (
            <p role="alert" className="m-0 pt-1 text-[11px] text-danger">
              {t("viewer.search.windowRange", { min: PROXIMITY_WINDOW_MIN, max: PROXIMITY_WINDOW_MAX })}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className="relative h-[15px] w-[26px] shrink-0 rounded-full bg-border-strong transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-[11px] after:w-[11px] after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:left-[13px] peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring"
      />
      {label}
    </label>
  );
}

export function SearchOptions({ docId }: { docId: DocId }) {
  const { t } = useTranslation("viewer");
  const mode = useSearchPrefs((s) => s.mode);
  const ignoreDiacritics = useSearchPrefs((s) => s.ignoreDiacritics);
  const excludeHeadersFooters = useSearchPrefs((s) => s.excludeHeadersFooters);
  const setIgnoreDiacritics = useSearchPrefs((s) => s.setIgnoreDiacritics);
  const setExcludeHeadersFooters = useSearchPrefs((s) => s.setExcludeHeadersFooters);

  return (
    <div data-testid="search-options" className="shrink-0">
      <ModeAndWindow />
      {mode === "proximity" && <TermChips docId={docId} />}
      {mode === "proximity" && <p className="m-0 px-2 pb-2 text-xs text-muted-text">{t("viewer.search.syntaxHint")}</p>}
      <ScopeSelector docId={docId} />
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 px-2 pb-2">
        <Toggle checked={ignoreDiacritics} onChange={setIgnoreDiacritics} label={t("viewer.search.ignoreDiacritics")} />
        <Toggle checked={excludeHeadersFooters} onChange={setExcludeHeadersFooters} label={t("viewer.search.excludeHeadersFooters")} />
      </div>
    </div>
  );
}
