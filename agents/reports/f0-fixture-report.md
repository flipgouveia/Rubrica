# F0-fixture report: `fixtures/book.pdf` for search v2

Branch: `worktree-agent-aa8d6f6fdfc987326` (cut from `search/phase-2`). Not pushed.

## What was built

- `fixtures/generate.mjs`: new `generateBookPdfs()` (layout model + `buildBookPdf` + hand-built
  `/Outlines` + `bookExpected`), wired into `main()`. pdf-lib only, no new dependencies. The existing
  generators are untouched; regenerating leaves `text.pdf`, `unicode.pdf`, `500-page.pdf`,
  `form.pdf`, `scanned.pdf`, `corrupt.pdf` byte-identical (`git status` shows only the new files).
- `fixtures/book.pdf` (99,314 bytes, with outline), `fixtures/book-no-outline.pdf` (98,251 bytes,
  same pages, no `/Outlines`), `fixtures/book.expected.json` (source of truth, computed from the
  strings actually drawn; the generator throws if a designed property is not met).
- `fixtures/README.md`: new "book.pdf" section (zones, what PDFium extracts) + regenerate note.
- `src-tauri/tests/book_fixture.rs`: one `#[test]` (single-thread rule, `engine::pdfium::shared()`).

## Page map (1-based pages; JSON is 0-based with `pageLabel`)

| Pages | Content |
| --- | --- |
| 1 | Title page, no header/footer |
| 2-8 | `1 Introdução` (1.1 Âmbito p.2, 1.2 Definições p.5) |
| 9-15 | `2 Formação do contrato` (2.1 p.9, 2.2 p.12, 2.3 p.14) |
| 16-23 | `3 Cessação do contrato` (3.1 p.16, 3.2 p.17, 3.2.1 p.19, 3.3 p.21) |
| 24-31 | `4 Prazos e notificações` (4.1 p.24, 4.2 p.28) |
| 32-40 | `5 Disposições finais` (5.1 p.32, 5.2 p.36) |

Controlled zones: tight trio p.17 (span 125 chars), loose trio p.30 (span 386 chars, 5 lines),
decoys p.34 (`rescisão`) and p.38 (`indemnização`), cross-page phrase p.22/23, hard hyphens p.25
(`contra-`/`to`, `pré-`/`aviso`), soft hyphen p.26, ligatures p.27, quotes + NBSP p.18, standalone
`ação` on p.4, 11, 20, 33. Whole-word body `contrato`: 189 (per page in `contrato.byPage`).
Outline: 18 entries; `pageEnd` is recomputed independently in the Rust test.

Header baseline y=752, footer y=30, body slots from y=712 (line pitch 15.4, 41 slots, last y=96).

## What PDFium extracts (measured by the test, pdfium-render 0.9.3, vendored build)

- **Soft hyphen (U+00AD) at line end**: `page.text().all()` gives `obriga` + **U+0002** + `ções ...`
  with no `\r\n` between the two lines. Per-char API: the same U+0002 char with `is_hyphen() == true`,
  `is_generated() == false`, then `ç` U+00E7 directly. The original U+00AD is not visible to the
  caller (pdf-lib did encode it, as byte 0xAD; WinAnsi has it).
- **Hard hyphens** (`contra-`/`to`, `pré-`/`aviso`): identical to the soft hyphen: U+0002 (hyphen=true),
  **no line break emitted**, next line's first letter follows immediately. So hard and soft
  hyphens are indistinguishable in PDFium's output. A matcher must treat U+0002 as the line-end
  hyphen marker and cannot rely on a `\n` or on U+00AD/`-` being present. (S3/S1 relevance: this
  also means "contra-\nto" never reaches the index as `contra-` + newline when the index is built from
  `text.all()` or per-char text.)
