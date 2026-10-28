# R5 — Engine editing modules: annotations, pages, forms (wave 2) report

Status: **done, with one accepted v1 scope cut.** All three domains' wave-0 `UNSUPPORTED` stubs
are replaced with real PDFium-backed implementations. `cargo fmt -- --check`, `cargo clippy
--all-targets -- -D warnings`, `cargo build`, and `cargo test` (from `src-tauri/`) are all green
on the combined tree, including R2's untouched suites and one new combined meta-test covering
all three new domains together. `pnpm typecheck`/`lint`/`test`/`i18n:check`/`bindings:check` are
all green on the frontend side. The headline finding — **pdfium-render 0.9.3 can only reliably
persist `checkbox` form-field values; `text`/`radio` setters silently no-op and `combo`/
`listbox` have no setter at all** — meant the brief's own DoD ("the government-form fixture
filled end-to-end") could only be partially met through the engine alone, through no shortcut on
this wave's part; the human orchestrator has since reviewed the finding and accepted it as the
shipped v1 behavior (see "Decision" below), and the forms UI was updated accordingly so the
accepted limitation reads as an honest, non-alarming "not saved" state rather than a silent
failure. See "Forms" below for the full, empirically-verified writeup of the underlying finding.

## How this wave was executed

Given the size (three real PDFium-editing subsystems, each independently non-trivial), I
delegated SA-1/SA-2/SA-3 exactly as the brief's subagent plan suggests — three parallel
subagents, each in an isolated worktree, each owning one domain's `commands/`+`engine/` file
pair. Before dispatching them I spent significant effort reading the vendored `pdfium-render
0.9.3` crate source directly (not just its doc comments) to pre-empt exactly the kind of "looks
achievable, isn't" trap the brief warns about — confirming, among other things, that **every
raw `FPDF_DOCUMENT`/`FPDF_PAGE`/`FPDF_ANNOTATION`/`FPDF_FORMHANDLE` handle accessor in the crate
is `pub(crate)`-gated with no exception**, so there is no raw-FFI escape hatch anywhere for
anything the ergonomic API doesn't already cover. I handed each subagent this research
up front, along with the exact integration pattern to mirror (`commands/history.rs`) and the
precise mock semantics to match (quoting the relevant `mock/*.ts` files directly in their
briefs), so none of them had to rediscover it independently. All three finished, reported back,
and I integrated their (uncommitted, disjoint-file) changes into this branch myself, wired one
combined fixture-test meta-test (see "Tests" below), and did the appearance-stream/UI-wiring
review the brief reserves for "yourself" (item 5 of the subagent plan).

## Deliverable 1: Annotations engine

All 7 CONTRACTS §3 kinds are implemented. Five are **fully native, no compromise**:
highlight/underline/strikeout (quadpoints + `/CA` opacity), ink (one detached path object per
stroke, opacity baked into each stroke's own alpha — see crash #2 below), note (a real `Text`/
sticky-note annotation, 24×24pt bbox matching `NOTE_ICON_SIZE_PT`), and `shape:rect` (a real
`Square` annotation). Two are a **documented, verified-portable compromise**:

- **`shape:ellipse`/`shape:line`/`shape:arrow`**: pdfium-render 0.9.3 has no
  `create_circle_annotation`/`create_line_annotation`, and — confirmed exhaustively — no raw-FFI
  fallback (every handle accessor needed is `pub(crate)`-gated: `PdfDocument::handle()`,
  `PdfPage::page_handle()`/`document_handle()`, `PdfPageAnnotations::create_annotation()`, even
  the `PdfPageObjectOwnership` enum itself, so you can't even pattern-match your way to a handle
  via an owned page object). The only annotation types with a mutable page-objects collection
  (`objects_mut()`) are Ink and **Stamp**. So these three shapes are stored as a real `Stamp`
  annotation (`/Subtype /Stamp`) whose own drawn appearance (a correctly stroked/filled ellipse
  path, or a line plus a small filled triangle for the arrowhead) is authored directly —
  **fully standard, portable PDF**: any conforming reader renders it identically to what a native
  Circle/Line annotation would show. The only compromise is `/Subtype` metadata fidelity (a PDF
  inspector sees "Stamp", not "Circle"/"Line"). Round-trip identity is preserved by a short
  marker in `/Contents` (U+2063 INVISIBLE SEPARATOR-delimited, not NUL — NUL risks truncation in
  some UTF-16LE paths) that `annot_list` uses to recognize "this Stamp is ours, and which shape
  kind" versus a genuine foreign rubber-stamp (skipped, not misreported). A native foreign
  `Circle` annotation (pdfium-render can *read*, just not *create*, one) is also read back as
  `shape:ellipse` for better fidelity on files Rubrica didn't create.
