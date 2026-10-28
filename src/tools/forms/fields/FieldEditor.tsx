// Dispatches to the right per-kind editor (brief item 3: "per-kind editors").
import { CheckboxFieldEditor } from "./CheckboxFieldEditor";
import { ChoiceFieldEditor } from "./ChoiceFieldEditor";
import { RadioFieldEditor } from "./RadioFieldEditor";
import { TextFieldEditor } from "./TextFieldEditor";
import type { FieldEditorProps } from "./types";

export function FieldEditor(props: FieldEditorProps) {
  switch (props.field.kind) {
    case "text":
      return <TextFieldEditor {...props} />;
    case "checkbox":
      return <CheckboxFieldEditor {...props} />;
    case "radio":
      return <RadioFieldEditor {...props} />;
    case "combo":
      return <ChoiceFieldEditor {...props} variant="combo" />;
    case "listbox":
      return <ChoiceFieldEditor {...props} variant="listbox" />;
    default: {
      // Exhaustiveness guard: a new `FormFieldKind` variant should be a
      // compile error here, not a silent blank field.
      const exhaustive: never = props.field.kind;
      return exhaustive;
    }
  }
}
