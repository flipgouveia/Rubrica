// `radio`-kind field editor.
//
// Unlike a typical PDF "one shared field name, several kid widgets"
// radio-group model, this mock's (and CONTRACTS') `FormField` already
// carries its OWN `options` array per radio-kind field (see
// `src/ipc/bindings.ts` / `src/ipc/mock/state.ts`'s `field-plan` fixture).
// So this renders one native `<input type="radio">` per option, all
// sharing one `name` so browser-native radio-group semantics (arrow-key
// cycling, single-selection) apply, laid out as a small vertical group
// INSIDE the field's rect.
//
// Sizing choice (brief: "your call, document the choice"): the group's
// container uses the rect's WIDTH exactly (that's the field's horizontal
// position on the page) but only a `minHeight` of the rect's height in the
// parent (`FieldOverlay`) — if there isn't enough vertical room for one
// comfortably-sized row per option (`MIN_OPTION_HEIGHT_PX`), the group
// grows downward past the rect rather than squeezing rows unreadably thin.
import type { CSSProperties, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { registerFieldElement } from "../fieldFocusRegistry";
import type { FieldEditorProps } from "./types";
import { buildFieldAriaLabel } from "./fieldLabels";

const MIN_OPTION_HEIGHT_PX = 16;

export function RadioFieldEditor({ docId, field, tabIndex, pending, error, onCommit }: FieldEditorProps) {
  const { t } = useTranslation("tools-forms");
  const options = field.options ?? [];
  const groupName = `rubrica-radio-${docId}-${field.id}`;

  const style: CSSProperties = { minHeight: options.length * MIN_OPTION_HEIGHT_PX };

  // Native radio-group tab semantics: only ONE radio per `name` group is a
  // tab stop (the checked one, or the first if none is checked yet) — Tab
  // moves the whole group as a single stop, arrow keys cycle the selection
  // within it. Mirror that by only giving the real `tabIndex` to that one
  // input and `-1` to the rest, rather than making every option its own
  // tab stop.
  const selectedIndex = options.findIndex((option) => option === field.value);
  const tabTargetIndex = selectedIndex === -1 ? 0 : selectedIndex;

  // Enter never changes which option is selected (only Space/click does,
  // matching native radio semantics) — it only ever resubmits the field's
  // OWN current value and asks to advance. FieldOverlay's commit handler
  // treats a resubmitted, unchanged value as a pure "move to the next
  // field" no-op rather than an extra `form_set_value` round-trip.
  const handleAdvanceKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommit(field.value, true);
    }
  };

  return (
    <div className="relative h-full w-full">
      <div
        role="radiogroup"
        aria-label={buildFieldAriaLabel(t, field)}
        aria-required={field.required || undefined}
        className={clsx(
          "flex h-full w-full flex-col justify-center gap-0.5 overflow-visible rounded-[3px] border px-1 py-0.5",
          field.readOnly ? "border-border bg-surface/70" : "border-accent/60 bg-surface/95",
          !field.readOnly && error && "border-danger/60",
          pending && "ring-2 ring-accent/50",
        )}
        style={style}
      >
        {options.map((option, i) => {
          const checked = field.value === option;
          return (
            <label
              key={option}
              className={clsx(
                "flex items-center gap-1 text-[10px] leading-none",
                field.readOnly ? "cursor-not-allowed text-muted-text" : "cursor-pointer text-text",
              )}
            >
              <input
                ref={i === tabTargetIndex ? (el) => registerFieldElement(docId, field.id, el) : undefined}
                type="radio"
                name={groupName}
                checked={checked}
                disabled={field.readOnly}
                tabIndex={field.readOnly ? -1 : i === tabTargetIndex ? tabIndex : -1}
                onChange={() => {
                  if (!field.readOnly) onCommit(option, false);
                }}
                onKeyDown={handleAdvanceKeyDown}
                className="accent-accent"
              />
              {option}
            </label>
          );
        })}
        {field.readOnly && (
          <span className="pointer-events-none mt-0.5 select-none text-[9px] leading-tight text-muted-text">
            {t("tools-forms:tools-forms.field.readOnlyBadge")}
          </span>
        )}
        {!field.readOnly && error && (
          <span
            role="alert"
            title={t("tools-forms:tools-forms.field.saveFailedTooltip", { message: error })}
            className="pointer-events-none mt-0.5 select-none text-[9px] leading-tight text-danger"
          >
            {t("tools-forms:tools-forms.field.saveFailedBadge")}
          </span>
        )}
      </div>
      {field.required && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-1 -top-1 select-none text-[11px] font-bold leading-none text-danger"
        >
          *
        </span>
      )}
    </div>
  );
}
