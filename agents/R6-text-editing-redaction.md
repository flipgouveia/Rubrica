# R6 — Text & object editing + redaction (wave 2, engine AND UI)

## Mission

The hardest engine work in the project, delivered as a vertical slice: in-place text editing at
the page-object level, text boxes and images, and true redaction — engine and UI both, since the
interaction and the engine capability are inseparable here. The honest scope is contractual: NO
paragraph reflow; font reuse with visibly flagged substitution.

## Read first

`agents/CONTRACTS.md` (§3 textedit/redact, §5–§7, §9), `src-tauri/API.md`, `src/chrome/TOOL-API.md`,
R2's report, `docs/ARCHITECTURE.md` (whiteout-vs-redaction distinction — it is a feature, not
a nuance).

## Owns / must not touch

Owns: `src-tauri/src/{commands,engine}/{textedit,redact}.rs`, `src/tools/{text-edit,redact}`,
`src/ipc/mock/{textedit,redact}.ts`, locales `tools-textedit`/`tools-redact`. Must not touch:
session core, other agents' engine modules, `src/viewer`/`src/chrome`/`src/screens`,
`src/tools/{annotate,pages,forms}`.

## Deliverables

1. **Text objects engine**: `text_objects` (runs with rects, font name/size, embedded-font
   usability), `textobj_set_text` — reuse the embedded font when it covers the new glyphs
   (mind PT accents: the unicode fixture is your friend); otherwise substitute a standard font
   and return `fontSubstituted: true`; `textobj_add` (new text run, standard font),
   `imageobj_add`, `object_delete`. All as Commands.
2. **Redaction engine**: `redact_apply` — remove intersecting text/image objects and rasterize
   the region (render the area to an image at page resolution, insert as image object, remove
   originals) so content is *gone*, not covered. Prove it: the byte-search test (saved file
   contains no trace of redacted text) is the acceptance test.
3. **Text-edit tool UI**: click a run to edit in place (overlay editor aligned to the run's
   rect), visible substitution flag when `fontSubstituted`, add-text-box tool, add-image tool,
   object selection/delete. Set expectations in the UI copy: block-level editing, no reflow.
4. **Redact tool UI**: mark rects (drag + from text selection), review list of pending marks,
   explicit two-step apply with an unmissable explanation of redact-vs-whiteout (whiteout lives
   in the annotate tool as an opaque shape — link to it), irreversibility warning (redaction is
   still undoable in-session via the command stack, but gone once saved — say exactly that).
5. **Mock modules** for both domains so the UI is testable in-browser.
6. **Tests**: glyph-coverage/substitution matrix (incl. accented PT text), byte-search redaction
   proof, mixed undo/redo with other domains' commands, portability gate on all outputs.

## Dependencies you may add

Font/glyph inspection helpers if pdfium-render's surface needs supplementing (e.g. `ttf-parser`,
dev-side). Report anything else.

## Subagent plan

- SA-1: text objects engine + substitution logic + tests.
- SA-2: redaction engine + byte-search proof.
- SA-3: text-edit tool UI + mock.
- SA-4: redact tool UI + mock + i18n (the redact explanations deserve careful pt-PT copy).
- Keep for yourself: the edit-in-place interaction design, integration, review.

## Definition of done

- Fix a typo in a real-world fixture (embedded font) with no substitution flag; edit accented
  PT text; add a text box and an image — save, reopen in fresh PDFium + verify-pdf, all intact.
- Redact a term across pages; byte-search proves zero trace in the saved file; visual result
  correct at every zoom bucket.
- Whiteout-vs-redact distinction reads clearly in the UI in both languages.
- Write `agents/reports/r6-report.md`.
