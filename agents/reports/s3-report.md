# S3 report: search index and matching (Rust)

Branch: `worktree-agent-ae13df93d1813546a` (cut from `search/phase-2` at `6b20ac3`; the worktree was
created from `main`, so I `git reset --hard search/phase-2` before starting). Not pushed.

Files touched: `src-tauri/src/engine/search/{index,normalize,matcher}.rs`,
`src-tauri/tests/search_v2_index.rs`, `src-tauri/tests/search_v2_matcher.rs`, this report.
`Cargo.toml` / `Cargo.lock` are untouched (see deviation 1). All frozen signatures are kept as
specified.

## 1. Design

### PageIndex (`index.rs`)

Per page, 16 bytes per original char:

| field | type | B/char | notes |
|---|---|---|---|
| `chars` | `u16` | 2 | BMP code unit; the rare astral char is `U+FFFD` here + a sorted `(idx, char)` side table |
| `boxes` | `[u16; 4]` | 8 | edges (x0,y0,x1,y1) quantized on a per-page grid (page-wide min / (max-min)/65535), rounded **outwards**; `NO_BOX` sentinel |
| `norm` | `u16` | 2 | index fold of the page (UTF-16 units; case folded, diacritics stripped) |
| `map` | `u32` | 4 | normalized unit -> original char index |

Plus the page's `TextLine`s with their exact `f32` rects (a handful per page), and `hy_plain`
(sorted indexes of plain `-` promoted to line-end hyphens, usually empty). `line_texts()` is rebuilt
from the original chars and equals `RawPage::line_texts()` (tested on every page of five fixtures).
`heap_bytes()` is capacity-based (struct + every Vec).

Measured (tests print these): 

* synthetic 500 pages x 4000 chars: **32,357,748 bytes = 30.9 MiB, 64,715 bytes/page, 16.2 B/char**
  (budget ~40 MB).
* real `book.pdf` (40 pages, 119,322 chars): 48,585 bytes/page, 16.3 B/char; extrapolated to 500
  pages **24.3 MB**.
* box quantization error on all 119,322 real boxes: worst **0.0112 pt** (asserted < 0.05, never smaller
  than the original box).

The index always stores ONE fold (the index fold). A query that is stricter (case sensitive, or
diacritics significant) scans that stream and verifies each *candidate* against the original chars
refolded with the query's own fold, so pages are never re-normalized per query and the cache is shared
by all option combinations.

### Normalization (`normalize.rs`)

One streaming `Folder` produces UTF-16 units tagged with the original char index (used for the index,
the query terms and the strict re-check, so they cannot drift apart):

* whitespace (every Unicode space, NBSP, `\r`, `\n`, tabs, other controls) -> one `' '`; leading
  dropped, trailing never emitted;
* removed: U+00AD, zero-width chars (U+200B/C/D, U+2060, U+FEFF), combining marks U+0300-036F when
  ignoring diacritics;
* ligatures U+FB00-FB06 -> letters; curly quotes -> `'` / `"`; U+2010/2011 -> `-`;
* ignore diacritics: own table for U+00C0-017F (precomposed Latin-1 + Latin Extended-A, keeps stroked
  letters `ł đ ø ß æ œ` as they are) then simple single-char lowercase (unless case sensitive);
* **line-end hyphen** = the marker unit `HY` (0x0002) in the stream. PDFium's U+0002 is always a marker;
  a plain `-` is promoted by the index builder when it follows an alphanumeric and is followed (after
  `\r\n`, or at the end of a `TextLine`) by a letter; the break after it is swallowed. Matching
  (`match_from`): `HY` is skipped by a pattern without `-` and consumed by a `-` in the pattern, so
  "contrato", "contra-to" find `contra\u{2}to`; "pré-aviso", "préaviso", "pre-aviso" find
  `pré\u{2}aviso`. A mid-line literal hyphen is a real hyphen ("préaviso" does not find "pré-aviso").
  No per-query rebuild: it is an optional element in the cached stream.
