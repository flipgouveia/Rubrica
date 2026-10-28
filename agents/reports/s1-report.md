# S1 report — search engine (Rust)

Branch: `worktree-agent-ac47a4e7e37d01f06` (based on `d7cb658`, contract v1.1.0).
Files touched: `src-tauri/src/engine/text.rs`, `src-tauri/src/commands/text.rs`,
`src-tauri/tests/search_engine.rs` (new), `src-tauri/API.md` ("Text layer & search" only), this report.
No change to `types.rs`, `lib.rs`, `bindings.ts`, `src/`, locales or `CONTRACTS.md`.

## Status

| Bug | Status | Failing-test-first evidence (run on the pre-fix behaviour) |
|---|---|---|
| **B2** wrong count | **Fixed** | `b2_wrapped_occurrence_is_one_hit_with_one_rect_per_line`: `"lazy dog"` (occurs twice, once wrapped) gave 3 hits, expected 2. `b2_multiword_queries_on_text_pdf_group_per_occurrence` (`"of the"`/`"in the"` on `text.pdf`): 10 hits vs 9 independent occurrences. `b2_hit_count_matches_an_independent_substring_count_on_text_pdf`: `char_start/char_len/context` were all 0/empty (`extract_range` returned `""`, expected `"the"`). `b2_char_indices_are_char_not_byte_offsets_on_unicode_pdf`: range extracted `""`, expected `"ção"`. `b2_context_is_bounded_and_whitespace_collapsed`: `before` was `""`. |
| **B10** progress | **Not reproduced** | `b10_progress_every_25_pages_without_matches` (500-page.pdf, no-hit query: exactly batches at 25, 50 … 500 then `done`) and `b10_pages_searched_is_monotonic_and_done_equals_page_count` (hit-heavy query: monotonic, no gap > 25 pages, exactly one `done`, `done.pagesSearched == pageCount == 500`) both **pass on the F1.0 code**; F1.0 already emitted progress every 25 pages. Kept as regression tests. Note: `pagesSearched` is non-decreasing, not strictly increasing (the last page can emit a hit/progress batch and then `done`, both at `pageCount`). |
| **B11** geometry | **Not reproduced (no defect); tests added** | `b11_geometry_agrees_with_page_layout_on_every_page_kind` over synthesized plain, `/Rotate 90` and `CropBox [60 600 360 760] ≠ MediaBox` pages, plus `…_on_text_pdf`: each hit's rects equal the union of the `text_page_layout` char boxes for `[char_start, +char_len)` line by line (tol 0.01 pt), and the same content yields the **same** rect on all three page kinds (both APIs are in unrotated PDF user space, independent of `/Rotate` and CropBox). Before the B2 fix these tests failed only because `char_len` was 0 (no range to compare), not because of geometry. |
| **textless** | **Fixed** | Pre-fix `done` batch hard-coded `textless: false`; `textless_is_true_only_when_no_page_has_text` failed with "scanned.pdf has no extractable text". Now true for `scanned.pdf`, false for `text.pdf`, `unicode.pdf`, `500-page.pdf` (even with zero hits, so it comes from page text, not from hits); progress batches never claim it. |
| **Cancellation** | **Not reproduced (works); tests added** | `cancel_before_start_emits_nothing`, `cancel_mid_search_stops_batches_and_never_sends_done` (cancel via `SearchRegistry::cancel` from inside the 3rd batch → exactly 3 batches, no `done`), unknown-id cancel is a no-op, ids reusable after `finish`/`cancel`, closed document ends silently. Hardening: the loop now also re-checks the flag *after* each page's PDFium hop so a cancel landing mid-hop cannot leak that page's batch. |
| **Duplicate searchId** | **Works; tested** | `duplicate_search_id_is_invalid_arg` via the new `engine::text::register_search` (what `text_search_start` now calls). |

## What changed

- `engine::text::run_search_pages(search_id, page_count, &cancelled, search_one, emit)`: the page loop,
  free of Tauri. `commands/text.rs::run_search` supplies a `with_session` hop per page and
  `batch.emit(&app)`; tests supply the same hop and a `Vec` sink. All PDFium access is still one
  `SessionStore::with_session` per page; the test thread never touches PDFium.
