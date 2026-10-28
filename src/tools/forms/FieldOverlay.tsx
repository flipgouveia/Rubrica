// Field overlay: positions one editor per `FormField` over the page it
// belongs to, converting each field's PDF-point rect to CSS pixels via
// the shared `pdfRectToScreen` (`src/tools/shared/coords.ts`).
//
// Self-contained per the R4 brief ("Why chrome-mounting isn't part of this
// task"): only `docId`/`page`/`viewport` are required props. Fetching
// (`form_fields`) and mutating (`form_set_value`) both happen internally
// via `useFormFields`, so the eventual chrome host can mount one
// `FieldOverlay` directly on top of each rendered page tile without wiring
// any forms-specific state through itself.
//
// Cross-page tab order: two `FieldOverlay` instances (one per page) are
// separate React subtrees with no guaranteed relative DOM mount order, so
// plain source-order `tabIndex`es wouldn't reliably span pages. Instead
// every field gets an EXPLICIT, globally-computed `tabIndex` from
// `useFormFields.tabIndexFor` (based on `sortFieldsInDocumentOrder`), which
// the browser honors across sibling subtrees regardless of mount order.
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { pdfRectToScreen, type PageViewport } from "../shared/coords";
import { FieldEditor } from "./fields/FieldEditor";
import { useFormFields } from "./useFormFields";

export type { PageViewport };

export interface FieldOverlayProps {
  docId: string;
  page: number;
  viewport: PageViewport;
}

export function FieldOverlay({ docId, page, viewport }: FieldOverlayProps) {
  const { t } = useTranslation("tools-forms");
  const { fields, fieldsForPage, tabIndexFor, pendingFieldIds, setValue, focusNextField, error } = useFormFields(docId);
  const pageFields = fieldsForPage(page);
  // Per-field `form_set_value` failure, keyed by field id — some real-engine
  // field kinds can never actually persist a value (see `engine::forms`'s
  // module doc comment: only `checkbox` round-trips today), so a rejected
  // commit needs a real, visible outcome rather than looking like it
  // silently succeeded. See `fields/types.ts`'s `FieldEditorProps.error`.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleCommit = useCallback(
    (fieldId: string) => (value: string, advance: boolean) => {
      void (async () => {
        // A resubmitted, UNCHANGED value (e.g. Enter pressed without
        // editing anything) is treated as a pure "move to the next field"
        // — it never issues a redundant `form_set_value` call or a
        // pointless extra undo-stack entry.
        const current = fields.find((f) => f.id === fieldId);
        const unchanged = current !== undefined && current.value === value;
        const outcome = unchanged ? { ok: true } : await setValue(fieldId, value);
        if (outcome.ok) {
          setFieldErrors((prev) => {
            if (!(fieldId in prev)) return prev;
            const next = { ...prev };
            delete next[fieldId];
            return next;
          });
          if (advance) focusNextField(fieldId);
        } else {
          setFieldErrors((prev) => ({ ...prev, [fieldId]: outcome.message ?? "" }));
        }
      })();
    },
    [fields, setValue, focusNextField],
  );

  return (
    <div className="pointer-events-none absolute inset-0" data-rubrica-forms-page={page}>
      {error && (
        <p
          role="alert"
          className="pointer-events-auto absolute left-2 top-2 max-w-[80%] rounded-sm bg-danger px-2 py-1 text-xs text-danger-foreground"
        >
          {t("tools-forms:tools-forms.overlay.loadError", { message: error })}
        </p>
      )}
      {pageFields.map((field) => {
        const rect = pdfRectToScreen(field.rect, viewport);
        // Radio groups may need to grow past their rect's height (see
        // RadioFieldEditor's header comment) — every other kind gets a
        // fixed `height` so percentage-height children resolve correctly.
        const heightStyle = field.kind === "radio" ? { minHeight: rect.height } : { height: rect.height };
        return (
          <div
            key={field.id}
            className="pointer-events-auto absolute"
            style={{ left: rect.x, top: rect.y, width: rect.width, ...heightStyle }}
          >
            <FieldEditor
              docId={docId}
              field={field}
              tabIndex={tabIndexFor(field.id)}
              pending={pendingFieldIds.has(field.id)}
              error={fieldErrors[field.id] ?? null}
              onCommit={handleCommit(field.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
