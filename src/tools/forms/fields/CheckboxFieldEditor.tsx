// `checkbox`-kind field editor. The mock fixture (and CONTRACTS' "value is
// always a plain string" note) uses PDF's own "On"/"Off" export-value
// convention rather than a boolean — see `src/ipc/mock/state.ts`'s
// `field-subscribe` fixture. This editor matches that convention exactly
// rather than inventing "true"/"false" or similar.
import { useTranslation } from "react-i18next";
import { registerFieldElement } from "../fieldFocusRegistry";
import { FieldChrome } from "./FieldChrome";
import { buildFieldAriaLabel } from "./fieldLabels";
import type { FieldEditorProps } from "./types";

const ON = "On";
const OFF = "Off";

export function CheckboxFieldEditor({ docId, field, tabIndex, pending, error, onCommit }: FieldEditorProps) {
  const { t } = useTranslation("tools-forms");
  const checked = field.value === ON;

  if (field.readOnly) {
    return (
      <FieldChrome field={field} pending={pending}>
        <input
          type="checkbox"
          checked={checked}
          disabled
          readOnly
          tabIndex={-1}
          onChange={() => {}}
          aria-label={buildFieldAriaLabel(t, field)}
          className="m-auto h-3/4 w-3/4 cursor-not-allowed"
        />
      </FieldChrome>
    );
  }

  return (
    <FieldChrome field={field} pending={pending} error={error}>
      <input
        ref={(el) => registerFieldElement(docId, field.id, el)}
        type="checkbox"
        checked={checked}
        aria-required={field.required || undefined}
        aria-label={buildFieldAriaLabel(t, field)}
        tabIndex={tabIndex}
        onChange={(e) => onCommit(e.target.checked ? ON : OFF, false)}
        onKeyDown={(e) => {
          // Space already toggles natively; Enter here is purely the
          // "next field" advance affordance (brief item 3), not a toggle.
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(checked ? ON : OFF, true);
          }
        }}
        className="m-auto h-3/4 w-3/4 accent-accent"
      />
    </FieldChrome>
  );
}
