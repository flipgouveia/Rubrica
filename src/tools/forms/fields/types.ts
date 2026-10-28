import type { FormField } from "../../../ipc/bindings";

export interface FieldEditorProps {
  /** Needed to scope this field's entry in the cross-instance focus registry — see `fieldFocusRegistry.ts`. */
  docId: string;
  field: FormField;
  /** Explicit, globally-computed tab position (see `useFormFields.tabIndexFor`) — see FieldOverlay.tsx for why this can't just be DOM source order. */
  tabIndex: number;
  /** Whether this field's `form_set_value` call is currently in flight. */
  pending: boolean;
  /**
   * The error message from this field's most recent failed `form_set_value`
   * call, or `null`/`undefined` if its last commit succeeded (or none was
   * attempted yet, or the caller doesn't track this). Cleared by
   * `FieldOverlay` as soon as a later commit for this field succeeds.
   * Real-engine field kinds `form_set_value` can't actually persist (see
   * `engine::forms`'s module doc comment) surface here rather than failing
   * silently — see `TextFieldEditor`'s use of this to revert its own
   * optimistic draft. Optional (not just nullable) so existing component
   * tests that construct these props directly, without going through
   * `FieldOverlay`, don't all need updating just to opt into this.
   */
  error?: string | null;
  /**
   * Commits `value` for this field. `advance` is true for the "next field"
   * flow (Enter on the control) — the caller (FieldOverlay) only actually
   * moves focus if the commit succeeds, so a client-rejected value never
   * skips the field that rejected it.
   */
  onCommit: (value: string, advance: boolean) => void;
}
