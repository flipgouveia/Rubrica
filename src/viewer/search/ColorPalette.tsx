// Editing the highlight colour of one term position (mockup state G): 8 presets, a free `#RRGGBB`
// field with validation, and a live preview at the fixed highlight opacity. `ColorPalette` is the
// body, used inline by Settings → Pesquisa and inside `TermColorPopover` (opened from a term chip).
// Both write the same store (`searchPrefs.ts`), so a change is seen by the panel, the page and Settings.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HIGHLIGHT_SLOTS, hexToRgba, isHexColor, PRESET_COLORS, sameColor } from "./searchColors";
import { useSearchPrefs } from "./searchPrefs";

interface ColorPaletteProps {
  /** 0..3: the term position whose colour this edits. */
  slot: number;
  /** Text shown in the preview chip (the term; Settings has none and shows the hex). */
  example?: string;
  className?: string;
}

export function ColorPalette({ slot, example, className }: ColorPaletteProps) {
  const { t } = useTranslation("viewer");
  const color = useSearchPrefs((s) => s.highlightColors[slot]);
  const setHighlightColor = useSearchPrefs((s) => s.setHighlightColor);
  const [draft, setDraft] = useState(color);
  useEffect(() => setDraft(color), [color]);
  const invalid = draft !== "" && !isHexColor(draft);

  return (
    <div className={className} data-testid={`color-palette-${slot + 1}`}>
      <div className="grid grid-cols-4 gap-2 py-1.5">
        {PRESET_COLORS.map((hex) => {
          const selected = sameColor(hex, color);
          return (
            <button
              key={hex}
              type="button"
              aria-label={t("viewer.search.colorPreset", { hex })}
              aria-pressed={selected}
              data-color={hex}
              onClick={() => setHighlightColor(slot, hex)}
              className="h-[26px] rounded-md border border-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              style={{ background: hex, outline: selected ? "2px solid var(--rubrica-text)" : undefined, outlineOffset: selected ? 2 : undefined }}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5 text-xs">
        <label htmlFor={`color-hex-${slot}`} className="text-text">
          {t("viewer.search.colorCustom")}
        </label>
        <span
          className={
            "inline-flex items-center gap-1.5 rounded-sm border bg-surface px-2 py-0.5 font-mono " +
            (invalid ? "border-danger" : "border-border-strong")
          }
        >
          <i className="inline-block h-3.5 w-3.5 rounded-[3px] border border-black/10" style={{ background: isHexColor(draft) ? draft : color }} />
          <input
            id={`color-hex-${slot}`}
            type="text"
            value={draft}
            maxLength={7}
            spellCheck={false}
            aria-label={t("viewer.search.colorHex")}
            aria-invalid={invalid}
            onChange={(e) => {
              setDraft(e.target.value);
              if (isHexColor(e.target.value)) setHighlightColor(slot, e.target.value);
            }}
            onBlur={() => setDraft(color)}
            className="w-[4.5rem] bg-transparent text-xs uppercase text-text outline-none"
          />
        </span>
      </div>
      {invalid && (
        <p role="alert" className="pb-1 text-[11px] text-danger">
          {t("viewer.search.colorHexInvalid")}
        </p>
      )}
      <p className="m-0 flex items-center gap-1.5 pt-0.5 text-xs text-muted-text">
        {t("viewer.search.colorExample")}
        <mark data-testid="color-example" className="rounded-[2px] px-1 text-inherit" style={{ background: hexToRgba(color) }}>
          {example ?? color}
        </mark>
      </p>
    </div>
  );
}

interface TermColorPopoverProps {
  /** Term position (0-based among the positive terms); colours cycle past the 4th. */
  position: number;
  term: string;
  className?: string;
}

/** The palette popover of a term chip: "Cor 2 — prazo", the palette and "Repor originais". */
export function TermColorPopover({ position, term, className }: TermColorPopoverProps) {
  const { t } = useTranslation("viewer");
  const resetHighlightColors = useSearchPrefs((s) => s.resetHighlightColors);
  const slot = position % HIGHLIGHT_SLOTS;
  return (
    <div
      role="dialog"
      aria-label={t("viewer.search.termColor", { n: slot + 1, term })}
      className={"w-[250px] rounded-md border border-border bg-surface-raised p-2 text-sm text-text shadow-menu " + (className ?? "")}
    >
      <p className="m-0 pb-1 text-xs text-muted-text">
        {t("viewer.search.termColor", { n: slot + 1, term })}
      </p>
      <ColorPalette slot={slot} example={term} />
      <div className="mt-1 border-t border-border pt-1.5">
        <button type="button" onClick={resetHighlightColors} className="text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
          {t("viewer.search.colorReset")}
        </button>
      </div>
    </div>
  );
}