* whole word: boundary = not alphanumeric; `HY` counts as part of the word (so whole-word "contra" does
  NOT find `contra\u{2}to`, whole-word "contrato" does); only edges of the pattern that are word chars
  are checked ("art." does not match inside "part.").

### Matcher (`matcher.rs`)

Each pushed page becomes a transient *work stream*: the cached units with the `excluded` ranges cut
out and whitespace re-collapsed (a cut leaves one space unless it follows an `HY`). Page k+1 follows
page k in one global coordinate space (one space between, none after a trailing `HY`). Only the last two
pages are alive, so hits continue k -> k+1 and never further, and only for consecutive pushes (a gap
drains all pending state). A line-end hyphen on the last body line of a page joins the next page's
first word even with the footer/header excluded.

* **Scan**: first-unit search + hyphen-aware compare; O(text) per term per page, plus a tail rescan of
  the previous page (2x the pattern length) for terms that straddle the break; non-overlapping per term.
* **Phrase**: every non-overlapping occurrence; emitted when its last page is pushed.
* **Proximity**: for each occurrence taken as the window's first char, the tightest window takes for every
  other term its first occurrence at or after that start (monotone per-term pointers, O(occurrences x
  terms) per page). Then: drop length > N and windows containing an excluded-term occurrence; keep only
  minimal windows (the next window must end strictly later, with one window held back across a page
  push); overlap sweep in start order: of two overlapping windows the shorter wins, tie the earlier.
  Window length = normalized chars first-term-start to last-term-end, a whitespace run (and a page
  break) = 1, excluded text = 0, `HY` = 0.
* **Hit**: `rects` = per line run of **every** positive-term occurrence inside the window (term = query
  position among positives; identical terms in the query are merged), `windowRects` per line,
  `charStart/charLen` in the start page space (spanning: stops at the page end), `context` with
  `before/after` ~60 chars (boundary spaces kept as in phase 1, excluded text absent, a line-end hyphen
  shown as `-`), `matched` = the window text elided as `head(78) + " … " + tail(78)` past 160 chars,
  `terms` = UTF-16 offsets clipped to the visible part (a term fully inside the elided middle is
  dropped), `score` = window length, `spansPages = Some((k, k+1))`, `outlineItemId = None`.
* `rank`: score ascending (None last), ties (page, charStart).

## 2. What each `book.pdf` zone yields (integration tests, all green)