- **Ligatures**: the real fi/fl glyphs (Differences 128=/fi, 129=/fl) come back **expanded**:
  `eficácia` = U+0065 U+0066 U+0069 U+0063 U+00E1 U+0063 U+0069 U+0061 and `fluxo` = U+0066 U+006C
  U+0075 U+0078 U+006F. Per-char: `f` and `i` are two chars that share the same box
  (`x = [88.51, 94.01]`). U+FB01/U+FB02 are never returned, so plain-letter matching works, but
  rects for the two letters coincide.
- **NBSP**: `art.` + U+00A0 + `12.º` is extracted with a plain **U+0020** (`art. 12.º`).
- **Curly quotes**: kept: U+201C ... U+201D.
- Line breaks otherwise are `\r\n`; the first line of every page 2-40 is the header and the last is
  the footer in `text.all()`.

The test asserts these loosely where it is PDFium behaviour (separator <= 2 chars; ligature word is
either the FB0x code point or the expanded letters; NBSP is U+00A0 or a space) and prints the exact
values with `--nocapture`.

## Deviations from the brief (and why)

1. **Pages 35-37 are short (12/14/12 body lines instead of 41)**. With full pages, p.34 and p.38
   are ~10,000 chars apart, so a 5000-char window could not join the decoys as the brief intends.
   With the short pages they are 3,557 chars apart (`decoy.charsBetween`, headers/footers included):
   joined by 5000, not by 500. Listed in `shortPages`. The generator asserts 500 < gap < 5000.
2. **Lowercase `contrato` also occurs in titles** (the brief's own chapter names: `2 Formação do
   contrato`, `3 Cessação do contrato`, so also in the odd-page running headers of chapters 2 and 3).
   Counted separately in `contratoInTitles` (headings 2, headers 8, `byPage`); `contrato.byPage` is
   body only. The Rust test subtracts them from the extracted per-page count.
3. `ação` ground truth holds with whole-word matching only: filler legitimately contains
   `notificação`, `prestação` etc. (as the brief's vocabulary list asked), which contain `acao`
   once accents are stripped. The brief's "acao never appears" is verified as a whole word. Noted
   in `acaoNote`. I left `obrigações`, `aviso`, `pré`, `eficácia`, `fluxo`, `fazer`, `cessar`, `justa`
   out of the vocabulary so the hyphen/ligature/phrase zones are unique.
4. `/Outlines` gets `PageMode /UseOutlines` on the catalog (only in `book.pdf`). Not requested,
   harmless.
5. `verify-pdf.mjs` auto-discovers `fixtures/*.pdf`, so it picked up both new PDFs; no edit needed.
   `book.expected.json` is not a PDF and is ignored by it.

## Verification

- `pnpm fixtures:generate` run twice: SHA-256 of every `fixtures/*.pdf` and `*.json` identical
  across runs (PowerShell `Get-FileHash` + `fc`); `git status` shows only `fixtures/README.md`,
  `fixtures/generate.mjs` (modified) and the new files.
- `pnpm verify:pdf`: `7 passed, 0 failed, 2 skipped` (both book PDFs `parsed OK (40 page(s))`).
- `cargo test --manifest-path src-tauri/Cargo.toml --test book_fixture`: `1 passed`. It checks 40
  pages, the full bookmark tree (titles, destination pages, depth, `pageEnd`), no bookmarks in
  `book-no-outline.pdf` (and identical page text), header = first / footer = last line on pages 2-40
  and their segment positions in the top/bottom 8 % bands, no footer on p.1, per-page whole-word
  `contrato` counts, trio-word pages, `ação` pages, the two trios (lines + 125/386 char spans),
  decoys, cross-page lines, hyphen/soft-hyphen/ligature/quote/NBSP extraction.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: clean. `cargo clippy ... --all-targets
  -- -D warnings`: clean (MSRV 1.77 means no `is_none_or`; the test uses `map_or`).
- `pnpm lint`: 0 errors (4 pre-existing warnings in unrelated files).
