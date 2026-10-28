//! AcroForm field introspection + value filling via PDFium's form API — R5's
//! module. Empty at wave 0; `commands::forms` returns `UNSUPPORTED` until
//! this lands. Form *creation* is permanently out of scope.
//!
//! ## The headline finding: only `checkbox` is actually settable
//!
//! **Reading every field kind (`form_fields`) works correctly and is fully
//! implemented below.** Writing is a different story — verified empirically
//! against `fixtures/form.pdf` (same-handle re-reads, fresh-annotation-scan
//! re-reads, `save_to_bytes()` + fresh-PDFium-handle re-reads, and raw
//! byte-level inspection of the saved PDF), **only `checkbox` values can
//! actually be set** through pdfium-render 0.9.3's public API for a
//! realistic AcroForm (one where each field is its own dictionary with a
//! separate `Kids` array of WIDGET annotations — i.e. what every real
//! authoring tool, `pdf-lib` included, produces; NOT the degenerate
//! single-merged-dictionary case). `text` and `radio` both have a public,
//! real-looking setter that **returns `Ok(())` while silently writing
//! nothing anyone will ever read back** — this is the wave's headline
//! discovery, on the same footing as R2's PDFium thread-safety finding, and
//! it directly contradicts this module's own original brief ("Text fields:
//! ... Fully usable"), which had verified the setter *compiles* and is
//! public but had not yet round-tripped it against a real multi-object
//! AcroForm. See "Radio groups" and "Text fields" below for the two
//! separate, precisely-diagnosed root causes; `commands/forms.rs`'s
//! `form_set_value` surfaces `UNSUPPORTED` for `text`/`radio`/`combo`/
//! `listbox`, and only actually mutates the document for `checkbox`.
//!
//! **Why checkbox alone survives**: `PdfFormCheckboxField::is_checked()`
//! and `::set_checked()` both operate purely on the widget annotation's own
//! `"AS"` dictionary key, via the *generic*, non-form-fill-engine-aware
//! `FPDFAnnot_GetStringValue`/`SetStringValue` FFI calls — read and write
//! are symmetric, both scoped to the one object `self.annotation_handle()`
//! names. Every other writable kind instead round-trips through
//! `FPDFAnnot_GetFormFieldValue`/`SetStringValue_str(..., "V", ...)`, and
//! that pair is *not* symmetric: the setter writes `"V"` onto the WIDGET's
//! own annotation dictionary, but the getter resolves the FIELD's value
//! through PDFium's form-fill engine (which correctly walks up to the
//! shared FIELD dictionary for reads, exactly as it must to make
//! `group_value()`/`field.name()` work at all across a Kids array) — so a
//! write via the widget never becomes visible through the getter that
//! everything else (including this module's own re-reads, and the actual
//! rendered/exported PDF any other viewer would show) relies on.
//!
//! ## Value-string convention
//!
//! CONTRACTS' `FormField.value`/`form_set_value(value)` is "always a plain
//! string" but doesn't pin down what that string looks like per `kind`. The
//! existing mock fixture (`src/ipc/mock/state.ts`'s `field-subscribe`) and
//! the UI built against it (`src/tools/forms/fields/CheckboxFieldEditor.tsx`,
//! whose own doc comment is explicit: "PDF's own On/Off export-value
//! convention rather than a boolean") settle checkbox values as the plain
//! strings `"On"`/`"Off"` — **not** pdfium-render's own internal checkbox
//! convention (`"Yes"`/`"Off"`, see `PdfFormCheckboxField::set_checked`'s
//! source) and **not** `PdfForm::field_values()`'s convention either (that
//! convenience method — unused by this module, kept only as a
//! cross-reference — reports checkboxes as `"true"`/`"false"`, a second,
//! *different* mismatch against the mock/UI). This module translates:
//! `is_checked() -> "On"/"Off"` on the way out, `value == "On" ->
//! set_checked(bool)` on the way in. Text/radio/combo/listbox values are the
//! field's own text as PDFium reports it, no translation needed.
//!
//! ## Radio groups
//!
//! A PDF radio *field* is one AcroForm field name shared by several sibling
//! WIDGET annotations (PDFium's "control group"), each potentially on a
//! different page/rect — CONTRACTS' `FormField` has exactly one `rect`/
//! `page` per id. This module collapses each group into one `FormField`:
//! `id` = the shared field name, `rect`/`page` = the first sibling widget
//! encountered in document order, `options` = every sibling's own token
//! (see below), `value` = the checked sibling's token, or `""` if none is
//! checked (a legal PDF radio-group state).
//!
//! **Reading a group's checked state cannot use the public
//! `is_checked()`/`group_value()` at all — verified, both empirically and
//! by tracing pdfium-render 0.9.3's own source, to be actively wrong for
//! `fixtures/form.pdf`'s `identificacao.estadoCivil` group in two different
//! ways**:
//!
//! 1. In the group's untouched, nothing-ever-selected state, its field has
//!    no `/V` entry at all (a perfectly legal, common starting AcroForm
//!    state). `PdfFormRadioButtonField::group_value()` (`self.value_impl()`
//!    → `FPDFAnnot_GetFormFieldValue`) then returns `Some("Off")` instead of
//!    `None` — confirmed by printing it directly. Since every sibling's own
//!    `/AS` is *also* literally `"Off"` before any selection, `is_checked()`'s
//!    fallback comparison (`group_value() == appearance_stream()`) is
//!    `"Off" == "Off"` for **every single sibling simultaneously** — the
//!    whole group reads as "all four checked at once".
//! 2. Once a selection genuinely exists (verified with a pdf-lib-modified
//!    copy that calls `.select("Solteiro(a)")`), the mismatch flips the
//!    other way: the field's `/V` holds the *export text* (`"Solteiro(a)"`,
//!    resolved through the field's `/Opt` array), but the **selected
//!    widget's own `/AS`** is the *bare positional index* (`"0"`) — the two
//!    naming conventions pdf-lib uses for "the field's current value" vs.
//!    "this widget's own on-state name" never textually match, so
//!    `group_value() == appearance_stream()` is `false` even for the widget
//!    that actually *is* selected.
//!
//! The workaround this module uses instead: a widget is checked iff its
//! *own* `appearance_stream()` (`/AS`) is present and is not the literal
//! string `"Off"` — the PDF spec (ISO 32000-1 §12.7.4.2.3) reserves `"Off"`
//! as the mandatory off-state appearance name, so this holds regardless of
//! whichever naming convention `/V`/`/Opt` use, and was confirmed correct
//! against both fixture states above.
//!
//! **A second, separate, load-bearing gap sits under "every sibling's own
//! token" for `options`**: the natural implementation would report each
//! option as the field's actual export text (e.g. "Solteiro(a)") — but
//! there is **no public pdfium-render 0.9.3 API that recovers that text**
//! (it lives only in the field's `/Opt` array, resolved by
//! `FPDFAnnot_GetOptionCount`/`GetOptionLabel` — generic FFI calls whose own
//! doc comments describe them only in terms of "annot's Opt dictionary", not
//! any specific field type — but wrapped by `PdfFormFieldOptions`, whose
//! only constructor, `PdfFormFieldOptions::from_pdfium`, is `pub(crate)` and
//! only ever called by the crate's own dispatch for
//! `PdfFormFieldType::ComboBox`/`ListBox`, never `RadioButton`; likewise
//! `FPDFAnnot_GetFormFieldExportValue` is wrapped by the crate-private
//! `PdfFormFieldPrivate::export_value_impl` — `#[allow(dead_code)]` with a
//! `// TODO: ... will be removed if not required by PdfFormRadioButtonField`
//! in the vendored source, i.e. the crate author already anticipated this
//! need and never finished wiring it up). The only value that is both
//! public and stable regardless of selection state is
//! `PdfFormRadioButtonField::index_in_group()`; this module uses
//! `index_in_group().to_string()` ("0", "1", "2", ...) as each option's
//! token, for both `options` and `value`. **This means
//! `fixtures/form.pdf`'s "Estado civil" radio group surfaces as options
//! `["0","1","2","3"]`, not `["Solteiro(a)","Casado(a)","Divorciado(a)",
//! "Viúvo(a)"]`** — a real UX/fidelity loss, not a guess or a shortcut.
//!
//! **A third, more severe gap: `form_set_value` cannot actually select a
//! radio button in any real (more-than-one-widget) group at all**, despite
//! `set_checked()` being public, real, and returning `Ok(())`. Traced and
//! reproduced twice (from the group's untouched state, and from a
//! pdf-lib-pre-selected copy attempting to switch to a *different* option):
//! `set_checked()`'s implementation reads the target widget's own,
//! currently-inactive `appearance_stream()` (`"Off"`, since it isn't
//! selected yet) and writes that same string back via
//! `FPDFAnnot_SetStringValue_str(annotation_handle, "V", ...)` — which lands
//! on the **target WIDGET's own annotation dictionary**, not the shared
//! FIELD dictionary a multi-Kid radio field's `/V` actually lives on.
//! Neither `group_value()`/`is_checked()` nor a fresh
//! `save_to_bytes()` + reopen ever observes any change — confirmed directly
//! (see the wave report for the full byte-level trace). `write_value()`
//! therefore **verifies** the selection actually took effect (via the same
//! `appearance_stream() != "Off"` check used for reading) instead of
//! trusting `set_checked()`'s return value, and surfaces `UNSUPPORTED` with
//! [`RADIO_SET_UNVERIFIED_MESSAGE`] when it didn't — which, empirically, is
//! every time, for every real radio group. `form_set_value` on
//! `fixtures/form.pdf`'s radio field is consequently **not** actually
//! settable through this engine on pdfium-render 0.9.3, same as combo/
//! listbox, just discovered by testing rather than by reading source (this
//! is the one place in this module where the brief's confidence that "radio
//! must work for real" turned out not to hold up under an actual round-trip
//! test — see the wave report).
//!
//! (A `revert()` back to `""` — "restore to nothing selected" — never
//! attempts a write at all, so it's unaffected by the point above; it's
//! simply not achievable either, since `set_checked()` has no
//! deselect-only counterpart. This was already a known, accepted, minor
//! gap before the write-target bug above was found.)
//!
//! ## Text fields — also permanently unsupported for writing
//!
//! `PdfFormTextField::set_value()` is public, real, and returns `Ok(())`
//! — but suffers the exact same read/write mismatch as radio's `/V` (see
//! "The headline finding" above), and there is no workaround available for
//! text specifically: unlike checkbox's `appearance_stream()` (a public
//! *raw* `"AS"` getter that happens to expose the same key its setter
//! writes), there is no public raw `"V"` getter for text fields to fall
//! back on for verification the way [`radio_widget_is_selected`] does for
//! radio — `value()` is the *only* public read path, and it always goes
//! through the broken `FPDFAnnot_GetFormFieldValue`. Reproduced against
//! `fixtures/form.pdf`'s `identificacao.nome` field three independent ways:
//!
//! 1. Calling `.value()` again on the exact same `PdfFormTextField` handle
//!    immediately after `.set_value("Ana Silva")` returned `Ok(())` still
//!    returns `None`.
//! 2. A completely fresh page/annotation scan of the *same* `PdfDocument`
//!    also returns `None`.
//! 3. `document.save_to_bytes()` followed by a fresh `Pdfium` load of those
//!    bytes still returns `None` for `.value()` — **even though the saved
//!    bytes do contain the literal string `"Ana Silva"`**, written as
//!    `/V(Ana Silva)` directly onto the WIDGET's own annotation object
//!    (confirmed by locating the match in the raw saved PDF and printing
//!    the surrounding dictionary: `12 0 obj <</AP<</N 48 0 R>>/BS<...>/F 4
//!    /M(D:...) /MK<...> /P 6 0 R /Parent 11 0 R /Rect[...] /Subtype/Widget
//!    /Type/Annot /V(Ana Silva)>>` — object `12` is the WIDGET; the FIELD
//!    dictionary it's `/Parent`-linked to, object `11`, is untouched).
//!
//! Since nothing in this engine (or in any other conformant PDF viewer,
//! including a freshly-reopened Rubrica session) will ever read that
//! orphaned widget-level `"V"`, `form_set_value` on a text field doesn't
//! even attempt the write — it's rejected up front by [`validate_set_value`]
//! with the same honesty as combo/listbox, rather than silently corrupting
//! the file with dead data that only *looks* like it worked.
//!
//! ## Combo/listbox — permanently unsupported for writing
//!
//! `PdfFormComboBoxField`/`PdfFormListBoxField` expose `.value()` (reading)
//! but **no setter at all** — not even a crate-private one. The FFI call
//! that would do it correctly, `FORM_SetIndexSelected(FPDF_FORMHANDLE, ...)`,
//! needs an `FPDF_FORMHANDLE`, and `PdfForm::handle()` (the only place that
//! has one) is `pub(crate)`. There is no way to independently construct a
//! form-fill environment either, since that needs a raw `FPDF_DOCUMENT`
//! handle, equally `pub(crate)`-gated. `form_set_value` on a combo/listbox
//! field returns `UNSUPPORTED` — reading (`form_fields`) is fully
//! implemented for these two kinds; only writing is blocked.