- **`freeText.font_size`/`.color`**: `font_size` has no setter in *any* version of the crate
  (checked the vendored source directly, not a feature-flag gap); `font_color` exists but is
  gated behind Cargo features this wave isn't permitted to enable, and there's no public way to
  write an arbitrary `/DA` string either. Accepted on `annot_add`, not persisted; `annot_list`
  reports fixed defaults (12pt, `#000000`) rather than fabricating a value the document doesn't
  actually back.
- **`shape:rect`'s `stroke.width`/`fill.opacity`**: no public getter/setter for `/BS` border
  width; `FPDFAnnot_SetColor`'s alpha channel writes `/CA` (whole-annotation opacity) but not
  `/IC`'s (there is no interior-color alpha at all in the PDF spec). Accepted on write, not
  round-tripped. The Stamp-based shapes don't have this limitation — their stroke/fill live on a
  real path object with genuine alpha, full round-trip.

**Two real PDFium crashes found empirically** (confirmed by actually running the code against
the vendored binary, not from any crate documentation, which says nothing about either):

1. Mutating a `PdfPagePathObject` *after* attaching it to an annotation's objects collection
   reliably segfaults. Fix: build each stroke's whole path detached, attach once, last.
2. Calling `set_stroke_color`/`set_fill_color` on an **Ink** annotation that already has content
   objects reliably segfaults: `FPDFAnnot_SetColor` fails for an appearance-stream-using
   annotation, and pdfium-render's own fallback then calls `FPDFPageObj_SetStrokeColor` with the
   *annotation's* handle reinterpreted as a page-*object* handle — a real type confusion in that
   fallback path. Fix: never call those setters on Ink after objects exist; bake opacity into
   each stroke's own alpha instead.
3. A related finding: removing one object from a *non-empty, live* Ink/Stamp annotation via
   `remove_object_at_index` also reliably segfaults (the identical call on a still-empty,
   freshly-created annotation is fine, and whole-annotation `delete_annotation` is always fine).
   Consequence: `UpdateAnnotCommand` never rewrites an Ink/Stamp-shape annotation's drawn
   geometry in place for a `rect`/bbox patch — it deletes the whole annotation and recreates it,
   tracked via a `current_index` field that survives journal replay correctly.

**Annotation identity** (`AnnotId`): PDFium has no persistent per-annotation id reachable
publicly (`/NM` has only a getter). Uses `format!("p{page}a{index})`" — current page/array index
at `annot_list` time. Valid only within one session between successive `annot_list` calls;
`commands/annotations.rs` bounds-checks and returns `NOT_FOUND` on a stale/out-of-range id rather
than silently touching the wrong annotation, but cannot detect "still in range, but now a
*different* annotation" (would need new session-level state, out of scope for a wave-2 module
per CONTRACTS §6). **I audited the actual R4 UI flows for this** (`AnnotationLayer.tsx`,
`useAnnotations.ts`): every mutation triggers a `doc_state_changed`-driven refetch that the
selected-annotation lookup goes through by string equality, so the realistic failure mode is
"selection silently clears" (safe), not "wrong annotation mutated" — and the only plausible
source of an *externally*-shifted index (a concurrent pages-domain structural op on the same
page while an annotation is selected) isn't reachable today since the pages and annotate tools
aren't wired to be interactively active at the same time in the current chrome architecture.
Accepted as documented, not fixed with new infrastructure.

