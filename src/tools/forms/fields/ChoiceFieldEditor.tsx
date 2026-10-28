// `combo`/`listbox`-kind field editor.
//
// Both render a native `<select>` — chosen over the `Menu` primitive
// (brief: "your call") because a native select gives full keyboard
// behavior (arrow keys, type-ahead, Escape) for free, and because binding
// its `<option>` list 1:1 to `field.options` makes it STRUCTURALLY
// impossible to submit any value the field doesn't already advertise: the
// browser can only emit `e.target.value` from one of the rendered
// `<option>` elements, so there is no code path that could construct an
// invalid value in the first place (as opposed to constructing one and
// then validating it). `listbox` gets a taller `size` so more options are
// visible at once (closer to a real multi-row listbox), while still being
// a single-select control — CONTRACTS' `FormField.value` is one string for
// both kinds.
import { useTranslation } from "react-i18next";
import { registerFieldElement } from "../fieldFocusRegistry";
import { FieldChrome } from "./FieldChrome";
import { buildFieldAriaLabel } from "./fieldLabels";
import type { FieldEditorProps } from "./types";

export interface ChoiceFieldEditorProps extends FieldEditorProps {
  variant: "combo" | "listbox";
}

export function ChoiceFieldEditor({ docId, field, tabIndex, pending, error, onCommit, variant }: ChoiceFieldEditorProps) {
  const { t } = useTranslation("tools-forms");
  const options = field.options ?? [];
  const listboxSize = Math.min(Math.max(options.length, 2), 4);

  if (field.readOnly) {
    return (
      <FieldChrome field={field} pending={pending}>
        <select
          value={field.value}
          disabled
          tabIndex={-1}
          onChange={() => {}}
          size={variant === "listbox" ? listboxSize : undefined}
          aria-label={buildFieldAriaLabel(t, field)}
          className="h-full w-full cursor-not-allowed bg-transparent px-1 text-xs text-muted-text outline-none"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </FieldChrome>
    );
  }

  return (
    <FieldChrome field={field} pending={pending} error={error}>
      <select
        ref={(el) => registerFieldElement(docId, field.id, el)}
        value={field.value}
        required={field.required}
        aria-required={field.required || undefined}
        aria-label={buildFieldAriaLabel(t, field)}
        tabIndex={tabIndex}
        size={variant === "listbox" ? listboxSize : undefined}
        onChange={(e) => onCommit(e.target.value, false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(field.value, true);
          }
        }}
        className="h-full w-full bg-transparent px-1 text-xs text-text outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </FieldChrome>
  );
}