use std::collections::HashMap;

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use crate::engine::document::DocumentSession;
use crate::engine::history::Command;
use crate::types::{CmdResult, FieldId, FormField, FormFieldKind, Rect, RubricaError};

const CHECKBOX_ON: &str = "On";
const CHECKBOX_OFF: &str = "Off";

fn pdfium_err(e: PdfiumError) -> RubricaError {
    RubricaError::internal(e.to_string())
}

fn rect_to_dto(rect: PdfRect) -> Rect {
    Rect {
        x: rect.left().value as f64,
        y: rect.bottom().value as f64,
        width: rect.width().value as f64,
        height: rect.height().value as f64,
    }
}

fn collect_options(options: &PdfFormFieldOptions) -> Option<Vec<String>> {
    let labels: Vec<String> = options.iter().filter_map(|o| o.label().cloned()).collect();
    if labels.is_empty() {
        None
    } else {
        Some(labels)
    }
}

/// Folds one radio-group sibling widget into `fields`/`radio_index`. See the
/// module doc comment ("Radio groups") for the id/rect/page/options/value
/// convention this implements. `checked` is computed by the caller (see
/// that call site's comment for why `PdfFormRadioButtonField::is_checked()`
/// itself cannot be trusted here).
#[allow(clippy::too_many_arguments)]
fn merge_radio_widget(
    fields: &mut Vec<FormField>,
    radio_index: &mut HashMap<String, usize>,
    id: String,
    page: u32,
    rect: Rect,
    read_only: bool,
    required: bool,
    token: String,
    checked: bool,
) {
    if let Some(&existing) = radio_index.get(&id) {
        let entry = &mut fields[existing];
        let options = entry.options.get_or_insert_with(Vec::new);
        if !options.contains(&token) {
            options.push(token.clone());
        }
        if checked {
            entry.value = token;
        }
        return;
    }

    let value = if checked {
        token.clone()
    } else {
        String::new()
    };
    fields.push(FormField {
        id: id.clone(),
        page,
        rect,
        kind: FormFieldKind::Radio,
        value,
        options: Some(vec![token]),
        read_only,
        required,
    });
    radio_index.insert(id, fields.len() - 1);
}

