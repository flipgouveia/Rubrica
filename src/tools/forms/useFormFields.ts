// Doc-scoped form-field data + mutation hook.
//
// DEVIATION FROM THE BRIEF (documented, see r4-report.md): the brief points
// at a shared `src/tools/shared/useDocRevision.ts` hook ("load once, reload
// on every doc_state_changed for that doc"). That file does not exist yet
// in this worktree (see coords.ts's header for the same situation). This
// hook implements the identical load/reload shape inline, specialized for
// `form_fields`/`form_set_value`, so swapping in the real shared hook later
// is a small refactor, not a redesign.
//
// Unsaved-changes signal (brief item 3's "unsaved-value indicator"): this
// hook surfaces the document's own `dirty` flag (from `doc_state_changed`,
// CONTRACTS §2/§4) as the ONE "you have unsaved form changes" concept —
// every `form_set_value` call is already a committed mutation through the
// undo stack (CONTRACTS: "there's no separate draft state"), so "unsaved"
// can only honestly mean "not yet written to disk", which is exactly what
// `dirty` means. `pendingFieldIds` is a deliberately SEPARATE, narrower
// thing: which fields have a `form_set_value` call currently in flight,
// used only for a brief optimistic "saving..." affordance on the field
// itself — it is NOT a second notion of "unsaved", and callers should not
// treat it as one.
//
// Known tradeoff: every component that calls this hook (e.g. one
// `FieldOverlay` per page, plus a `FieldsPanel`) independently fetches
// `form_fields` and independently subscribes to `doc_state_changed`. At
// this tool's actual scale (a handful of fields on 1-2 pages) that's cheap
// and simple; a shared context/store would remove the duplicate fetches but
// isn't justified yet — flagged here rather than silently traded away.
import { useCallback, useEffect, useRef, useState } from "react";
import { commands, events } from "../../ipc";
import type { FormField } from "../../ipc/bindings";
import { focusFieldElement } from "./fieldFocusRegistry";
import { sortFieldsInDocumentOrder } from "./sortFieldsInDocumentOrder";

export interface SetValueOutcome {
  ok: boolean;
  message?: string;
}

export interface UseFormFieldsResult {
  /** Raw fields as returned by `form_fields`, unsorted. */
  fields: FormField[];
  /** `fields` sorted via `sortFieldsInDocumentOrder`. */
  orderedFields: FormField[];
  loading: boolean;
  /** Most recent `form_fields` error message, if any. */
  error: string | null;
  /** The document's own dirty flag — see header comment. */
  dirty: boolean;
  /** Fields with a `form_set_value` call currently in flight. */
  pendingFieldIds: ReadonlySet<string>;
  /** 1-based position of `fieldId` in `orderedFields` (0 if unknown) — used as each editor's explicit `tabIndex`. */
  tabIndexFor: (fieldId: string) => number;
  /** `orderedFields` filtered to one page, order preserved. */
  fieldsForPage: (page: number) => FormField[];
  /** Calls `form_set_value`; the resulting `doc_state_changed` event (mock and real alike) drives the refetch. */
  setValue: (fieldId: string, value: string) => Promise<SetValueOutcome>;
  /** Focuses a field's registered DOM element directly, if mounted. */
  focusField: (fieldId: string) => boolean;
  /**
   * "Next field" flow (brief item 3): advances to the field immediately
   * after `currentFieldId` in document order, WRAPPING to the first field
   * once past the last one — chosen so the control always does something
   * predictable (Enter on the last field loops back to the first, rather
   * than becoming a silent no-op there).
   */
  focusNextField: (currentFieldId: string) => boolean;
}

export function useFormFields(docId: string | null): UseFormFieldsResult {
  const [fields, setFields] = useState<FormField[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingFieldIds, setPendingFieldIds] = useState<ReadonlySet<string>>(new Set());
  const docIdRef = useRef(docId);
  docIdRef.current = docId;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    const result = await commands.formFields(id);
    if (docIdRef.current !== id) return; // doc changed/closed while this call was in flight
    setLoading(false);
    if (result.status === "error") {
      setError(result.error.message);
      return;
    }
    setError(null);
    setFields(result.data);
  }, []);

  useEffect(() => {
    if (!docId) {
      setFields([]);
      setDirty(false);
      setError(null);
      return;
    }
    void load(docId);
    const unlistenPromise = events.docStateChanged.listen((event) => {
      if (event.payload.docId !== docId) return;
      setDirty(event.payload.dirty);
      void load(docId);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [docId, load]);

  const orderedFields = sortFieldsInDocumentOrder(fields);

  const tabIndexFor = useCallback(
    (fieldId: string) => {
      const idx = orderedFields.findIndex((f) => f.id === fieldId);
      return idx === -1 ? 0 : idx + 1;
    },
    [orderedFields],
  );

  const fieldsForPage = useCallback((page: number) => orderedFields.filter((f) => f.page === page), [orderedFields]);

  const setValue = useCallback(async (fieldId: string, value: string): Promise<SetValueOutcome> => {
    const id = docIdRef.current;
    if (!id) return { ok: false, message: "no document open" };
    setPendingFieldIds((prev) => new Set(prev).add(fieldId));
    const result = await commands.formSetValue(id, fieldId, value);
    setPendingFieldIds((prev) => {
      const next = new Set(prev);
      next.delete(fieldId);
      return next;
    });
    if (result.status === "error") return { ok: false, message: result.error.message };
    return { ok: true };
  }, []);

  const focusField = useCallback((fieldId: string) => {
    const id = docIdRef.current;
    if (!id) return false;
    return focusFieldElement(id, fieldId);
  }, []);

  const focusNextField = useCallback(
    (currentFieldId: string) => {
      if (orderedFields.length === 0) return false;
      const idx = orderedFields.findIndex((f) => f.id === currentFieldId);
      const nextIdx = idx === -1 ? 0 : (idx + 1) % orderedFields.length;
      return focusField(orderedFields[nextIdx].id);
    },
    [orderedFields, focusField],
  );

  return {
    fields,
    orderedFields,
    loading,
    error,
    dirty,
    pendingFieldIds,
    tabIndexFor,
    fieldsForPage,
    setValue,
    focusField,
    focusNextField,
  };
}
