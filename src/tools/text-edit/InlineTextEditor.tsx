// Single-line inline editor, positioned exactly over a rect via the
// viewport's `toScreen`. Used for two distinct jobs by `TextEditOverlay.tsx`:
// editing an existing text run's text in place, and collecting the text for
// a brand-new text box before `textobj_add` is called. Positioning/styling/
// commit-on-blur-or-Enter/cancel-on-Escape follows
// `src/tools/annotate/FreeTextEditor.tsx`'s pattern — kept as its own,
// text-edit-owned component (not an import of that one) since each tool
// folder owns its own UI end to end (ARCHITECTURE.md: "one folder per
// tool"), and because a text RUN is single-line (CONTRACTS: no paragraph
// reflow, ever) so a plain `<input>` fits better here than FreeTextEditor's
// multi-line `<textarea>`.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenRect } from "../shared/coords";

export interface InlineTextEditorProps {
  rect: ScreenRect;
  initialValue: string;
  fontSizePx: number;
  color: string;
  /**
   * true when editing an EXISTING object: committing an empty value still
   * calls `onCommit("")` (a legitimate "clear this run's text" edit).
   * false when creating a NEW object: an empty value cancels instead, so a
   * box the user backed out of is never created (matches FreeTextEditor's
   * own creation-only convention).
   */
  commitOnEmpty: boolean;
  placeholder?: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export function InlineTextEditor({ rect, initialValue, fontSizePx, color, commitOnEmpty, placeholder, onCommit, onCancel }: InlineTextEditorProps) {
  const { t } = useTranslation("tools-textedit");
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Removing this element while it's still focused (which committing/
  // cancelling always does, via the parent unmounting it) can fire a
  // synchronous native `blur` as a side effect of the DOM removal itself,
  // AFTER an Enter/Escape keydown already called `settle` once — without
  // this guard that would run `onCommit`/`onCancel` a second time (e.g. a
  // single Enter press calling `textobj_add` twice).
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function settle(action: () => void): void {
    if (settledRef.current) return;
    settledRef.current = true;
    action();
  }

  function commitOrCancel(): void {
    if (value.length > 0 || commitOnEmpty) settle(() => onCommit(value));
    else settle(onCancel);
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commitOrCancel}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          settle(onCancel);
        } else if (event.key === "Enter") {
          event.preventDefault();
          commitOrCancel();
        }
      }}
      placeholder={placeholder ?? t("tools-textedit.overlay.editPlaceholder")}
      className="absolute z-20 border border-accent bg-surface px-1 leading-tight text-text outline-none"
      style={{
        left: rect.x,
        top: rect.y,
        width: Math.max(rect.width, 60),
        height: Math.max(rect.height, fontSizePx * 1.4),
        color,
        fontSize: fontSizePx,
      }}
    />
  );
}
