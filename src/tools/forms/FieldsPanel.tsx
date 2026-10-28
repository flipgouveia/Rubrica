// Field-values panel: lists every field with its current value, surfaces
// the document-level unsaved-changes indicator, and exposes a "next field"
// button (brief item 3's "'next field' flow" — Enter on a field is the
// keyboard-shortcut half of that same flow, see the per-kind editors).
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../tokens/components";
import { findFocusedFieldId } from "./fieldFocusRegistry";
import { humanizeFieldId } from "./fields/fieldLabels";
import { useFormFields } from "./useFormFields";

export interface FieldsPanelProps {
  docId: string;
}

export function FieldsPanel({ docId }: FieldsPanelProps) {
  const { t } = useTranslation(["tools-forms", "common"]);
  const { orderedFields, dirty, loading, focusField, focusNextField } = useFormFields(docId);

  const handleNextField = useCallback(() => {
    const currentId = findFocusedFieldId(docId);
    if (currentId) {
      focusNextField(currentId);
      return;
    }
    const first = orderedFields[0];
    if (first) focusField(first.id);
  }, [docId, orderedFields, focusField, focusNextField]);

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 text-sm">
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-text">{t("tools-forms:tools-forms.panel.title")}</h2>
        <Button size="sm" variant="secondary" onClick={handleNextField} disabled={orderedFields.length === 0}>
          {t("tools-forms:tools-forms.panel.nextField")}
        </Button>
      </header>

      {dirty && (
        <p role="status" className="rounded-sm bg-accent/10 px-2 py-1 text-xs font-medium text-accent">
          {t("tools-forms:tools-forms.unsaved.indicator")}
        </p>
      )}

      {orderedFields.length === 0 ? (
        <p className="text-xs text-muted-text">
          {loading ? t("common:common.status.loading") : t("tools-forms:tools-forms.panel.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {orderedFields.map((field) => {
            const displayValue = field.value || t("tools-forms:tools-forms.field.emptyValue");
            return (
              <li key={field.id} className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-none last:pb-0">
                <span className="text-xs font-medium text-text">
                  {humanizeFieldId(field.id)}
                  {field.required && (
                    <span aria-hidden="true" className="ml-1 text-danger">
                      *
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-text">
                  {t("tools-forms:tools-forms.panel.pageValueLine", { page: field.page + 1, value: displayValue })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