The exact bbox-transform semantics from `src/tools/annotate/geometry.ts` (`getAnnotBBox`/
`applyBBoxToAnnot` — the R4-wave interpretation of `AnnotPatch.rect` as "new bounding box",
needed for 4 of 7 kinds' move/resize to work at all) are ported faithfully into
`apply_bbox`/`apply_patch`.

## Deliverable 2: Pages engine

All 5 CONTRACTS §3 commands are implemented for real, no compromises:

- **`pages_reorder`**: PDFium has no page-move primitive reachable from any public API (the raw
  `FPDF_MovePages` FFI call exists in `bindings.rs` but is unreachable for the same handle-gating
  reason as everything else). Implemented via a scratch temp document: copy every page into it in
  the target order, delete every live page (descending), copy them all back — O(2N) page copies
  for an N-page reorder. No faster public API exists; a deliberate, documented tradeoff, not an
  oversight.
- **`pages_rotate`**: batch additive rotation over a `Vec<u32>` as one undoable action (reusing
  R2's existing `degrees_to_rotation`/`rotation_to_degrees` helpers), storing each page's previous
  rotation index-for-index (correctly handling a repeated page index within one batch).
- **`pages_delete`**: deletes descending by index; stashes each deleted page as its own
  single-page PDF (bytes) before deleting, so `revert()` reinserts exact copies.
- **`pages_insert_blank`**: arbitrary-index blank insert via `create_page_at_index`.
- **`pages_insert_from_file`**: opens the source file fresh, imports the requested range (or all
  pages) via `copy_page_range_from_document`, then stashes the *inserted* pages as bytes so a
  later redo doesn't depend on the original file path still existing.

**A real bug in my own subagent brief, found and fixed by the subagent, not by me**: I had
suggested `copy_pages_from_document(&source, "0-N")` for the "no range given, import everything"
branch of `pages_insert_from_file`. `FPDF_ImportPages`'s page-range string is documented
1-based ("the first page is one"), so `"0-N"` is actually an invalid/off-by-one range. The
subagent caught this against the vendored source and used the 0-based `RangeInclusive` form of
`copy_page_range_from_document` uniformly for both branches instead — verified correct, not just
plausible-looking.

**Annotation/form survival through structural page ops was verified empirically, not assumed**:
a highlight annotation survives the copy-through-scratch-document reorder round-trip (in-memory
and through save/reload); `fixtures/form.pdf`'s AcroForm fields (by name) survive an
insert-blank + rotate + save/reload round-trip.

## Deliverable 3: Forms engine — the wave's headline finding

**`form_fields()` (reading) is fully correct for all 5 kinds** — text, checkbox, radio (collapsed
into one `FormField` per control group), combo, listbox — verified against all 5 real fields in
`fixtures/form.pdf`.

**`form_set_value()` (writing) only actually works for `checkbox`.** This is worse than the
brief anticipated (which only expected combo/listbox to be blocked) and was found empirically —
same-handle re-reads, fresh-annotation-scan re-reads, `save_to_bytes()` + fresh-PDFium-handle
re-reads, *and* raw byte-level inspection of the saved PDF's object table — not assumed from
reading the crate's method signatures. It is on the same footing as R2's PDFium thread-safety
finding: a hidden defect that only surfaces under real testing.

**Root cause, precisely diagnosed**: `PdfFormCheckboxField::is_checked()`/`set_checked()` both
read/write the widget annotation's own `/AS` key via the *generic*, non-form-fill-engine-aware
`FPDFAnnot_GetStringValue`/`SetStringValue` — symmetric, both scoped to the one widget object.
Every other writable kind instead pairs `FPDFAnnot_GetFormFieldValue` (read — form-fill-engine
aware, correctly resolves the value through the *shared FIELD dictionary*, exactly as it must for
`group_value()`/`field.name()` to work across a `Kids` array at all) with
`SetStringValue_str(annotation_handle, "V", ...)` (write — lands on the target **widget's own**
dictionary instead). For any field with the realistic Field+Widget(s) structure every real
authoring tool (pdf-lib included) produces, a write via that pair is invisible to the read that
everything else — including any other real PDF viewer — actually relies on.

**Proof, concretely** (`identificacao.nome`, a plain text field): after `set_value("Ana Silva")`
returns `Ok(())`, `.value()` returns `None` on the same handle, on a fresh annotation scan, and
after a full save+reopen. The saved bytes *do* contain `/V(Ana Silva)` — on the WIDGET object,
while its `/Parent` (the FIELD object) is untouched.

**Radio groups have two additional, independent defects**, both traced to the exact same
root-cause family:

1. `is_checked()`/`group_value()` (the public read path) is actively wrong for a realistic
   group: in the untouched (nothing-ever-selected) state, every sibling reads as checked
   simultaneously; once a real selection exists, the field's `/V` (export text, via `/Opt`) and
   the selected widget's own `/AS` (a bare positional index) use different naming conventions
   that never textually match, so the comparison the crate's own `is_checked()` performs is
   `false` even for the widget that genuinely is selected. Worked around: a widget is checked iff
   its own `/AS` is present and isn't the spec-reserved literal `"Off"` (ISO 32000-1 §12.7.4.2.3)
   — correct regardless of naming convention, confirmed against both fixture states.
2. There is no public way to recover a radio option's actual export *label* (e.g.
   "Solteiro(a)") — the mechanism exists at the FFI level (`FPDFAnnot_GetOptionCount`/
   `GetOptionLabel`) but pdfium-render 0.9.3 only ever wires it up for ComboBox/ListBox, never
   RadioButton (confirmed in the vendored source, down to a `// TODO` comment the crate author
   themself left admitting the gap). So `fixtures/form.pdf`'s "Estado civil" group surfaces as
   options `["0","1","2","3"]` (raw `index_in_group()`), not the friendly Portuguese labels — a
   real UX/fidelity loss in `src/tools/forms/fields/RadioFieldEditor.tsx`, which renders each
   option string as its own visible label.
3. **Selecting a radio option can't be made to work at all**, for the same Field-vs-Widget
   dictionary mismatch as text fields above — traced and reproduced from both the untouched state
   and a pdf-lib-pre-selected copy attempting to switch options.

**Combo/listbox**: no public setter exists anywhere in the crate for either kind (only flag
setters — sorted/multiselect/spell-check — never a value/selection setter), and the raw
`FORM_SetIndexSelected` FFI call that would do it correctly needs an `FPDF_FORMHANDLE`, which
(like every other raw handle in this crate) is `pub(crate)`-gated with no workaround.

A related, corroborating community report: [ajrcarey/pdfium-render#132](https://github.com/ajrcarey/pdfium-render/issues/132)
("Support for filling form fields programmatically") — still open at the time of this wave.

**Net result**: `form_set_value` returns a real, honest `RubricaError` (code `UNSUPPORTED`, with
a specific evidence-citing message) for `text`/`radio`/`combo`/`listbox` — never a crash, never a
silent no-op success — and actually mutates the document only for `checkbox`, which round-trips
fully (commit → immediate re-read → save → fresh-handle reopen → `scripts/verify-pdf.mjs`, and
undo/redo, all verified).

**Value-string convention**: checkbox values are the plain strings `"On"`/`"Off"` — matching
`src/ipc/mock/state.ts` and `CheckboxFieldEditor.tsx`'s own doc comment ("PDF's own On/Off
export-value convention rather than a boolean"), **not** pdfium-render's internal convention
(`"Yes"/"Off"`) and **not** `PdfForm::field_values()`'s convention either (`"true"/"false"`, a
second, different mismatch that method has against the mock) — translated at the boundary in
both directions.

## Tests

Per the brief's own thread-safety-driven testing constraint (R2's finding: the vendored PDFium
binary reliably segfaults when touched from more than one OS thread, even one call at a time,
even against different documents — `cargo test`'s default one-thread-per-`#[test]` model
triggers this), all three subagents wrote their fixture tests as plain, non-`#[test]` functions
rather than independent `#[test] fn`s. I wired all three into `tests/engine_fixtures.rs`'s
existing single `#[test] fn engine_fixtures()`, alongside R2's own ten sub-tests, so the whole
combined suite — annotations + pages + forms, all touching real PDFium documents — now runs
sequentially on the one thread libtest hands that test, exactly matching the established
pattern:

