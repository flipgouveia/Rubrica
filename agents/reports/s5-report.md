# S5 report: running header/footer detection

Branch `worktree-agent-a64f49a2123552317` (fast-forwarded to `search/phase-2` @ 6b20ac3 first; the
worktree had started on the phase-1 merge, which has no `engine/search/`). Files touched:
`src-tauri/src/engine/search/furniture.rs`, `src-tauri/tests/search_v2_furniture.rs`, this report.

## The exact rule (also in the module doc of `furniture.rs`)

`detect(pages: &[PageLines]) -> Furniture` is a deterministic pure function; frozen signatures kept.

- **Band.** A line is a candidate when its rect intersects the top band (`rect.top() > H - 0.08*H`)
  or the bottom band (`rect.y < 0.08*H`), `H` = that page's height. A line touching both (tiny
  pages) goes to the side its centre is nearer. Pages with a non-finite or zero height, and lines
  with a non-finite rect, are skipped.
- **Position.** Distance from the line's vertical *centre* to the page edge of its side (top edge
  for the top band, bottom edge for the bottom band), in points. Centre, not the rect edge,
  because the rect is the union of tight glyph boxes (ascenders/descenders move the edges by a
  few points between different texts); measuring from the page edge makes pages of slightly
  different heights agree. Positions join one *position cluster* while consecutive sorted values
  differ by at most **3 pt** and the cluster spans at most **6 pt**.
- **Key.** Trim, whitespace collapsed (control chars such as PDFium's U+0002 count as
  whitespace), case-folded; every run of digits becomes one `#`; every token that is a *valid
  canonical Roman numeral* (`iv`, `xii`, `XII`; punctuation around it is kept) becomes `#`
  ("civil", "mid", "iiii" stay words). Punctuation-only tokens (decorative dashes) are dropped, so
  "- 3 -" and "3" share a key. A line with no letter/digit has no key and is never furniture.
- **Rule A (repeated text).** For one key, one side and one position cluster, let *n* be the
  distinct pages carrying it. Furniture when *n* >= 3 and *n* >= 30 % of all pages of the document
  (`n*100 >= 30*N`, integer arithmetic, so exactly 30 % qualifies), **or** the same holds for the
  even pages alone, **or** for the odd pages alone (parity = `page % 2`, 0-based). Top and bottom
  are counted separately; `N` is every page of the document, text or not.
- **Rule B (running-head slots; needed for varying heads).** A *slot* = side + page parity +
  position cluster. It is a running-head slot when it holds a line on >= **60 %** of the pages of
  that parity (and >= 3 pages) and >= **50 %** of its lines are on a key that occurs on >= 2
  distinct pages of the slot. In such a slot, the lines whose key occurs on >= 2 pages are
  furniture. A line whose text is unique in the slot is left alone (a slide-deck title, or the lone
  odd page of a one-page chapter: hiding a real hit is worse than showing a header hit).
  Why B exists: in `book.pdf` each chapter title is on 4 pages = 10 % of 40 and 20 % of the 20
  pages of its parity, so rule A alone cannot meet 30 %; position + band + parity + "this slot is
  full of repeating text" is what qualifies them.
- **Output.** Per page, in line order: `FurnitureLine { chars: TextLine.chars, rect }`.
  `excluded_ranges` and `page_furniture` are views of the same data.
- **Cost.** One pass over all lines (a rect test each); text is only normalised for band lines;
  then a sort over the band candidates (a handful per page).

## Measured positions (PDFium extraction, `tests/search_v2_furniture.rs --nocapture`)

All pages 792 pt high, band = 63.4 pt (top band y > 728.6, bottom band y < 63.4).

| Fixture | Line | Rect y range | In band? |
|---|---|---|---|
| book.pdf p.2+ header | "Manual de Contratos" / chapter title | 751.9 .. 758.6 | top band, centre 37 pt below top |
| book.pdf footer | "Página N de 40" | 28.1 .. 36.5 | bottom band, centre 29.7 |
| book.pdf first body line | chapter heading "1 Introdução" | 708.7 .. 723.5 | no (5 pt under the band edge) |
| book.pdf last body line | | 93.7 .. 103.9 | no |
| 500-page.pdf | "Page N of 500" | 715.8 .. 734.6 | **top band by intersection only**: the top edge 734.6 is 6 pt above the band edge 728.6, the centre (725.2) is 3.4 pt below it |
| form.pdf | title "Formulário de Identificação" | 715.9 .. 734.6 | top band (candidate, but 1 page), the 7.5 pt note at y 70..78 is outside |
| text.pdf, unicode.pdf | first line | 703.8 / 700.7 .. 715 | no |

