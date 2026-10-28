# R2 — Engine core, Rust (wave 1)

## Mission

Replace the document/render/text/history stubs with the real engine: DocumentSession, tile
rendering through the custom protocols, text layer and search, the command stack with autosave
journal and atomic save, and the SQLite-backed recents/view-state. When you finish, the UI built
against the mock must work against the real engine with zero UI changes — the contracts are the
spec, the mock is the reference behavior.

## Read first

`docs/ARCHITECTURE.md`, `agents/CONTRACTS.md` (§2–§4, §6, §8–§9 are your spec), R1's report.

## Owns / must not touch

Owns: `src-tauri/**`. Must not touch: `src/**` (except regenerating `bindings.ts`), locales,
tokens. At the end of this wave, `lib.rs`, the specta builder, and the session's public API
freeze — design the session so wave-2 modules (annotations/pages/forms/textedit/redact) can be
implemented purely inside their own module files against it.

## Deliverables

1. **DocumentSession**: open (incl. `ENCRYPTED`/`CORRUPT` detection per CONTRACTS errors),
   close, multiple concurrent documents, revision tracking, dirty state, `doc_state_changed`
   events.
2. **Command stack**: generic `Command { apply, revert }` machinery, `history_*` commands,
   autosave journal (append on commit, delete on clean save, `journal_recover` + the
   `recovery_available` startup event), atomic save + optional `.bak` (pref-driven).
   Wave-2 modules will register their own Command types — make that a trait, not an enum you
   must extend.
3. **Tile pipeline**: `rubrica-tile://` and `rubrica-thumb://` for real — PDFium render into
   512px tiles at the contract's zoom buckets, LRU cache keyed `(doc, page, bucket, x, y,
   revision)`, prefetch ring, cache invalidation from `MutationResult.invalidatedPages`.
   Target: 500-page fixture scrolls smoothly; cold tile < 30 ms typical on dev hardware.
4. **Text layer**: `text_page_layout` (char boxes), `text_extract_range`, streamed search
   (`text_search_start/cancel` + `search_batch` events) via PDFium text APIs.
5. **Print support**: `print_render` (pages at DPI to temp PNGs) for R3's print flow.
6. **Store**: recents with per-doc last page/zoom, prefs — finish R1's skeleton.
7. **Tests**: engine test suite against the full fixtures corpus (including hostile files —
   encrypted and corrupt produce typed errors, never panics); journal crash-replay test
   (simulate kill between commits); atomic-save test (no partial file on injected failure);
   portability gate wired (`scripts/verify-pdf.mjs` on everything saved by tests).

## Dependencies you may add

`image`/`png` crates, `lru`, `sha2`, `tempfile`, `tokio` utilities as needed.

## Subagent plan

- SA-1: session + open/close/save + errors + events.
- SA-2: command stack + journal + recovery + atomic save.
- SA-3: tile pipeline + protocols + cache + perf test.
- SA-4: text layer + search streaming.
- SA-5: store + print_render + fixtures test sweep.
- Keep for yourself: session public API design FIRST (commit as `src-tauri/API.md` early —
  wave 2 reads it), integration, freeze review.

## Definition of done

- The R1 demo route and R3's UI (if merged first, otherwise the mock demo) run unchanged
  against the real engine under `pnpm tauri dev`.
- 500-page fixture: smooth scroll, search streams results, undo/redo across 50 mutations stable.
- Kill-during-edit test recovers via journal replay with zero lost committed commands.
- `src-tauri/API.md` committed; clippy/fmt/test green on CI.
- Write `agents/reports/r2-report.md`.
