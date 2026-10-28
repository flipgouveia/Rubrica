# R5 — Engine editing modules: annotations, pages, forms (wave 2)

## Mission

Replace the annotations/pages/forms stubs with real PDFium implementations and weld R4's UI to
them. Everything you write must pass the portability gate — these are the features where "looks
right in Rubrica, broken in Acrobat" is easiest to ship by accident.

## Read first

`agents/CONTRACTS.md` (§3 your three domains, §6, §9), `src-tauri/API.md` (R2's frozen session
API), R2's and R4's reports, `docs/ARCHITECTURE.md` (editing model, portability principle).

## Owns / must not touch

Owns: `src-tauri/src/{commands,engine}/{annotations,pages,forms}.rs`, plus integration edits
inside `src/tools/{annotate,pages,forms}` (R4 is finished; keep edits to wiring/behavior fixes,
not redesigns). Must not touch: session core (`lib.rs`, specta builder, session public API —
needs go in your report), `src/viewer`, `src/chrome`, R6's and R7's paths.

## Deliverables

1. **Annotations engine**: all §3 annotation kinds as **standard PDF annotation objects** via
   PDFium's annot API — correct subtypes, quadpoints, ink lists, appearance streams where PDFium
   needs them to render elsewhere, colors/opacity. Every operation is a Command (undo/redo +
   journal for free, per R2's trait).
2. **Pages engine**: reorder/rotate/delete/insert-blank/insert-from-file via PDFium page APIs
   (import via `FPDF_ImportPages`-equivalent in pdfium-render); correct `invalidatedPages`
   semantics (a reorder invalidates everything after the pivot; document revision bumps).
3. **Forms engine**: PDFium form-fill environment per document session; enumerate fields with
   kinds/options/flags; set values for text/checkbox/radio/combo/listbox; values persist in the
   AcroForm on save (no flattening); form mutations ride the command stack like everything else.
4. **Wiring**: R4's three tools run against the real engine under `pnpm tauri dev`; divergences
   between mock behavior and real behavior get fixed on whichever side the contract says is
   wrong (contract wins; report anything ambiguous).
5. **Tests**: per-domain engine tests on fixtures; round-trip tests — annotate/reorder/fill,
   save, reopen fresh, assert everything is there; the portability gate on every saved output;
   the government-form fixture filled end-to-end and byte-verified to keep its AcroForm.

## Dependencies you may add

None expected beyond pdfium-render's existing surface. Report anything else.

## Subagent plan

- SA-1: annotations engine + round-trip tests.
- SA-2: pages engine + invalidation semantics + tests.
- SA-3: forms engine + AcroForm persistence tests.
- SA-4: UI wiring + mock-vs-real divergence sweep (drive every R4 flow against the real engine).
- Keep for yourself: appearance-stream correctness review (the classic "renders in Rubrica,
  invisible in Acrobat" trap), integration, full-suite runs.

## Definition of done

- Every R4 flow works against the real engine; annotate a contract fixture, reorder and delete
  pages, fill the government form, save — reopen in a fresh PDFium instance AND verify with
  `scripts/verify-pdf.mjs`: all content present, AcroForm intact.
- Undo/redo across mixed operations (annot + page op + form fill interleaved) is stable and
  journal-recoverable.
- Write `agents/reports/r5-report.md` (call out any appearance-stream compromises explicitly —
  R8's manual Acrobat checklist needs to know where to look).