/// The actual `form_fields()` implementation — factored out from
/// [`list_fields`] so [`SetFormFieldValueCommand`] can re-derive a field's
/// current value from a bare `&PdfDocument` (it has no `&DocumentSession`
/// to call through).
fn scan_fields(doc: &PdfDocument<'static>) -> Result<Vec<FormField>, RubricaError> {
    let mut fields: Vec<FormField> = Vec::new();
    let mut radio_index: HashMap<String, usize> = HashMap::new();

    for (page_index, page) in doc.pages().iter().enumerate() {
        let page_index = page_index as u32;
        for (widget_index, annotation) in page.annotations().iter().enumerate() {
            let Some(field) = annotation.as_form_field() else {
                continue;
            };
            let field_type = field.field_type();
            if matches!(
                field_type,
                PdfFormFieldType::PushButton
                    | PdfFormFieldType::Signature
                    | PdfFormFieldType::Unknown
            ) {
                continue;
            }

            let rect = rect_to_dto(annotation.bounds().map_err(pdfium_err)?);
            let id = field
                .name()
                .unwrap_or_else(|| format!("p{page_index}-w{widget_index}"));
            let read_only = field.is_read_only();
            let required = field.is_required();

            if field_type == PdfFormFieldType::RadioButton {
                let radio = field
                    .as_radio_button_field()
                    .expect("field_type() said RadioButton");
                let token = radio.index_in_group().to_string();
                // NOTE: deliberately NOT `radio.is_checked()` — see the
                // module doc comment's "Radio groups" section. When a
                // group's field has no `/V` at all (nothing ever selected,
                // a perfectly legal starting AcroForm state — the exact
                // state `fixtures/form.pdf`'s `estadoCivil` group ships
                // in), pdfium-render 0.9.3's `FPDFAnnot_GetFormFieldValue`
                // returns the literal string `"Off"` instead of an
                // empty/absent value, which then spuriously equals every
                // sibling's own (also `"Off"`) `/AS` and reports every
                // widget in the group as checked simultaneously — verified
                // empirically against this exact fixture. PDF's own spec
                // (ISO 32000-1 §12.7.4.2.3) mandates `"Off"` as the
                // reserved off-state appearance name, so comparing this
                // widget's own `/AS` against that literal sidesteps the bug
                // entirely and is spec-safe in general, not a fixture-
                // specific hack.
                let checked = field
                    .appearance_stream()
                    .is_some_and(|state| state != "Off");
                merge_radio_widget(
                    &mut fields,
                    &mut radio_index,
                    id,
                    page_index,
                    rect,
                    read_only,
                    required,
                    token,
                    checked,
                );
                continue;
            }

            let (kind, value, options) = match field_type {
                PdfFormFieldType::Text => {
                    let text = field.as_text_field().expect("field_type() said Text");
                    (FormFieldKind::Text, text.value().unwrap_or_default(), None)
                }
                PdfFormFieldType::Checkbox => {
                    let checkbox = field
                        .as_checkbox_field()
                        .expect("field_type() said Checkbox");
                    let checked = checkbox.is_checked().unwrap_or(false);
                    let value = if checked { CHECKBOX_ON } else { CHECKBOX_OFF }.to_string();
                    (FormFieldKind::Checkbox, value, None)
                }
                PdfFormFieldType::ComboBox => {
                    let combo = field
                        .as_combo_box_field()
                        .expect("field_type() said ComboBox");
                    (
                        FormFieldKind::Combo,
                        combo.value().unwrap_or_default(),
                        collect_options(combo.options()),
                    )
                }
                PdfFormFieldType::ListBox => {
                    let listbox = field
                        .as_list_box_field()
                        .expect("field_type() said ListBox");
                    (
                        FormFieldKind::Listbox,
                        listbox.value().unwrap_or_default(),
                        collect_options(listbox.options()),
                    )
                }
                PdfFormFieldType::RadioButton
                | PdfFormFieldType::PushButton
                | PdfFormFieldType::Signature
                | PdfFormFieldType::Unknown => unreachable!("handled/filtered above"),
            };

            fields.push(FormField {
                id,
                page: page_index,
                rect,
                kind,
                value,
                options,
                read_only,
                required,
            });
        }
    }

    Ok(fields)
}