```rust
rubrica_lib::engine::annotations::fixture_tests::run_annotation_fixture_tests();
rubrica_lib::engine::pages::fixture_tests::run_all();
rubrica_lib::engine::forms::fixture_tests::run_fixture_tests();
```

This passed cleanly, repeatedly, confirming the combined tree (not just each domain in
isolation) is safe under the same thread-affinity constraint R2 found. Each domain's own tests
cover: annotations — round-trip of every achievable kind on `fixtures/text.pdf` plus the
portability gate, the bbox-transform for highlight/ink, undo/redo through add→update→delete, and
delete/update of non-empty Ink/Stamp annotations (the crash-avoidance paths above); pages —
reorder/rotate/delete/insert-blank/insert-from-file each with save+fresh-reopen assertions, the
"delete every page" rejection (including a dedup edge case), undo/redo, and the
annotation/form-survival sanity checks; forms — all 5 real fields of `fixtures/form.pdf` read
correctly, checkbox set+persist+reopen+portability-gate+undo/redo, and confirmed `UNSUPPORTED`/
`INVALID_ARG` responses (not crashes) for the blocked write paths.

## Verified end-to-end, not just assumed

- `cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build`, `cargo
  test` (from `src-tauri/`): all clean on the fully-integrated tree (all three domains merged,
  plus the combined meta-test), including every pre-existing R1/R2 suite unchanged.
