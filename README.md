# Rubrica

A local-first PDF editor for Windows. Open a file, edit it at native speed, save it back where
it was. No server, no account, no subscription, no telemetry — **the file is the database**.

Working name from Portuguese *rubricar* ("to initial a document"). Rubrica stays focused on
direct, hands-on editing of one document at a time.

## Principles

1. **Local-first, always.** Every feature works offline. The only network call Rubrica ever
   makes is the auto-updater checking GitHub Releases once on startup (the portable build never
   does even that). The preference to disable that check exists and is honored the instant it's
   set, but there's no Settings control wired up to it yet — see Known limitations below.
2. **Standard PDF only.** Everything Rubrica writes — annotations, edits, pages, form values —
   is expressed as standard PDF constructs, never a proprietary sidecar format. Any file it saves
   opens correctly in Acrobat, browsers, and phones. *The portability test is the acceptance
   test:* an edit that only looks right inside Rubrica is treated as a bug.
3. **Instant or honest.** Interactions render in the same frame or show real progress.

One more constraint shaped the whole stack: **no AGPL anywhere.** MuPDF, iText, and Ghostscript
were all rejected on license grounds; the entire stack is BSD/MIT/Apache, so closed-source
distribution stays possible at zero licensing cost. See `docs/ARCHITECTURE.md` for the full
design writeup, including why PDFium (via `pdfium-render`) was chosen over pdf.js, and
`agents/CONTRACTS.md` for the technical conventions the codebase follows.

## Features (v1)

- **Viewer** — tiled scroll/zoom (**currently broken in the packaged app — see Known limitations
  below**), text selection and copy, thumbnails and an outline (bookmarks) panel, print, recents,
  multi-document tabs, a night reading mode (a client-side tile filter — view-only, never modifies
  the file).
- **Search** — phrase or proximity search (all words within N characters, `"exact phrase"`,
  `-exclusions`), in the whole document, a chapter from the outline or a page range;
  accent-insensitive by default; optional exclusion of running headers/footers; results grouped by
  chapter with context, a color per term, and a density map beside the scrollbar.
- **Annotations** — highlight, underline, strikeout, ink (freehand), sticky notes, shapes
  (rectangle/ellipse/line/arrow), free text — all written as standard PDF annotations.
- **Pages & assembly** — the thumbnail rail doubles as a page editor: drag to reorder, rotate,
  delete, insert a blank page, or insert pages from another PDF (merge/extract fall out of this
  as gestures rather than being separate features).
