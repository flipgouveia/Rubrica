// Shared visual chrome wrapped around every field editor's actual control:
// positions itself to fill its parent (sized by FieldOverlay via
// `pdfRectToScreen`), and renders the required/read-only indicators
// (brief item 3: "visually distinguish required fields ... and read-only
// fields").
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import type { FormField } from "../../../ipc/bindings";

export interface FieldChromeProps {
  field: FormField;
  pending: boolean;
  /** See `fields/types.ts`'s `FieldEditorProps.error` — a non-null value from the field's most recent rejected `form_set_value` call. */
  error?: string | null;
  children: ReactNode;
}

export function FieldChrome({ field, pending, error, children }: FieldChromeProps) {
  const { t } = useTranslation("tools-forms");
  // `error` only ever arrives for a non-read-only field (read-only editors
  // never call `onCommit`), so this and the read-only badge below never
  // compete for the same slot in practice.
  return (
    <div
      className={clsx(
        "relative flex h-full w-full items-stretch rounded-[3px] border transition-colors",
        field.readOnly ? "border-border bg-surface/70" : "border-accent/60 bg-surface/95 focus-within:border-accent",
        error && "border-danger/60",
        pending && "ring-2 ring-accent/50",
      )}
    >
      {children}
      {field.required && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-1 -top-1 select-none text-[11px] font-bold leading-none text-danger"
        >
          *
        </span>
      )}
      {field.readOnly && (
        <span className="pointer-events-none absolute -bottom-4 left-0 whitespace-nowrap rounded-sm bg-surface-raised px-1 text-[9px] leading-tight text-muted-text">
          {t("tools-forms:tools-forms.field.readOnlyBadge")}
        </span>
      )}
      {!field.readOnly && error && (
        <span
          role="alert"
          title={t("tools-forms:tools-forms.field.saveFailedTooltip", { message: error })}
          className="pointer-events-none absolute -bottom-4 left-0 whitespace-nowrap rounded-sm bg-danger px-1 text-[9px] leading-tight text-danger-foreground"
        >
          {t("tools-forms:tools-forms.field.saveFailedBadge")}
        </span>
      )}
    </div>
  );
}