- `pnpm bindings:check`: **zero drift** — confirms this wave changed only command/engine
  *implementation bodies*, never a command signature, exactly as scoped.
- `pnpm typecheck`, `pnpm lint` (4 pre-existing warnings, all in frontend files this wave never
  touched), `pnpm test` (19 files / 104 tests, unchanged), `pnpm i18n:check` (9 namespaces,
  pt-PT/en parity intact): all green, confirming the mock→real engine swap is exactly as
  transparent to `src/tools/**` as R4's architecture intended — **zero frontend files were
  edited this wave**.
- I personally audited (not delegated) the AnnotId-staleness risk against the actual
  `AnnotationLayer.tsx`/`useAnnotations.ts` code (see "Deliverable 1" above) rather than taking
  the subagent's documented-limitation framing on faith.
- Not verified: driving the real Tauri/WebView2 app interactively (same limitation R2's report
  already flagged — no GUI-automation tool here can attach to a native Tauri window). Everything
  the automated suite *can* exercise against the real engine (every command, every undo/redo
  path, every save/reopen round-trip) is covered; the R8 manual-Acrobat checklist should
  specifically re-check the Stamp-based ellipse/line/arrow shapes' visual correctness and the
  checkbox-only forms behavior in a real desktop PDF viewer.

## Mock-vs-contract divergences found (fixed on the engine side, matching CONTRACTS' own rule)

- Radio-group value/option tokens: the mock's fake fixture models values as opaque strings the
  UI already treats generically; the real engine's `index_in_group()`-based tokens (`"0"`,
  `"1"`, ...) are a strictly *narrower* fidelity than a hypothetical labeled convention, not an
  incompatible one — the existing `RadioFieldEditor.tsx` renders whatever string it's given as
  the visible label, so nothing crashes, but real users will see index digits instead of "Estado
  civil" option names until pdfium-render exposes radio `/Opt` labels publicly. Flagged rather
  than silently shipped.
- Checkbox value convention: engine settled on `"On"/"Off"` specifically because that's what the
  mock/existing UI component already expects — see "Value-string convention" above.

## Dependencies added

None. `tempfile` (used by the pages/forms fixture-test helpers) was already a regular dependency
from R2's wave.

## Decision: v1 limitation accepted (human orchestrator, 2026-09-03)

Presented with the three forward options below, the human orchestrator chose **option 1**: ship
v1 with only checkbox fields fillable through the real engine; text/radio/combo/listbox fields
stay view-only. Recorded here for the historical record; option 2 (patch/fork `pdfium-render`)
and option 3 (file upstream and wait) remain available if this is ever revisited.

1. **Accept the v1 limitation**: ship with only checkbox fields fillable through the UI; text/
   radio/combo/listbox fields are view-only (their current value/options are shown correctly,
   editing surfaces a clear "not supported" state rather than a crash). Cheapest, but a real
   functionality cut from the documented v1 scope ("fill text/checkbox/radio/dropdown fields").
   **← chosen.**
2. **Patch/fork `pdfium-render`**: the fix is small and mechanical in every case — expose
   `FPDF_FORMHANDLE`/`FPDF_DOCUMENT`/`FPDF_PAGE` publicly (one-line `pub fn` wrappers around
   already-private accessors), and fix `set_value_impl`'s target (write onto the FIELD's own
   dictionary object, not the calling WIDGET's) — but committing to maintain a fork of a
   third-party crate indefinitely is a real, ongoing cost that a single wave shouldn't decide
   unilaterally.