/// CONTRACTS §3's `form_fields(docId) -> FormField[]`. Read-only — see the
/// module doc comment for the exact `value`/`options` conventions.
pub fn list_fields(session: &DocumentSession) -> Result<Vec<FormField>, RubricaError> {
    scan_fields(session.document())
}

/// The message returned when a radio-group selection could not be
/// confirmed after calling `PdfFormRadioButtonField::set_checked()` — see
/// [`write_value`]'s doc comment for the full, empirically-verified
/// explanation.
const RADIO_SET_UNVERIFIED_MESSAGE: &str = "form_set_value: radio-group selection could not be verified after calling PdfFormRadioButtonField::set_checked() — pdfium-render 0.9.3's set_checked() reads the target widget's OWN currently-active appearance-stream name (\"/AS\", which is \"Off\" until it is actually selected) and writes that same string back as the field's \"/V\" onto the WIDGET's own annotation dictionary rather than the shared FIELD dictionary; for any field with more than one Kid widget (i.e. every real multi-option radio group) that write is never visible via any read path — not even after a save-to-bytes + fresh-handle reload. Verified empirically against fixtures/form.pdf's \"Estado civil\" group, both from its untouched (nothing pre-selected) state and from a pdf-lib-pre-selected copy attempting to switch to a different option; see the wave report for the full reproduction.";

/// Re-reads the on-disk state of a specific radio-group sibling widget and
/// reports whether it is *actually* the selected one (via the same
/// `appearance_stream() != "Off"` check `scan_fields` uses to sidestep the
/// `is_checked()`/`group_value()` bug documented in the module doc comment).
/// Used by [`write_value`] to confirm a `set_checked()` call really took
/// effect instead of trusting its `Ok(())` return value, which — per the
/// [`RADIO_SET_UNVERIFIED_MESSAGE`] finding — does not mean the selection
/// was actually persisted for a multi-widget group.
fn radio_widget_is_selected(
    doc: &PdfDocument<'static>,
    field_id: &str,
    token: &str,
) -> Result<bool, RubricaError> {
    for page in doc.pages().iter() {
        for annotation in page.annotations().iter() {
            let Some(field) = annotation.as_form_field() else {
                continue;
            };
            if field.field_type() != PdfFormFieldType::RadioButton {
                continue;
            }
            let id = field.name().unwrap_or_default();
            if id != field_id {
                continue;
            }
            let radio = field
                .as_radio_button_field()
                .expect("field_type() said RadioButton");
            if radio.index_in_group().to_string() != token {
                continue;
            }
            return Ok(field.appearance_stream().is_some_and(|s| s != "Off"));
        }
    }
    Ok(false)
}