- `engine::text::search_page_hits` → `PageSearch { hits, has_text }`: one `SearchHit` per item of
  `PdfPageTextSearch::iter` (that item's segments = the hit's rects). Pure-Rust `build_hits` derives
  range and context from data already extracted on the PDFium thread.
- `engine::text::register_search` (dup → `INVALID_ARG`), `PROGRESS_EVERY_PAGES`.
- `search_page` (flat rects) is kept unchanged: `tests/engine_fixtures.rs` (not mine) calls it.

## Contract findings / limits (nothing blocking)

1. **`char_start`/`char_len` are derived, not read from PDFium.** `pdfium-render` 0.9.3 keeps
   `FPDFText_GetSchResultIndex`/`GetSchCount` unreachable: `PdfPageTextSearch::search_handle`,
   `PdfPageText::text_page_handle` and `PdfDocument::handle` are `pub(crate)`, and
   `PdfPageTextSegments` hides its start/count. The range is recovered from geometry (a char is in
   the match iff its `GetCharBox` box lies inside one of the hit's `GetRect` rects), verified to spell
   the query, re-anchored if a neighbour leaked in, edge whitespace trimmed. Verification:
   `char_start_matches_pdfiums_own_result_index` bisects PDFium's own behaviour with
   `search_from(query, opts, c)` (largest start index that still yields this occurrence first) and
   compares every hit of `lazy dog`, `ção`, `de a` and `the`/`of the`/`a`/`in a` on pages 0–2 of
   `text.pdf` (>50 hits): all equal. Residual risk: a pathological layout where another glyph's box
   is fully inside a hit's rect *and* the stray char happens to still spell the query; considered
   not worth more machinery.
2. `charLen` of a wrapped hit includes the generated `\r\n` chars between the segments (e.g.
   `lazy dog` over a line break → `charLen 9`, `matched` is still `"lazy dog"`). Consumers that
   want the matched length should use `context.matched`, not `charLen`.
3. `context.before` keeps its trailing space and `context.after` its leading space (outer ends are
   trimmed), so `before + matched + after` reads as a stretch of the page text. UI: render as-is,
   do not add extra spaces.
4. **`/Rotate 90` reading order**: PDFium extracts a rotated page in rotated reading order (the
   second content-stream line comes first), so a phrase that wraps in the stream is not adjacent
   in the text layer there and is (correctly, per PDFium) not found; `eta alpha` is found instead.
   This is PDFium behaviour, not a regression, but worth knowing for rotated scans with OCR text.
5. `pagesSearched` on the last page can appear twice (hit/progress batch, then `done`); UI must
   not assume strictly increasing values (contract text says monotonic: consistent).

## New bugs found

None in the shipped behaviour beyond the above. (Test-infrastructure note: `cargo test` regenerates
`src/ipc/bindings.ts` as a side effect via `export_bindings`; it showed only a CRLF warning, no diff.)

## Commits

- `cb43827` test(search): add search-engine integration tests and a Tauri-free page loop
  (behaviour-preserving refactor; tests fail on it as per the table)
- `028496f` fix(search): one hit per occurrence with char range and context; textless
- docs/report commit (API.md section + this file)

## Commands run

```
cargo test  --manifest-path src-tauri/Cargo.toml --test search_engine   # before fix: FAILED (B2, textless, B11 sub-tests); after: ok (x5 runs, ~1.2 s)
cargo fmt   --manifest-path src-tauri/Cargo.toml -- --check             # exit 0
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings   # exit 0
cargo test  --manifest-path src-tauri/Cargo.toml                        # all green: lib 20 passed (6 new engine::text unit tests), engine_fixtures, export_bindings, pdfium_smoke, search_engine
pnpm install --frozen-lockfile                                          # ok
pnpm bindings:check                                                     # "matches the Rust source of truth. No drift."
```
(`CARGO_TARGET_DIR` pointed at the main checkout's `src-tauri/target` to avoid a cold build.)

## Test design notes

`tests/search_engine.rs` is a single `#[test]` calling sub-tests in sequence (same single-thread
rationale as `engine_fixtures.rs`), each wrapped in `catch_unwind` so one run reports every failing
sub-test. The wrapped / `/Rotate 90` / CropBox fixtures are tiny hand-written PDFs built in the test
(Helvetica, explicit line break inside "lazy dog"), so no new binary fixtures were added and
`fixtures/` is untouched.