- **Form filling** — every field kind (text, checkbox, radio, dropdown, listbox) is read
  correctly and shown in the UI. **Only checkbox values can actually be saved in v1** — this is a
  verified limitation of the `pdfium-render` 0.9.3 binding, not a shortcut Rubrica's own code
  took (see [Known limitations](#known-limitations)). Editing a text/radio/dropdown/listbox
  field shows a clear "Not saved" badge instead of silently losing the edit. Form *creation* is
  out of scope permanently.
- **Text & object editing** — edit existing text runs in place (font reuse where possible, with a
  visible badge when a substitute font had to be used instead — deliberately **no paragraph
  reflow**, the one Acrobat text-editing feature Rubrica doesn't chase), add new text boxes and
  images to a page.
- **Whiteout vs. redaction** — two separate tools, on purpose. Whiteout draws an opaque shape
  over content that still exists underneath. Redaction actually removes the underlying text/image
  objects and rasterizes the marked region, so nothing sensitive survives in the saved file. The
  UI never blurs the distinction between the two.
- **Windows citizenship** — NSIS installer and a portable `.exe`, optional `.pdf` file
  association (never forced on you), Jump List recents, auto-update from GitHub Releases.

## Install

See [`docs/INSTALL.md`](docs/INSTALL.md) for end-user installation (installer vs. portable),
file association, update behavior, and the SmartScreen warning you'll see on first run (Rubrica
isn't Authenticode-signed yet — a deliberate, deferred decision, not an oversight).

## Development setup

**Prerequisites:**

- Rust (stable, MSVC toolchain) + the Tauri 2 prerequisites for Windows (WebView2, which ships
  with Windows 11; "Desktop development with C++" via Visual Studio Build Tools)
- Node 22.x and pnpm 9.x

```bash
pnpm install
```

From here there are two ways to run the app:

- **`pnpm dev`** — starts a plain browser dev server (Vite) against a TypeScript mock engine
  (two fake documents, one plain and one with form fields). No Rust toolchain needed for this
  path; it's how most of the UI in this repo was originally built and iterated on.
- **`pnpm tauri dev`** — launches the real native Windows app, backed by the real Rust/PDFium
  engine, with hot reload on the frontend.

Other useful scripts (see `package.json`):

| Script | What it does |
|---|---|
| `pnpm build` | Type-checks and builds the frontend (`tsc -b && vite build`) |
| `pnpm tauri build` | Builds the full native app (add `--debug` for an unsigned debug bundle) |
| `pnpm lint` | ESLint over the whole repo (includes a hardcoded-UI-string rule) |
| `pnpm typecheck` | `tsc -b --noEmit` |
| `pnpm test` | Vitest (frontend unit/integration tests) |
| `pnpm i18n:check` | Verifies pt-PT/en locale key parity across every namespace |
| `pnpm bindings:check` | Fails if `src/ipc/bindings.ts` has drifted from the Rust command surface |
| `pnpm bindings:generate` | Regenerates `src/ipc/bindings.ts` from the Rust side (tauri-specta) |
| `pnpm verify:pdf` | Parses every fixture PDF with pdf-lib — half of the portability gate |

Rust-side checks (run from `src-tauri/`, or via `cargo ... --manifest-path src-tauri/Cargo.toml`):
`cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.

The UI never talks to PDFium directly — every document mutation goes through Tauri IPC to a Rust
core that owns the actual PDFium handle. `src/ipc/index.ts` picks the mock or the real engine
automatically (mock when not running inside Tauri, or when `VITE_MOCK_ENGINE=1`), so the same UI
code runs against either backend unchanged.

## Keyboard shortcuts

Every shortcut below is registered through one central map (`src/chrome/shortcuts.ts`) and shown
live in Settings. `Ctrl` is shown below since Rubrica is Windows-only.

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+P` | Print |
| `Ctrl+K` | Open the command palette |
| `Ctrl+F` | Open the search bar (or focus it and select the query) |
| `Ctrl+Shift+F` | Open the docked search panel |
| `Enter` / `F3` · `Shift+Enter` / `Shift+F3` | Next / previous search result |
| `Escape` (in search) | Close search and cancel it |
| `Alt+P` (in search) | Switch between Phrase and Proximity search |
| `Ctrl++` / `Ctrl+=` / numpad `+` · `Ctrl+-` / numpad `-` | Zoom in / zoom out (the same steps as the toolbar buttons) |
| `Ctrl+0` / numpad `0` | Zoom to 100% |
| `Ctrl` + mouse wheel | Zoom around the pointer |
| `Ctrl+C` | Copy selected text |
| `Ctrl+A` | Select all text on the current page |
| `Shift+←` / `Shift+→` | Extend the text selection by one character |
| `Escape` | Clear the current text selection |
| `Ctrl+H` | Activate the Annotate tool |
| `Ctrl+Shift+P` | Activate the Pages tool |
| `Ctrl+Alt+F` | Activate the Forms tool |
| `Ctrl+E` | Activate the Text Edit tool |
| `Ctrl+Shift+R` | Activate the Redact tool |
| `Ctrl+Shift+M` | Mark the current text selection for redaction (while the Redact tool is active) |

## Known limitations

**Real, unresolved bugs — not intentional tradeoffs:**

- **Release-blocking: real page tiles fail to render.** The main viewer shows a broken-image icon
  at every tile position instead of rendered PDF content, in the packaged app, for any document.
  Root cause is unresolved; full investigation and reproduction steps in `docs/BACKLOG.md`'s
  "RELEASE-BLOCKING" section.
- **No Settings control to turn off the startup update check.** The `updater.checkOnStartup`
  preference exists and is honored the instant something sets it, but nothing in the UI writes it
  yet.

The rest of this section is documented, intentional v1 tradeoffs — not bugs waiting to be filed.
Full detail lives in `agents/reports/r5-report.md` and `r6-report.md`.

- **Only checkbox form fields can be saved.** `pdfium-render` 0.9.3's public API can read all
  field kinds correctly but only persists writes for checkboxes; text/radio/combo/listbox writes
  either silently no-op or have no setter at all in the crate. Confirmed empirically (same-handle
  re-reads, fresh-handle reopen, and raw byte inspection of the saved file) and reported upstream
  ([ajrcarey/pdfium-render#132](https://github.com/ajrcarey/pdfium-render/issues/132)). Radio
  group option labels also can't be recovered from the crate, so radio options currently show as
  raw index numbers ("0", "1", ...) rather than their real labels.
- **Ellipse/line/arrow shape annotations are stored as PDF `Stamp` annotations**, not native
  Circle/Line annotations — `pdfium-render` 0.9.3 has no API to create those, and no raw-FFI
  escape hatch exists either. The drawn appearance is fully standard, portable PDF and renders
  identically in any conforming viewer; the only difference is that a PDF inspector reports
  `/Subtype /Stamp` rather than `/Subtype /Circle` or `/Subtype /Line`.
- **No CJK (or other non-WinAnsi) text editing.** Encoding a character outside a font's WinAnsi
  repertoire is rejected up front with a normal error — attempting it via a lower-level PDFium
  call was found to crash the process outright, with no way to catch it from Rust. Rubrica has no
  broader CJK story elsewhere either, so this is a firm v1 boundary, not a partial feature.
- **Free-text annotation font size and color aren't persisted** — `pdfium-render` 0.9.3 has no
  setter for either; a free-text box always saves at a fixed 12pt/black regardless of what was
  picked when creating it.

**Deferred past v1 (explicit product decisions, not gaps):**

- **Signatures.** A visual signature (drawn or imported stamp) is the first thing planned after
  v1; qualified digital signatures (Cartão de Cidadão / Chave Móvel Digital, PKCS#11) are planned
  as a separate project later.
- **Authenticode code signing.** The installer is currently unsigned, so Windows SmartScreen
  shows a warning on first run — see `docs/INSTALL.md` for what that looks like and why.

Out of scope by design: OCR, compression, format conversion, form
*creation*, or anything cloud-based.

See `docs/BACKLOG.md` for the complete, prioritized list of open follow-up items.

## License

MIT — see `src-tauri/Cargo.toml`.
