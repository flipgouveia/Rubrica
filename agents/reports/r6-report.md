# R6 — Text & object editing + redaction: report (wave 2)

Status: **done**. Real PDFium-backed engine for both domains (no more `UNSUPPORTED` stubs),
text-edit and redact tool UIs wired into the real chrome via `registerTool`, mocks unchanged
(R1's wave-0 mock already covered both domains correctly), i18n filled in pt-PT + en. `cargo
test`/`clippy -D warnings`/`fmt --check` and `pnpm typecheck`/`lint`/`test`/`i18n:check`/`build`
are all green on the final tree; manually verified both tools together in a real browser against
the mock engine (not just automated tests).

## How this wave was executed

The Rust engine (the "hardest work" the brief calls out) was written directly, not delegated —
it required reading the vendored `pdfium-render` 0.9.3 source to resolve several undocumented
behaviors (see "Two real crashes" below) that no amount of black-box experimentation would have
surfaced safely. Once the engine and its test suite were solid, the two tool UIs were built by
parallel subagents against the already-complete engine/mock, then integrated and cross-tested by
hand. That integration pass caught one real bug neither agent could have found alone (see
"A cross-tool bug found during integration").

## Deliverables (brief items 1–6)

1. **Text objects engine** (`engine/textedit.rs`) — `text_objects` lists text runs (id scheme:
   `"<page>:<index>"`, an internal detail, never exposed structurally); `textobj_set_text`
   decides reuse-vs-substitution *behaviorally* (set the text, regenerate content, read it back
   through PDFium's own text layer, compare) rather than by inspecting glyph tables, which works
   identically for a truly embedded/subsetted font and for a standard base-14 font; `textobj_add`
   (standard Helvetica), `imageobj_add` (PNG or JPEG via `image::open`), `object_delete` — all
   real `Command` impls with full undo/redo, including exact-font-preserving restore of a deleted
   or substituted run via a captured `PdfFontToken`.
2. **Redaction engine** (`engine/redact.rs`) — `redact_apply` removes every text/image object
   overlapping any marked rect (whole objects, not partial glyph runs — documented tradeoff),
   then renders the page *after* removal and inserts the cropped result as a flat image over each
   rect. Byte-search proof: `tests/engine_fixtures.rs`'s
   `redact_apply_leaves_no_trace_of_the_marked_text` decompresses the saved file's Flate streams
   (PDFium's regenerated content streams are compressed, and text-showing operands come out as
   hex strings, not literal parenthesized text — both confirmed empirically, see that test's own
   comments) and proves the redacted term is byte-absent while an untouched word on the same page
   is still found by the identical search — the second half exists so the first isn't vacuously
   true.
3. **Text-edit tool UI** (`src/tools/text-edit/`) — click a run to select, click again to edit
   in place via an inline `<input>` positioned exactly over the run's rect; a substitution badge
   (tracked client-side, since `fontSubstituted` is only ever returned once, at edit time — the
   engine doesn't remember it); add-text-box and add-image modes; select/delete for text runs.
   Registered as `text-edit` (`mod+e`), toolbar order 40.
4. **Redact tool UI** (`src/tools/redact/`) — drag-to-mark a rect, or convert the current text
   selection into marks (per page, since a selection can span pages); a review panel listing
   pending marks with per-mark removal; a two-step confirm dialog spelling out (in careful pt-PT
   and en) what redaction does, how it differs from whiteout, the whole-object-removal caveat,
   and the exact irreversibility framing the brief asked for ("undoable now, permanent once
   saved"). Multi-page apply loops `redact_apply` once per page (CONTRACTS' own per-call
   constraint). Registered as `redact` (`mod+shift+r`, `mod+shift+m` to mark selection), toolbar
   order 50, `overlayAlwaysOn` so pending marks survive switching tools.
5. **Mock modules** — `src/ipc/mock/{textedit,redact}.ts` needed **no changes**: R1's wave-0
   mock already implemented both domains correctly (including deriving `fontSubstituted` from
   `embeddedFontUsable`, and redaction dropping fully-contained runs/annotations), so both tool
   UIs were built and tested against it as-is.
6. **Tests** — Rust: `tests/engine_fixtures.rs` gained 7 new sub-tests (typo fix / no
   substitution, PT-accented edit / no substitution, rejecting genuinely unencodable text safely,
   add text box + image with a fresh-PDFium reopen, object-delete undo, the redaction byte-search
   proof, and mixed undo/redo interleaving `SetTextCommand`/`AddTextObjectCommand` with R2's
   generic `RotatePageCommand`/`InsertBlankPageCommand`), plus 2 pure unit tests
   (`engine::textedit::tests`) covering the WinAnsi-repertoire check and the substitute-font
   choice matrix. Frontend: 12 unit tests (`text-edit/geometry.test.ts`) + 2 mock-IPC integration
   tests for text-edit; `redact/{geometry,grouping,selectionToMarks}.test.ts` (pure) + 1 mock-IPC
   integration test for redact. Portability gate (fresh PDFium reopen + `verify-pdf.mjs`) is
   asserted on every Rust test that saves a file.

## Two real crashes found in the vendored PDFium build (chromium/8035, via `pdfium-render` 0.9.3)

Both are documented at length in `engine/textedit.rs`'s module doc comment and the
`remove_object_at_index_leaking` doc comment; summarized here because they're the kind of finding
a future wave (or a future PDFium upgrade) needs to know to re-check.

1. **Encoding a codepoint outside a simple font's reach crashes the process outright, not
   gracefully.** Every standard PDF font (and the large majority of embedded ones) is a
   256-code-point "simple" font. Asking `FPDFText_SetText_str` to encode a character no simple
   font's encoding can reach at all (tested: a CJK string against standard WinAnsi-encoded
   Helvetica) doesn't fail gracefully — it crashes the whole process
   (`STATUS_ILLEGAL_INSTRUCTION`, no Rust panic, `catch_unwind` can't intercept it, because
   nothing unwinds). **Fix**: `ensure_winansi_encodable` rejects such text with a normal
   `INVALID_ARG` error *before* any PDFium call, in both `textobj_set_text` and `textobj_add`. A
   substitute standard font couldn't have helped anyway (none of the 14 base fonts support
   anything beyond a WinAnsi-family single-byte encoding), so this is a real, permanent scope
   boundary for text editing in this version — Rubrica has no CJK story anywhere else either.
2. **Destroying certain detached page objects crashes the process, sometimes with no reuse of
   their data at all.** `pdfium-render`'s `remove_object`/`remove_object_at_index` hand back the
   now-detached object, whose `Drop` impl calls `FPDFPageObj_Destroy` (confirmed by reading the
   vendored source). Discarding that return value — the obvious way to write a plain removal —
   destroys the object immediately, and on this build that has been observed to crash in two
   distinct scenarios: (a) when a `PdfFontToken` captured from that object is reused afterward
   (`restore_removed` rebuilding a redacted/deleted run with its original font), and (b)
   *independently*, when undoing a plain `textobj_add` that used a document-level standard-font
   token, with no token reuse downstream at all. **Fix**: `remove_object_at_index_leaking`
   (`engine/textedit.rs`) leaks the detached wrapper via `std::mem::forget` instead of letting it
   drop — used for *every* object removal in `textedit.rs`/`redact.rs`, not just the ones that
   need token reuse, since (b) showed the crash isn't specific to that path. The small native
   leak per removal is reclaimed the moment the document closes.

Both were caught by the test suite crashing the whole `engine_fixtures` binary
(`STATUS_ILLEGAL_INSTRUCTION`), not by an assertion failure — bisected by temporarily splitting
the single meta-test into marker-separated sub-calls (see git history of
`tests/engine_fixtures.rs` during this wave if the exact bisection technique is ever needed
again) and inspecting object counts/indices at each step, the same empirical approach R2's own
report used for its thread-affinity finding.

## A cross-tool bug found during integration (not caught by either subagent alone)

`RedactOverlay`'s `overlayAlwaysOn: true` (so pending marks stay visible while another tool is
briefly active) means it renders on **every** page regardless of which tool is actually active,
stacked in DOM order above whatever the active tool's own overlay rendered. The subagent building
it correctly set `pointerEvents: isActive ? "auto" : "none"` on its `<svg>` — but not on the
plain `<div>` wrapping that `<svg>`, which (having no pointer-events style of its own) stayed a
valid hit-test target regardless. Net effect: with both tools registered together, every click
meant for the *active* tool (confirmed with text-edit: clicking a run to select it) silently hit
this wrapper `<div>` instead and did nothing — reproduced live in a real browser, not just in
jsdom (the two tools' own Vitest integration tests each passed in isolation, since neither test
ever registered the *other* tool). Fixed by adding the same conditional `pointerEvents` to the
wrapper `<div>` (`src/tools/redact/RedactOverlay.tsx`); re-verified both tools' full flows in the
browser afterward, and re-ran the whole frontend suite (142 tests, still green). Worth flagging
for whoever wires `annotate` into the real chrome next — its brief also plans `overlayAlwaysOn`,
and TOOL-API.md doesn't currently call out this wrapper-vs-child pointer-events pitfall
explicitly.

## CONTRACTS gaps found (documented, not silently worked around)

- **No way to discover an image object's id after `imageobj_add`.** `MutationResult` has no id
  field (the same gap R4 flagged for `annot_add`), and — unlike text runs — there is no
  `image_objects` getter to diff against (`text_objects` only ever returns `Text`-type runs).
  Practical resolution: the engine's `object_delete`/`DeleteObjectCommand` *can* delete an image
  given its `"page:index"` id (it supports both object types symmetrically), but the UI has no
  contract-legal way to obtain that id for anything other than the object it just this instant
  created and forgot again. The text-edit tool therefore does not offer image select/delete at
  all — a freshly placed image can only be removed via the app's own undo, which the panel says
  plainly. Worth a future CONTRACTS bump (either `imageobj_add` returning the new id, or an
  `image_objects` getter mirroring `text_objects`).
- **`redact_apply` is strictly one page per call.** Not really a gap (CONTRACTS is explicit about
  this), but worth restating for whoever next touches the redact UI: a multi-page redaction is
  necessarily multiple undo-stack entries, one per page, not one atomic operation.

## Dependencies added

- `flate2 = "1"` (Rust, dev-dependency only) — decompresses saved PDFs' Flate streams for the
  redaction byte-search test; already resolved transitively in `Cargo.lock`, this just makes it
  direct. No production dependency.
- `image`'s `jpeg` feature enabled (previously PNG-only) — `imageobj_add` needed to accept JPEGs,
  not just PNGs, for a real "add an image" feature; a one-line `Cargo.toml` feature addition, no
  new crate.
- No new pnpm dependencies. The "add image" UI follows the same established, already-accepted
  pattern as `src/chrome/SaveAsDialog.tsx` (a typed path input, since no native file-dialog
  plugin is registered on the Rust side yet — flagged by R3 for a later wave, not re-litigated
  here).
- `ttf-parser` (suggested in the brief) was **not** needed — the reuse-vs-substitution decision
  is made behaviorally (see above), not by parsing font programs.

## Verification

- **Rust**: `cargo test` (full suite, including 7 new engine_fixtures sub-tests + 2 pure unit
  tests), `cargo clippy --all-targets -- -D warnings`, `cargo fmt -- --check` — all clean. The
  full `engine_fixtures` binary was re-run repeatedly (5+ times total across the crash
  investigations) with zero flakiness once both crash fixes landed, matching R2's own established
  "one thread, sequential sub-tests" discipline (no changes needed there, just added to the same
  single `#[test]`).
- **Frontend**: `pnpm typecheck`, `pnpm lint` (0 errors; the 4 warnings present are pre-existing,
  in files this wave never touched), `pnpm test` (25 files / 142 tests, all green), `pnpm
  i18n:check` (9 namespaces, pt-PT/en parity), `pnpm build` — all clean on the final tree
  (including after the `RedactOverlay` fix).
- **Manual, in a real browser, against the mock engine** (not just automated tests): opened
  `demo-text.pdf`, activated text-edit — selected a run, edited it via the inline editor, confirmed
  the committed text; activated redact — dragged a mark, opened the confirm dialog and read the
  actual rendered pt-PT copy, applied it, confirmed the pending-marks list cleared and undo
  worked. This pass is what surfaced the cross-tool pointer-events bug above; re-verified clean
  afterward.
- **Portability**: every Rust test that saves a file asserts a fresh-PDFium reopen plus
  `scripts/verify-pdf.mjs` (pdf-lib parse) via the shared `assert_portable` helper, including the
  new add-text-box-and-image and redaction tests.

## What the next wave needs to know

- `engine::textedit`'s module doc comment is the canonical writeup of the object-id scheme, the
  `set_text`-doesn't-auto-regenerate-content gap in `pdfium-render` 0.9.3, and both crashes above
  — read it before adding any new page-object mutation anywhere in the app, including in a future
  R5 (annotations/pages/forms engine, not yet started as of this wave) if it ever needs to remove
  a page *content* object (annotations are dictionary entries, not content-stream objects, so R5
  is likely unaffected, but the `remove_object_at_index_leaking` pattern is there to reuse if it
  ever is).
- `remove_object_at_index_leaking` is the **only** sanctioned way to remove a page object anywhere
  in `engine::textedit`/`engine::redact` — never call `PdfPageObjectsCommon::remove_object`/
  `remove_object_at_index` directly and discard the `Ok` value, per the crash above.
- Whoever wires `annotate` (or any future `overlayAlwaysOn` tool) into the real chrome: check its
  wrapper elements' `pointer-events` when inactive, not just its innermost interactive children —
  see "A cross-tool bug found during integration" above.
- The image-object-id CONTRACTS gap (above) blocks a real "select/delete a placed image" feature
  cleanly — worth a CONTRACTS amendment before any future wave tries to build that properly.
