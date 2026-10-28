# S8 report: search v2 pipeline tests and phase-1 cleanup (Rust)

Branch: `worktree-agent-a557fffded53f499a` (reset to `search/phase-2` at `b625894`, i.e. including the
orchestrator's "one PDFium hop for cached indexes" change to `pipeline.rs`). Not pushed.
`engine/search/pipeline.rs` is untouched; no pipeline bug was found.

## 1. Tests added: `src-tauri/tests/search_v2_pipeline.rs`

One `#[test]` running ten sub-tests sequentially on one `SessionStore` (each runs even if an earlier
one fails). Ground truth is read from `fixtures/book.expected.json` (including the expected outline
id per page, computed from its outline tree); only 125 / 386 / "2.1" are pinned from the brief. Every
run goes through `check_batch_rules`, which asserts: exactly one `done`, last; `pagesSearched`
monotonic and `== pageCount` on done; `pageCount` constant; `ranked == (done && proximity)`; pages
ascending across ALL batches (so no page appears in two batches); hits within a page sorted by
`charStart`; a non-done batch never contains a page that has not been followed by the next matched
page (`page + 2 <= scopeStart + pagesSearched`).

| sub-test | proves |
|---|---|
| `phrase_contrato_whole_word_on_book` | total = 189 body + 10 titles/headers + 1 hyphen-split; per-start-page counts equal the expected map; `outlineItemId` equals the deepest entry for every hit (page 16 -> "2.1", page 15 -> "2.0"); title page has none; `contra-/to` is one hit with 2 rects; no furniture without exclusion |
| `phrase_options_widen_and_narrow_results` | non-whole-word finds more than whole word; case-sensitive finds fewer |
| `proximity_windows_scopes_and_ranking` | window 100: nothing (done still `ranked`); 250: only the tight trio, score 125, page 16, outline "2.1", 2 window rects, terms 0/1/2 highlighted; 500: also the loose trio (score 386, page 29, outline "3.1"); `ranked` only on done; scope `Outline{"2"}` -> pages 15..=22, `pageCount` 8, tight trio only; nested `"2.1"` -> 16..=19; `Pages` scopes (tight only, loose only, both, empty ranges) with `pageCount = to-from+1`; the decoys never join at window 5000 |
| `prepare_rejects_bad_arguments` | `INVALID_ARG` for empty/blank text, proximity with only an excluded term / no options / window 0, 19, 5001, u32::MAX (20 and 5000 accepted), pages 5-4 / 0-40 / 40-40 / 100-200 (39-39 accepted), unknown outline ids, outline scope on `book-no-outline.pdf`; that document still searches (hits carry no outline id); unknown doc -> `NOT_FOUND` |
| `exclude_headers_footers_and_furniture` | "Página": >= 39 hits without exclusion, 0 with it; furniture reported exactly once for pages 1..=39 (none for page 0), each page inside the batch whose `pagesSearched` covers it, header + footer rect per page; scoped run reports only its pages; whole-word "contrato" loses exactly the 8 header hits; "fazer cessar o acordo" is 0 hits without exclusion and 1 hit with it, `spansPages == (21,22)`, rects on both pages, outline id of the start page, one batch; furniture empty without exclusion |
| `ignore_diacritics_finds_the_acao_pages` | whole-word "acao" = `acaoPages` exactly (matched text "ação"); with accents significant: none, while "ação" still finds the same pages |
| `progress_every_25_pages_on_500_pages` | no-hit query: progress batches exactly at 25, 50, ..., 500, then `done` with 500 == 500; gaps <= 25 also when hits interleave ("Page 4"); non-done batches never claim `textless` |
| `textless_documents` | scanned.pdf -> `textless` true (with and without header exclusion); text/unicode/book with zero hits -> false |
| `cancellation` | cancelled up front -> no batch, `false`; flag set from the emit callback at batch 1 and 3 -> exactly that many batches, no done, `false`; cancel during pure-progress run stops at page 100; cancel before the furniture pass -> silent; document closed after `prepare` -> silent `false`; `prepare` on a closed doc -> `NOT_FOUND` |
| `cache_reuse_and_invalidation` | cold cache = 0 bytes; after a search `heap_bytes > 0`, all pages and furniture cached; second identical search byte-identical (serialized batches) and adds no bytes; a second document gives identical output; `redact_apply` of the trio window rects via `commit`: only page 16's index dropped, furniture dropped, next search no longer finds the trio (stale index not reused) nor the plain term on that page; undo brings the zone back; `InsertBlankPageCommand` clears the whole cache and the next run searches 41 pages. (Removing a document from the store cannot be observed for the cache without poking internals, skipped.) |

## 2. `search_engine.rs` ported to the pipeline

All phase-1 guarantees were kept (and all passed on the first run): wrapped match = ONE hit with one
rect per line, and context (`before`/`after`/`matched`) identical to the phase-1 expectations;
hit counts equal an independent substring count on text.pdf (also multi-word, unicode.pdf);
`[charStart, +charLen)` extracts the match; context bounds/whitespace; B10 progress and monotonicity;
`textless`; B11 geometry on plain, `/Rotate 90` and CropBox pages (each rect equals the union of the
`page_layout` boxes of the hit's range; same user-space rect on every page kind); the PDFium
`FindStart` cross-check of `charStart` (>50 hits) still holds against the v2 engine; cancel
(up front, mid-search), registry (`register_search` duplicate -> `INVALID_ARG`, reuse after
finish/cancel); closed document ends silently (now `prepare` then close then `run`).
One deliberate change: the geometry tolerance went from 0.01 to 0.05 pt, because the v2 index
quantizes box edges outwards (up to ~0.012 pt, S3 report). Queries use `ignoreDiacritics: false` to
match the accent-sensitive PDFium search these tests were written against.

## 3. Removed

From `engine/text.rs` (708 -> 147 lines): `SearchOptions`, `search_page`, `search_page_hits`,
`PageSearch`, `build_hits`, `reanchor`, `normalize`, `normalize_keep_edges`, `range_text`,
`box_inside`, `CONTEXT_CHARS`, `BOX_EPS`, `run_search_pages`, `PROGRESS_EVERY_PAGES` and all their
unit tests. Kept: `page_layout`, `extract_range`, `page_count`, `get_page`, `SearchRegistry`,
`register_search`; module doc rewritten.
`engine_fixtures.rs`: the redaction check now finds "booklet" with a small `find_rects` helper on
the v2 engine (`extract_page` -> `PageIndex` -> `Matcher`), then proves the same things.
`search_perf.rs`: `phase1`/`phase1_baseline` deleted (recorded baseline kept in the header
comment); it still compiles (`v2_pipeline` is its only test, ignored).
`src-tauri/API.md`: "Text layer & search" rewritten (pipeline, threading, cache + invalidation,
batching/cancel rules, normalization incl. U+0002, proximity window definition, furniture rule,
outline/scope, coordinates, performance table from the S3 report).

## 4. Pipeline bugs

None found. Everything in the brief held: one batch per page, progress every 25 scope pages, `ranked`
only on proximity done, `pageCount` = scope pages, cancellation, cache invalidation.
Observations (not bugs): page 15's deepest outline id is "2.0" (3.1 Por acordo), the brief's "2" is
the chapter; the tight trio window spans 2 lines (rescisão on line 1, prazo and indemnização on
line 2); `fixtures/README.md` says the loose trio is on page 30 (1-based), the JSON has 0-based 29.
`tests/search_v2_matcher.rs` (not mine) still has a doc comment mentioning
`search_perf.rs::phase1_baseline`, which no longer exists.

## 5. Verification

* `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: exit 0.
* `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: exit 0.
* `cargo test --manifest-path src-tauri/Cargo.toml`: all green (lib 152; `book_fixture`,
  `engine_fixtures`, `export_bindings`, `outline`, `pdfium_smoke`, `search_engine`,
  `search_v2_{furniture,index,matcher,pipeline}` 1 passed each; `search_perf` ignored).
* `src/ipc/bindings.ts` was regenerated by the export test (line-ending noise) and discarded with
  `git checkout`; it is unchanged in the commit.