| Zone | Result |
|---|---|
| whole-word `contrato` (case-sensitive) | per page = `contrato.byPage` + headings + running headers + **1** on p.24 (the `contra\u{2}to` the fixture does not count); total 200 = 189 + 10 + 1; with header/footer exclusion the 8 header hits go away |
| tight trio (p.16, 0-based) | found with 250 and 500, not 100; window **125** chars; rects terms `[0,1,2]` |
| loose trio (p.29) | found with 500, not 250; window **386** chars, 5 window rects (5 lines); `matched` elided, middle term dropped from `terms` |
| decoy (p.33 + p.37) | **not joined at 5000 or 500**, by design: they are 4 pages apart and a window may only continue onto the next page. With the largest window only the two trios qualify for `rescisão indemnização`; each decoy term alone is a one-term window |
| cross page 21/22 | "fazer cessar o acordo" found with the footer/header ranges excluded (spans (21,22), rects on both pages, charLen stops at p.21's end), not found with empty `excluded`; proximity "cessar acordo" = 15 chars with exclusion, 40 not enough without |
| hyphen p.24 | `contra-to`, `contrato`; `pré-aviso`, `préaviso`, `pre-aviso`, `preaviso`, `PRÉ-AVISO` all find it once with 2 rects (one per line); `pré aviso`, `contra to` do not |
| soft hyphen p.25 | `obrigações` / `obrigacoes`, once |
| ligatures p.26 | `eficácia`, `eficacia`, `eﬁcácia`, `fluxo`, `ﬂuxo`, on that page only |
| quotes/NBSP p.17 | `"justa causa"`, `“justa causa”`, `art. 12.º`, `art.\u{A0}12.º` |
| `acao` | whole-word `acao`/`ação`/`AÇÃO` = `acaoByPage` exactly; with accents significant `acao` finds none, `ação` the same pages; case-sensitive `Ação` finds none |
| `500-page.pdf` | `of 500` 500 hits; `Page 250` window 20 = 1 hit (page 249, length 8) although "Page" is on every page; `500 Page` = 499 windows crossing every page break |

## 3. Performance

Release numbers (`search_v2_perf_vs_phase1` vs the orchestrator's `search_perf::phase1_baseline`, same
fixtures/queries, same machine, one run each). "v2 first" = per-page PDFium hop + `extract_page` + index
build + matching; "v2 cached" = matching over cached indexes only.

| fixture / query | phase 1 first | phase 1 second | v2 first | v2 cached | first ratio | cached speedup |
|---|---|---|---|---|---|---|
| book.pdf `contrato` | 105.1 ms | 53.5 ms | 57.4 ms | 1.9 ms | 0.55x | 28x |
| 500-page.pdf `page` | 20.3 ms | 14.1 ms | 22.0 ms | 0.6 ms | 1.08x | 23x |
| text.pdf `the` | 3.3 ms | 2.2 ms | 3.6 ms | 0.4 ms | 1.09x | 5.5x |

Budget (first <= 1.5x, cached >= 3x) is met on all three. (The hit count differs by 1 on book.pdf: v2
also finds the `contra\u{2}to` the phase-1 engine could not.) Release, synthetic 500 x 4000-char
document: index build 88 ms; phrase `contrato` whole-word 23,418 hits 83 ms; `acao` 70,042 hits 234 ms;
case-sensitive verified 4.5 ms; 3-term proximity 23,040 hits 328 ms.
Debug, synthetic 500 x 4000 doc (hit-dense:
a hit every ~30 chars, which is far denser than real text), index build 0.45 s; phrase `contrato`
whole-word 23,418 hits 0.74 s; `acao` 70,042 hits 3.6 s; case-sensitive verified (0 hits) 0.07 s;
proximity of three terms 23,040 hits 8.2 s. Almost all of that is building the `SearchHit`s (context
strings, rects), not scanning.

## 4. Deviations from the brief

1. **No `unicode-normalization` dependency.** A 192-byte table for U+00C0-017F plus dropping U+0300-036F
   covers Portuguese and the other Western European languages (precomposed and NFD input), with no
   `Cargo.toml`/`Cargo.lock` change. Not covered: Latin Extended Additional (Vietnamese) and non-Latin
   scripts (they still match, just with their accents significant). If wanted, swap `strip_diacritic` for
   an NFD decomposition without touching anything else.
2. **Boxes are quantized `u16` edges, not `f32`** (16 B/char total instead of 28), within 0.012 pt.
   Highlight rects are therefore up to ~0.01 pt larger than the exact union; line rects (`line_texts`)
   stay exact `f32`.
3. **Decoy at 5000 is not joined** (see section 2): impossible under the one-page-carry rule, asserted
   and documented instead.
4. Identical positive terms in a query are merged (`term_count()` counts distinct terms). A lone `-`
   is a literal term; `""` is ignored; curly quotes also group a phrase.
5. Plain-hyphen promotion is part of the index (the brief asked for it); whole-word treats `HY` as part
   of the word (a judgment call, noted above).
6. `PageIndex` gained accessors beyond the frozen ones (`ch`, `box_of`, `norm`, `map`, `is_hy`, `lines`,
   `line_of`, `line_range`, `width`, `height`) and `normalize` is a public module API; nothing frozen
   changed.

## 5. Contract / shared-type notes (nothing blocking)

* `SearchHit.rects` doc says "one per line run of each term occurrence"; for proximity this
  implementation emits every positive-term occurrence inside the window (not only the ones that
  satisfy the window), which is what colouring needs. Say so in the contract if it should differ.
* `charLen` for a spanning hit is `char_count(start page) - charStart` (includes any excluded footer
  chars at the end of the page). The UI should not use it to infer text.
* The pipeline must pass the **same** `excluded` ranges it used for furniture rects; chars are in the
  `PageIndex`/`RawPage` char space. Unsorted/overlapping/empty ranges are accepted.
* Pages must be pushed in ascending order; a skipped page ends carry-over (as specified).
* Cached `PageIndex` is option-independent: the pipeline can keep it across searches whatever the flags.
* `matched` shows a line-end hyphen as `-` (e.g. "contra-to"); a soft hyphen in the PDF is
  indistinguishable from a hard one in PDFium's output, so it shows as `-` too.

## 6. Tests

Unit (108 in `engine::search::{matcher,normalize,index}`; the lib has 131 tests in total) and integration (2 files, 1 `#[test]` each, with the PDFium
sub-tests sequenced on one `SessionStore`):

* `normalize`: PT accents both ways, full table sanity, combining marks, case flags, ligatures (all
  seven), curly quotes, NBSP, soft hyphen, zero-width, whitespace runs, marker feeding, plain-hyphen
  swallowing the break, leading dash, query U+0002, astral chars, word units, strictness flag.
* `index`: counts/flags, `line_texts` == raw (incl. empty, astral), normalized text + map, U+0002
  marker, plain-hyphen promotion (and non-promotion), ligature map, soft hyphen, box round trip, NaN
  boxes, line lookup, `heap_bytes` layout.
* `matcher` (synthetic pages): INVALID_ARG cases and window limits 20/5000, syntax (quotes, exclusions,
  lone dash, duplicates), phrase positions/rects/context, non-overlap, case, accents both ways and
  strict combinations, ligatures, quotes, NBSP/whitespace, line break rects, soft/line-end/plain hyphen
  both forms, mid-line hyphen, whole word (edges, HY, strict case), context trimming/collapsing/char
  counting/UTF-16/elision, cross-page phrase with and without furniture, one-page limit, page gaps,
  removed block inside a page, hyphen across the page break + removed furniture, case-sensitive across
  the break, single report of a straddling term, empty pages, window exactly at N and N+1 (20..5000),
  whitespace runs/line breaks/HY counting, any term order, minimal windows, repeated terms,
  overlap keep-shorter and tie-earlier, excluded term inside/outside/phrase/whole-word/case, quoted
  term, rects/window rects/context, UTF-16 offsets with accents + astral, elision, cross-page window
  with/without excluded furniture, three-page limit, gap, held-window logic across pages, excluded term
  on the next page, single term, strictness, rank, streaming, reuse, plus three property tests
  (phrase vs naive search on 400 random texts; proximity vs a brute-force minimal-window + sweep
  reference on 600 random texts; page split == unsplit on 300 random texts).
* `search_v2_index.rs`: `line_texts` on real pages of five fixtures, scanned.pdf textless, box
  quantization on every real box, book zones in the normalized stream, 500 x 4000 synthetic memory
  budget, real-page memory.
* `search_v2_matcher.rs`: all the book.pdf rows in section 2, scope = pushed pages, ranking and
  non-overlap, 500-page streaming, synthetic performance, and an ignored `search_v2_perf_vs_phase1`
  (same fixtures/queries as `search_perf.rs`).

## 7. Verification

Run on this branch (debug profile unless noted):

* `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: clean (exit 0).
* `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: clean.
* `cargo test --manifest-path src-tauri/Cargo.toml`: all green: lib 131 passed; `book_fixture`,
  `engine_fixtures`, `export_bindings`, `pdfium_smoke`, `search_engine` 1 passed each;
  `search_v2_index` 1 passed; `search_v2_matcher` 1 passed (+1 ignored perf test); `search_perf`
  ignored (on demand).
* Release perf: `cargo test --release --test search_perf --test search_v2_matcher -- --ignored --nocapture`.

Note for the pipeline: a first release build of the whole crate takes several minutes in a fresh
worktree; the debug test run of `search_v2_matcher` takes ~13 s because of the hit-dense synthetic perf
case (release: < 1 s).
