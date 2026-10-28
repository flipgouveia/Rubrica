// Term chips of a proximity query (mockup states 1, D, G): one chip per term with a colour swatch
// by POSITION (the swatch opens the colour palette), excluded terms struck through, no swatch.
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocId } from "../types";
import { TermColorPopover } from "./ColorPalette";
import { parseQueryTerms } from "./queryTerms";
import { colorSlot, swatchFill } from "./searchColors";
import { useSearchPrefs } from "./searchPrefs";
import { useSearchStore } from "./searchStore";
import { useDismissable } from "./useDismissable";

export function TermChips({ docId }: { docId: DocId }) {
  const { t } = useTranslation("viewer");
  const text = useSearchStore((s) => s.byDoc[docId]?.query ?? "");
  const colors = useSearchPrefs((s) => s.highlightColors);
  const terms = useMemo(() => parseQueryTerms(text), [text]);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const close = useCallback(() => setOpenAt(null), []);
  const { ref, onKeyDown } = useDismissable<HTMLDivElement>(openAt !== null, close);

  if (terms.length === 0) return null;
  const opened = openAt !== null ? terms[openAt] : undefined;

  return (
    <div ref={ref} onKeyDown={onKeyDown} className="relative px-2 pb-2">
      <ul aria-label={t("viewer.search.terms")} className="m-0 flex list-none flex-wrap gap-[5px] p-0">
        {terms.map((term, i) =>
          term.excluded ? (
            <li
              key={i}
              data-excluded=""
              aria-label={t("viewer.search.termExcluded", { term: term.text })}
              className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-text line-through"
            >
              {term.text}
            </li>
          ) : (
            <li
              key={i}
              data-term-index={term.index}
              className="inline-flex items-center gap-[5px] rounded-full border border-border py-0.5 pl-1.5 pr-2 text-xs"
              style={openAt === i ? { borderColor: "var(--rubrica-accent)" } : undefined}
            >
              <button
                type="button"
                aria-label={t("viewer.search.changeTermColor", { term: term.text })}
                aria-haspopup="dialog"
                aria-expanded={openAt === i}
                data-color-slot={colorSlot(term.index) + 1}
                onClick={() => setOpenAt(openAt === i ? null : i)}
                className="inline-block h-[9px] w-[9px] rounded-[2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                style={{ background: swatchFill(colors, term.index) }}
              />
              {term.text}
            </li>
          ),
        )}
      </ul>
      {opened && !opened.excluded && (
        <TermColorPopover position={opened.index} term={opened.text} className="absolute left-2 top-full z-30 mt-1" />
      )}
    </div>
  );
}
