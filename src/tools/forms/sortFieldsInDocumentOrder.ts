// Deterministic "document order" for form fields (R4 brief item 3).
import type { FormField } from "../../ipc/bindings";

/**
 * Sorts fields into a stable, deterministic "reading order" across the
 * whole document:
 *
 *   1. Ascending `page` (page 0 before page 1, ...).
 *   2. Within a page, descending PDF `y` — PDF space is y-up, so a HIGHER
 *      `y` is HIGHER on the rendered page; sorting descending puts fields
 *      nearer the top of the page first, i.e. top-to-bottom reading order.
 *   3. Ascending `x` as a tiebreak for fields on the same row — left before
 *      right.
 *   4. `id` (lexicographic) as a final, total tiebreak for two fields that
 *      somehow share the exact same page/y/x (shouldn't happen with real
 *      field rects, but keeps this function a total order rather than
 *      leaning on `Array#sort`'s stability guarantees across engines).
 *
 * Pure and side-effect-free: returns a new array, never mutates `fields`.
 * Used both to drive explicit `tabIndex` assignment (see `useFormFields`)
 * and as the sequence "next field" navigation walks.
 */
export function sortFieldsInDocumentOrder(fields: FormField[]): FormField[] {
  return [...fields].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;

    const ay = a.rect.y ?? 0;
    const by = b.rect.y ?? 0;
    if (ay !== by) return by - ay;

    const ax = a.rect.x ?? 0;
    const bx = b.rect.x ?? 0;
    if (ax !== bx) return ax - bx;

    return a.id.localeCompare(b.id);
  });
}