/// Locates the field/widget(s) named `field_id` and writes `value` per the
/// module doc comment's conventions. Shared by [`SetFormFieldValueCommand`]'s
/// `apply` and `revert` (which differ only in which string they pass) —
/// `apply` passes the caller's new value (already validated against
/// `options`/`read_only` by [`validate_set_value`]); `revert` passes
/// whatever was recorded as the field's value before `apply` ran.
///
/// For a radio group, `value` not matching any sibling's own token
/// (`index_in_group().to_string()`) does not attempt any write — it's how
/// `revert()` represents "restore to nothing selected", which pdfium-render
/// has no API to actually perform (see the module doc comment) — the scan
/// still succeeds and reports every sibling's page as invalidated. When
/// `value` *does* match a sibling, [`write_value`] attempts the selection
/// and then **verifies** it actually took effect (see
/// [`radio_widget_is_selected`]) rather than trusting `set_checked()`'s own
/// `Ok(())` — a real multi-widget radio group's selection is never
/// observably settable via pdfium-render 0.9.3's public API (empirically
/// confirmed; see [`RADIO_SET_UNVERIFIED_MESSAGE`]), so this always
/// surfaces as `UNSUPPORTED` rather than a silent, false "success".
fn write_value(
    doc: &mut PdfDocument<'static>,
    field_id: &str,
    value: &str,
) -> Result<Vec<u32>, RubricaError> {
    let page_count = doc.pages().len();
    let mut radio_group_found = false;
    let mut radio_pages: Vec<u32> = Vec::new();
    let mut radio_selection_attempted = false;

    for page_index in 0..page_count {
        let page = doc.pages().get(page_index).map_err(pdfium_err)?;
        let widget_count = page.annotations().len();
        for widget_index in 0..widget_count {
            let mut annotation = page.annotations().get(widget_index).map_err(pdfium_err)?;
            let Some(field) = annotation.as_form_field_mut() else {
                continue;
            };
            let field_type = field.field_type();
            if matches!(
                field_type,
                PdfFormFieldType::PushButton
                    | PdfFormFieldType::Signature
                    | PdfFormFieldType::Unknown
            ) {
                continue;
            }

            let id = field
                .name()
                .unwrap_or_else(|| format!("p{page_index}-w{widget_index}"));

            if field_type == PdfFormFieldType::RadioButton {
                if id != field_id {
                    continue;
                }
                radio_group_found = true;
                let page_u32 = page_index as u32;
                if !radio_pages.contains(&page_u32) {
                    radio_pages.push(page_u32);
                }
                let radio = field
                    .as_radio_button_field_mut()
                    .expect("field_type() said RadioButton");
                if radio.index_in_group().to_string() == value {
                    radio.set_checked().map_err(pdfium_err)?;
                    radio_selection_attempted = true;
                }
                continue;
            }

            if id != field_id {
                continue;
            }

            match field_type {
                PdfFormFieldType::Checkbox => {
                    field
                        .as_checkbox_field_mut()
                        .expect("field_type() said Checkbox")
                        .set_checked(value == CHECKBOX_ON)
                        .map_err(pdfium_err)?;
                    return Ok(vec![page_index as u32]);
                }
                // `validate_set_value` already rejects both of these
                // up-front (see the module doc comment's "Text fields" and
                // "Combo/listbox" sections) — this defensive branch exists
                // only in case `write_value` is ever reached without going
                // through validation first, matching the same-shaped
                // defensive branch every other wave-2 module keeps for its
                // own invariants.
                PdfFormFieldType::Text => {
                    return Err(RubricaError::unsupported(
                        "form_set_value: text field values cannot be reliably set — PdfFormTextField::set_value() writes \"V\" onto the widget's own annotation dictionary, which the read path (FPDFAnnot_GetFormFieldValue) never consults for a field with a separate Kids-array widget (verified empirically against fixtures/form.pdf, including a raw byte-level inspection of the saved PDF; see the module doc comment)",
                    ));
                }
                PdfFormFieldType::ComboBox | PdfFormFieldType::ListBox => {
                    return Err(RubricaError::unsupported(
                        "form_set_value: combo/listbox values cannot be set — pdfium-render 0.9.3 exposes no public setter for these field kinds and no reachable FPDF_FORMHANDLE for the FORM_SetIndexSelected fallback (verified against the vendored crate source)",
                    ));
                }
                PdfFormFieldType::RadioButton
                | PdfFormFieldType::PushButton
                | PdfFormFieldType::Signature
                | PdfFormFieldType::Unknown => unreachable!("handled/filtered above"),
            }
        }
    }

    if radio_group_found {
        if radio_selection_attempted && !radio_widget_is_selected(doc, field_id, value)? {
            return Err(RubricaError::unsupported(RADIO_SET_UNVERIFIED_MESSAGE));
        }
        return Ok(radio_pages);
    }
    Err(RubricaError::not_found(format!(
        "no form field with id \"{field_id}\""
    )))
}