3. **File upstream against pdfium-render** (issue #132 already tracks part of this) and wait —
   slowest, but zero-maintenance if it lands.

### Follow-up UI fix made to actually deliver on the chosen option

"View-only" for the blocked kinds needed one real fix, not just a documentation note: before
this fix, `TextFieldEditor`'s local `draft` state only re-synced from `field.value` on a `useEffect`
keyed to `field.value` itself — since a rejected write never changes `field.value`, that effect
never re-fires, so the input kept showing the user's typed text as if it had saved, forever
(until the component unmounted). This is a real, user-facing silent-data-loss illusion, not a
cosmetic gap, and it would have been hit on every single attempted edit to a text field once the
"only checkbox works" behavior is the accepted, permanent v1 state rather than a one-off finding
in a report. Fixed by threading the `form_set_value` outcome back through
`FieldOverlay`→`FieldEditorProps.error` (new, optional field) to every per-kind editor:
`TextFieldEditor` now snaps its draft back to the real `field.value` as soon as a rejection
arrives, and every editor (`Text`/`Checkbox`/`Radio`/`Choice`) shows a small, clear "Not saved"
badge (`role="alert"`, hover tooltip with the real `RubricaError.message`) via `FieldChrome` (or
`RadioFieldEditor`'s own equivalent layout, which doesn't use `FieldChrome`) — reusing the exact
visual pattern already established for the existing read-only badge. Checkbox/Radio/Choice were
already safe from the silent-desync bug specifically (they're fully controlled by `field.value`
with no local draft state to go stale), but got the same badge for consistency and honesty now
that three of five kinds are permanently non-functional for writes. New i18n keys
(`field.saveFailedBadge`/`field.saveFailedTooltip`) added to both `pt-PT` and `en`; one new
component test (`TextFieldEditor.test.tsx`) covers the revert-on-rejection behavior directly.
Verified via `pnpm typecheck`/`lint`/`test`/`i18n:check` (all green, 105 tests including the new
one) — not verified in a live browser click-through, since the mock engine (the only one
reachable outside a native Tauri window) never actually returns this rejection for these kinds,
so there's no way to trigger the real failure path interactively without either a native Tauri
build or temporarily hacking the mock; the automated component test exercises the exact same
code path a live rejection would.

## What the next wave needs to know

- **R6 (text editing/redaction)**: your two domains (`textedit`, `redact`) are untouched
  `UNSUPPORTED` stubs, same as before this wave — not part of this brief's scope. You'll likely
  hit the exact same "raw handle is `pub(crate)`-gated everywhere" wall if any of your operations
  need something pdfium-render's ergonomic layer doesn't cover; the research in this report (and
  in `engine/annotations.rs`'s/`engine/forms.rs`'s own module doc comments) should save you from
  rediscovering it. `redact_apply` in particular removes underlying objects and rasterizes — the
  `objects_mut()`-only-on-Ink/Stamp constraint likely doesn't affect you (you're removing objects
  from ordinary page content, not annotations), but the "certain setters segfault on non-empty
  containers" class of bug found here is worth testing for empirically rather than assuming away.
- **R7/R8 (release, integration)**: two things need a place on the manual Acrobat/browser
  checklist specifically because of this wave: (1) the Stamp-based ellipse/line/arrow shapes —
  should render visually identical to a native Circle/Line annotation in every conforming
  viewer, but their `/Subtype` reads "Stamp" in a PDF inspector, which could matter if any other
  tool in a user's workflow cares about annotation subtypes specifically; (2) forms — only
  checkbox fields are actually editable through the real engine (accepted as v1's shipped
  behavior — see "Decision" above); confirm the UI's "Not saved" badge for the blocked kinds
  reads clearly and non-alarmingly in a real desktop build, not just in the automated component
  test that covers it today.
- **Whoever picks up the pdfium-render dependency next**: this wave's three module doc comments
  (`engine::annotations`, `engine::pages`'s inline comments, `engine::forms`) are the canonical,
  evidence-backed reference for what 0.9.3's public API can and cannot do — read those before
  re-deriving any of this from scratch, and read them again if/when the crate is ever upgraded
  (a newer version could silently fix or silently change the checkbox-only-works behavior; the
  fixture tests wired into `tests/engine_fixtures.rs` would catch a regression either way).

## Not done / explicitly out of scope for this wave

- `commands/{textedit,redact}.rs` and their `engine/` counterparts: untouched `UNSUPPORTED`
  stubs, exactly as scoped (R6's wave).
- `radio`/`text`/`combo`/`listbox` form-value writing: a verified library limitation, not an
  engineering shortcut — accepted as v1's scope cut, see "Decision" above.
- Radio option friendly labels (`/Opt` text): not recoverable via pdfium-render 0.9.3's public
  API at all; raw index tokens surface instead.
- `freeText` font size/color persistence, `shape:rect` border width/fill opacity: documented,
  narrow fidelity gaps (see "Deliverable 1").
