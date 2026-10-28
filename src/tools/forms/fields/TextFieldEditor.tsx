// `text`-kind field editor: an inline text input positioned over the
// field's rect (brief item 3, "per-kind editors").
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { registerFieldElement } from "../fieldFocusRegistry";
import { FieldChrome } from "./FieldChrome";
import { buildFieldAriaLabel } from "./fieldLabels";
import type { FieldEditorProps } from "./types";

export function TextFieldEditor({ docId, field, tabIndex, pending, error, onCommit }: FieldEditorProps) {
  const { t } = useTranslation("tools-forms");
  const [draft, setDraft] = useState(field.value);

  // Keep the local draft in sync with the committed value from elsewhere
  // (undo/redo, another view of the same field) — but only when it changes
  // out from under us, not on every render, so a user's in-progress
  // keystrokes are never clobbered by our own refetch-on-mutation.
  useEffect(() => {
    setDraft(field.value);
  }, [field.value]);

  // A rejected commit (e.g. this field's kind can't actually be persisted —
  // see `engine::forms`'s module doc comment) leaves `field.value` itself
  // unchanged, so the effect above never fires on its own: without this,
  // the input would keep showing the user's typed text as if it had saved.
  // Snap the draft back to the real, unchanged value as soon as the
  // rejection is known instead.
  useEffect(() => {
    if (error) setDraft(field.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  if (field.readOnly) {
    return (
      <FieldChrome field={field} pending={pending}>
        <input
          type="text"
          value={field.value}
          disabled
          tabIndex={-1}
          onChange={() => {}}
          aria-label={buildFieldAriaLabel(t, field)}
          aria-readonly="true"
          className="h-full w-full cursor-not-allowed bg-transparent px-1.5 text-xs text-muted-text outline-none"
        />
      </FieldChrome>
    );
  }

  const commit = (advance: boolean) => onCommit(draft, advance);

  return (
    <FieldChrome field={field} pending={pending} error={error}>
      <input
        ref={(el) => registerFieldElement(docId, field.id, el)}
        type="text"
        value={draft}
        aria-required={field.required || undefined}
        aria-label={buildFieldAriaLabel(t, field)}
        placeholder={field.required ? t("tools-forms:tools-forms.field.requiredPlaceholder") : undefined}
        tabIndex={tabIndex}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== field.value) commit(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(true);
          }
        }}
        className="h-full w-full bg-transparent px-1.5 text-xs text-text outline-none focus:bg-accent/5"
      />
    </FieldChrome>
  );
}