500-page.pdf is the reason the band test is "intersects" and not "centre inside": a centre-in-band
rule would miss its label by 3.4 pt. The plan's claim ("sits near the top") holds, but only
barely; I did not bend anything, the intersection rule simply covers it. Note that the same
intersection rule makes an 18 pt title a candidate (form.pdf), which is harmless because
repetition, not position, decides.

## Results per fixture

- `book.pdf`: pages 2-40 each have exactly 2 excluded lines, header text equal to
  `header.byPage[page]` (even-index pages "Manual de Contratos", the others the chapter title) and
  footer equal to `Página {n} de 40`; both rects contain the documented baselines (752 / 30);
  page 1 has none; 78 excluded lines in total, no body line anywhere.
- `book-no-outline.pdf`: identical to `book.pdf` (asserted line by line).
- `text.pdf`, `unicode.pdf`, `form.pdf`: no furniture.
- `500-page.pdf`: exactly one excluded line per page, "Page N of 500", 500/500.

## Timing

`detect` on the 500 real pages of `500-page.pdf` (debug build, `--nocapture`): **1.6 ms**. The
unit test with 500 synthetic pages (2 band lines + 3 body lines each) asserts < 500 ms in debug
(the 50 ms release budget is met by a factor of ~30; the loose bound only guards against a
quadratic regression in a slow debug build).

## Deviations and contract notes

- No contract change needed. `Furniture` gained no public API; I did not touch `mod.rs`/`extract.rs`.
- Pages are identified by `PageLines.page` (0-based, as `extract_page` sets it); parity uses it.
  If the orchestrator ever feeds a subset of pages, `N` would shrink and the 30 % threshold
  would change meaning: `detect` must get every page (the doc comment already says so).
- Rule B is an addition to the plan's one-liner ("repeats on >= 30 % of the pages"); it is what
  the brief asked for (chapter titles) and is bounded by the 60 % fill and 50 % repeat conditions.
- Text-less pages count in `N`. A document where most pages are scanned (no lines) therefore needs
  its text pages to carry the key on 30 % of *all* pages (or of a parity). Acceptable: a scanned
  page has no furniture to exclude anyway.
- Known limitation: a running head whose text is unique on every page (a real slide deck) is not
  detected, by design.

## Tests

Unit tests in `furniture.rs` (19): key normalisation (case, digits, roman numerals, punctuation,
control chars, empty), roman validator, roman-numeral footers (`Página i`..`Página xii`),
book-like even/odd heads with chapter titles, 2-page document (nothing) vs 3 pages (detected),
repeated mid-page line, unique high body lines, different page heights, same text at a different
position, position wobble within tolerance, exactly 30 % / 2 of 10 / 3 of 11 / 3 of 10 elsewhere,
parity-only key, top and bottom counted separately, unique titles in a filled slot (slide deck),
a lone title in a running-head slot, empty/degenerate input, accessor consistency
(`lines`/`excluded_ranges`/`page_furniture`, out-of-range pages), determinism, 500 synthetic pages.

Integration test `tests/search_v2_furniture.rs` (one `#[test]`, PDFium only inside `with_session`,
`RUBRICA_JOURNAL_DIR` set): book.pdf and book-no-outline.pdf (expected header/footer per page from
`book.expected.json`, rects vs baselines, accessors, equality between the two), text/unicode/form
(no furniture), 500-page.pdf (one "Page N of 500" per page, timing).

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: clean.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: clean.
- `cargo test --manifest-path src-tauri/Cargo.toml`: whole suite green (lib 42 passed,
  book_fixture, engine_fixtures, export_bindings, pdfium_smoke, search_engine,
  search_v2_furniture all ok; `search_perf` is `#[ignore]`d).