/// One reversible `form_set_value` mutation. `previous_value` is stashed by
/// `apply()` (read from the document right before mutating it) so `revert()`
/// can restore it — see `engine::history::Command`'s contract and this
/// module's doc comment for the radio-group caveat.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetFormFieldValueCommand {
    field_id: FieldId,
    new_value: String,
    #[serde(skip)]
    previous_value: Option<String>,
}

impl SetFormFieldValueCommand {
    pub fn new(field_id: FieldId, new_value: String) -> Self {
        Self {
            field_id,
            new_value,
            previous_value: None,
        }
    }
}

#[typetag::serde]
impl Command for SetFormFieldValueCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let fields = scan_fields(doc)?;
        let current = fields
            .iter()
            .find(|f| f.id == self.field_id)
            .ok_or_else(|| {
                RubricaError::not_found(format!("no form field with id \"{}\"", self.field_id))
            })?;
        self.previous_value = Some(current.value.clone());
        write_value(doc, &self.field_id, &self.new_value)
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let previous = self.previous_value.take().ok_or_else(|| {
            RubricaError::internal("revert called before apply on SetFormFieldValueCommand")
        })?;
        write_value(doc, &self.field_id, &previous)
    }
}

/// Looks up `field_id`, applies CONTRACTS' validation rules (mirroring
/// `mock/forms.ts::formSetValue`'s read-only/options checks, plus this
/// engine's own, empirically-forced `UNSUPPORTED` gate for every kind but
/// `checkbox` — see the module doc comment's "The headline finding"), and
/// returns the boxed-ready [`SetFormFieldValueCommand`] on success. Called
/// by `commands/forms.rs` *before* `DocumentSession::commit`, since
/// validation needs to read the field's current declared shape
/// (kind/options/read_only) — the command itself only re-derives the
/// current *value* (for `revert`) once it's actually applying.
///
/// `text` is rejected here, up front, rather than being attempted and
/// caught by a post-write verification the way `radio` is in
/// [`write_value`] — there is no public API to verify a text value's write
/// at all (see the module doc comment's "Text fields" section), so
/// attempting it would only ever leave dead, unreadable data in the saved
/// file for no benefit.
pub fn validate_set_value(
    session: &DocumentSession,
    field_id: &str,
    value: String,
) -> CmdResult<SetFormFieldValueCommand> {
    let fields = list_fields(session)?;
    let field = fields
        .iter()
        .find(|f| f.id == field_id)
        .ok_or_else(|| RubricaError::not_found(format!("no form field with id \"{field_id}\"")))?;

    if field.read_only {
        return Err(RubricaError::invalid_arg(format!(
            "field \"{field_id}\" is read-only"
        )));
    }

    match field.kind {
        FormFieldKind::Text => {
            return Err(RubricaError::unsupported(
                "form_set_value: text field values cannot be reliably set — PdfFormTextField::set_value() writes \"V\" onto the widget's own annotation dictionary, which the read path (FPDFAnnot_GetFormFieldValue) never consults for a field with a separate Kids-array widget (verified empirically against fixtures/form.pdf, including a raw byte-level inspection of the saved PDF; see the module doc comment)",
            ));
        }
        FormFieldKind::Combo | FormFieldKind::Listbox => {
            return Err(RubricaError::unsupported(
                "form_set_value: combo/listbox values cannot be set — pdfium-render 0.9.3 exposes no public setter for these field kinds and no reachable FPDF_FORMHANDLE for the FORM_SetIndexSelected fallback (verified against the vendored crate source)",
            ));
        }
        FormFieldKind::Radio => {
            if let Some(options) = &field.options {
                if !options.contains(&value) {
                    return Err(RubricaError::invalid_arg(format!(
                        "\"{value}\" is not one of field \"{field_id}\"'s options"
                    )));
                }
            }
            // Not rejected here even though it's *also* always going to
            // come back `UNSUPPORTED` in practice (see `write_value`'s
            // post-write verification) — unlike `text`, radio's failure
            // mode genuinely is "attempt, then verify", not "known
            // unsettable up front", since [`radio_widget_is_selected`]
            // gives this module a real (if currently always-negative)
            // verification path text doesn't have.
        }
        FormFieldKind::Checkbox => {}
    }

    Ok(SetFormFieldValueCommand::new(field_id.to_string(), value))
}

/// Sequential, plain-function fixture tests — see the brief's testing note
/// (mirroring `tests/engine_fixtures.rs`'s "one `#[test]`, many plain
/// sub-functions on one thread" pattern, since the vendored PDFium build is
/// not safe to touch from more than one OS thread, even across unrelated
/// documents). Deliberately **not** `#[cfg(test)]`-gated, for the same
/// reason `engine::history::test_commands` isn't (see that module's doc
/// comment): `tests/engine_fixtures.rs` is a separate integration-test
/// binary that links `rubrica_lib` as an ordinary dependency, so anything
/// gated on the *library's own* test build wouldn't exist for it to call.
/// `run_fixture_tests()` is the single entry point the orchestrator wires
/// into the combined meta-test at integration time.
pub mod fixture_tests {
    use std::path::PathBuf;

