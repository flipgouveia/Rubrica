// Accessible-name helpers shared by every per-kind field editor.
//
// CONTRACTS' `FormField` (§3) has no human-readable "label"/"name" property
// — only an opaque `id`. Real AcroForm fields do carry a name (PDFium's
// field name), but that isn't part of the frozen contract yet, so this
// module derives a presentable name from `id` instead: strip a leading
// "field-" (the mock fixture's own naming convention, see
// `src/ipc/mock/state.ts`) and turn remaining separators into spaces. This
// is a documented, deliberate stand-in — a real engine-backed `FormField`
// that adds a proper name later should replace `humanizeFieldId` at the two
// call sites below, not extend it.
import type { FormField } from "../../../ipc/bindings";

export function humanizeFieldId(id: string): string {
  const humanized = id.replace(/^field-/, "").replace(/[-_]+/g, " ").trim();
  return humanized.length > 0 ? humanized : id;
}

/** Loosely-typed on purpose: accepts react-i18next's `t` without importing its full generic overload set. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** Builds the field's accessible name, appending required/read-only state so screen readers announce both. */
export function buildFieldAriaLabel(t: TranslateFn, field: FormField): string {
  const name = humanizeFieldId(field.id);
  let label = t("tools-forms:tools-forms.field.ariaLabel", { name });
  if (field.required) label += t("tools-forms:tools-forms.field.requiredSuffix");
  if (field.readOnly) label += t("tools-forms:tools-forms.field.readOnlySuffix");
  return label;
}