    use crate::engine::document::DocumentSession;
    use crate::engine::forms::{self, CHECKBOX_OFF, CHECKBOX_ON};
    use crate::types::{FormFieldKind, RubricaErrorCode};

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
    }

    fn copy_form_fixture_to_scratch() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("form.pdf");
        std::fs::copy(fixture_dir().join("form.pdf"), &dest)
            .expect("copy form.pdf into scratch dir");
        (dir, dest)
    }

    pub fn run_fixture_tests() {
        reads_all_real_fields_from_form_pdf();
        sets_checkbox_and_persists_after_reopen();
        text_set_value_is_unsupported_not_a_crash();
        combo_set_value_is_unsupported_not_a_crash();
        radio_set_value_is_unsupported_despite_set_checked_reporting_ok();
        radio_out_of_options_value_is_invalid_arg();
        undo_redo_round_trips_a_field_value_change();
    }

    fn reads_all_real_fields_from_form_pdf() {
        let (_dir, path) = copy_form_fixture_to_scratch();
        let session = DocumentSession::open(path.to_str().unwrap()).expect("form.pdf should open");
        let fields = forms::list_fields(&session).expect("form_fields should succeed");

        assert_eq!(
            fields.len(),
            5,
            "fixtures/generate.mjs builds exactly 5 fields (2 text, 1 radio group, 1 combo, 1 checkbox), got: {fields:?}"
        );

        let nome = fields
            .iter()
            .find(|f| f.id == "identificacao.nome")
            .expect("identificacao.nome should be present");
        assert!(matches!(nome.kind, FormFieldKind::Text));
        assert_eq!(nome.value, "");
        assert!(!nome.read_only);

        let data_nascimento = fields
            .iter()
            .find(|f| f.id == "identificacao.dataNascimento")
            .expect("identificacao.dataNascimento should be present");
        assert!(matches!(data_nascimento.kind, FormFieldKind::Text));

        let estado_civil = fields
            .iter()
            .find(|f| f.id == "identificacao.estadoCivil")
            .expect("identificacao.estadoCivil should be present");
        assert!(matches!(estado_civil.kind, FormFieldKind::Radio));
        assert_eq!(
            estado_civil.value, "",
            "no radio option is pre-selected in the fixture"
        );
        let options = estado_civil
            .options
            .as_ref()
            .expect("radio group should report options");
        assert_eq!(
            options.len(),
            4,
            "Estado civil has 4 options (Solteiro(a)/Casado(a)/Divorciado(a)/Viúvo(a)), got: {options:?}"
        );

        let distrito = fields
            .iter()
            .find(|f| f.id == "identificacao.distrito")
            .expect("identificacao.distrito should be present");
        assert!(matches!(distrito.kind, FormFieldKind::Combo));
        assert_eq!(distrito.value, "Lisboa", "generate.mjs pre-selects Lisboa");
        let distrito_options = distrito
            .options
            .as_ref()
            .expect("combo should report options");
        assert_eq!(distrito_options.len(), 8, "Distrito has 8 options");
        assert!(distrito_options.contains(&"Lisboa".to_string()));
        assert!(distrito_options.contains(&"Porto".to_string()));

        let aceito = fields
            .iter()
            .find(|f| f.id == "identificacao.aceitoTermos")
            .expect("identificacao.aceitoTermos should be present");
        assert!(matches!(aceito.kind, FormFieldKind::Checkbox));
        assert_eq!(
            aceito.value, CHECKBOX_OFF,
            "checkbox starts unchecked in the fixture"
        );
    }

    /// The only kind that genuinely, verifiably round-trips through this
    /// engine — see the module doc comment's "The headline finding".
    fn sets_checkbox_and_persists_after_reopen() {
        let (_dir, path) = copy_form_fixture_to_scratch();
        let path_str = path.to_str().unwrap().to_string();

        {
            let mut session = DocumentSession::open(&path_str).expect("open");

            let cmd = forms::validate_set_value(
                &session,
                "identificacao.aceitoTermos",
                CHECKBOX_ON.to_string(),
            )
            .expect("setting the checkbox should validate");
            session.commit(Box::new(cmd)).expect("commit checkbox");

            let fields = forms::list_fields(&session).expect("list fields after edit");
            assert_eq!(
                fields
                    .iter()
                    .find(|f| f.id == "identificacao.aceitoTermos")
                    .unwrap()
                    .value,
                CHECKBOX_ON,
                "the checkbox should report its new value immediately after commit"
            );

            session.save(false).expect("save");
        }

        // Fresh PDFium handle — the whole point of the portability check.
        let reopened = DocumentSession::open(&path_str).expect("reopen after save");
        let fields = forms::list_fields(&reopened).expect("list fields after reopen");

        let aceito = fields
            .iter()
            .find(|f| f.id == "identificacao.aceitoTermos")
            .unwrap();
        assert_eq!(aceito.value, CHECKBOX_ON);

        assert_portable(&path, 1);
    }

    /// Documents/exercises the module doc comment's "Text fields" finding:
    /// `PdfFormTextField::set_value()` looks fully usable (public, real,
    /// returns `Ok(())`) but never actually persists anything readable, so
    /// `validate_set_value` rejects it up front rather than attempting a
    /// write nothing will ever see.
    fn text_set_value_is_unsupported_not_a_crash() {
        let (_dir, path) = copy_form_fixture_to_scratch();
        let session = DocumentSession::open(path.to_str().unwrap()).expect("open");

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            forms::validate_set_value(&session, "identificacao.nome", "Ana Silva".to_string())
        }))
        .expect("attempting to set a text value must never panic");

        match result {
            Ok(_) => panic!(
                "text field writes are not actually settable on pdfium-render 0.9.3 for a \
                 realistic AcroForm (see the module doc comment) — this must surface as an \
                 error, not a false success"
            ),
            Err(err) => assert_eq!(err.code, RubricaErrorCode::Unsupported),
        }
    }

    fn combo_set_value_is_unsupported_not_a_crash() {
        let (_dir, path) = copy_form_fixture_to_scratch();
        let session = DocumentSession::open(path.to_str().unwrap()).expect("open");

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            forms::validate_set_value(&session, "identificacao.distrito", "Porto".to_string())
        }))
        .expect("attempting to set a combo value must never panic");

        match result {
            Ok(_) => panic!("combo/listbox writes are expected to be UNSUPPORTED, not to succeed"),
            Err(err) => assert_eq!(err.code, RubricaErrorCode::Unsupported),
        }
    }

    /// Documents/exercises the module doc comment's third radio-group
    /// finding: `PdfFormRadioButtonField::set_checked()` returns `Ok(())`
    /// (no crash, no error) but never actually persists the selection for a
    /// real (more-than-one-widget) group — `write_value()` catches this via
    /// its own post-write verification and surfaces `UNSUPPORTED` rather
    /// than letting the caller believe the field was set. This is
    /// `commands/forms.rs::form_set_value`'s actual, verified behavior for
    /// `fixtures/form.pdf`'s "Estado civil" field, not a hypothetical.
    fn radio_set_value_is_unsupported_despite_set_checked_reporting_ok() {
        let (_dir, path) = copy_form_fixture_to_scratch();
        let mut session = DocumentSession::open(path.to_str().unwrap()).expect("open");

        let fields = forms::list_fields(&session).expect("list fields");
        let target_option = fields
            .iter()
            .find(|f| f.id == "identificacao.estadoCivil")
            .and_then(|f| f.options.as_ref())
            .and_then(|opts| opts.get(1))
            .cloned()
            .expect("estadoCivil should have at least 2 options");

        let cmd = forms::validate_set_value(&session, "identificacao.estadoCivil", target_option)
            .expect("a valid, in-options radio value should pass validation");

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            session.commit(Box::new(cmd))
        }))
        .expect("attempting to set a radio value must never panic");

        match result {
            Ok(_) => panic!(
                "radio-group selection is not actually settable for a multi-widget group on \
                 pdfium-render 0.9.3 (see the module doc comment) — this must surface as an \
                 error, not a false success"
            ),
            Err(err) => assert_eq!(err.code, RubricaErrorCode::Unsupported),
        }

        // A failed apply() must not have mutated undo/revision state.
        assert!(
            !session.dirty(),
            "a failed commit must not leave the session dirty"
        );
    }

    fn radio_out_of_options_value_is_invalid_arg() {
        let (_dir, path) = copy_form_fixture_to_scratch();
        let session = DocumentSession::open(path.to_str().unwrap()).expect("open");

        let result = forms::validate_set_value(
            &session,
            "identificacao.estadoCivil",
            "not-an-option".to_string(),
        );
        match result {
            Ok(_) => panic!("an out-of-options radio value must be rejected"),
            Err(err) => assert_eq!(err.code, RubricaErrorCode::InvalidArg),
        }
    }

    /// Exercises undo/redo through `checkbox` — the only kind whose value
    /// actually changes (see the module doc comment's "The headline
    /// finding"), so it's the only one that can meaningfully prove
    /// `SetFormFieldValueCommand::revert()` restores the right thing.
    fn undo_redo_round_trips_a_field_value_change() {
        let (_dir, path) = copy_form_fixture_to_scratch();
        let mut session = DocumentSession::open(path.to_str().unwrap()).expect("open");

        let cmd = forms::validate_set_value(
            &session,
            "identificacao.aceitoTermos",
            CHECKBOX_ON.to_string(),
        )
        .expect("validate");
        session.commit(Box::new(cmd)).expect("commit");

        let fields = forms::list_fields(&session).unwrap();
        assert_eq!(
            fields
                .iter()
                .find(|f| f.id == "identificacao.aceitoTermos")
                .unwrap()
                .value,
            CHECKBOX_ON
        );

        session.undo().expect("undo").expect("something to undo");
        let fields = forms::list_fields(&session).unwrap();
        assert_eq!(
            fields
                .iter()
                .find(|f| f.id == "identificacao.aceitoTermos")
                .unwrap()
                .value,
            CHECKBOX_OFF,
            "undo should restore the field's previous (unchecked) value"
        );

        session.redo().expect("redo").expect("something to redo");
        let fields = forms::list_fields(&session).unwrap();
        assert_eq!(
            fields
                .iter()
                .find(|f| f.id == "identificacao.aceitoTermos")
                .unwrap()
                .value,
            CHECKBOX_ON,
            "redo should re-apply the change"
        );
    }

    /// Re-opens `path` through the shared PDFium handle and shells out to
    /// `scripts/verify-pdf.mjs` — the same two-half portability gate
    /// `tests/engine_fixtures.rs::assert_portable` uses (kept as a private
    /// duplicate here rather than importing across the test-binary
    /// boundary).
    fn assert_portable(path: &std::path::Path, expected_pages: u32) {
        let reopened = crate::engine::pdfium::shared()
            .load_pdf_from_file(path, None)
            .expect("saved PDF failed to re-open in PDFium");
        assert_eq!(reopened.pages().len() as u32, expected_pages);
        drop(reopened);

        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("verify-pdf.mjs");
        let status = std::process::Command::new("node")
            .arg(&script)
            .arg(path)
            .status()
            .expect("failed to launch `node scripts/verify-pdf.mjs` — is Node on PATH?");
        assert!(
            status.success(),
            "scripts/verify-pdf.mjs reported a failure for {}",
            path.display()
        );
    }
}
