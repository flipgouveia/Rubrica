# Rubrica — Architecture (v2)

Local-first PDF editor for Windows. No server, no account, no subscription, no telemetry.
A file opens, gets edited at native speed, and is saved where it was. **The file is the database.**
Working name from pt. *rubricar* (to initial a document).

## Three principles, enforced by architecture

1. **Local-first, always.** Every feature works offline. The only network call is the
   auto-updater (GitHub Releases), and it can be disabled.
2. **Standard PDF only.** Everything Rubrica writes — annotations, edits, pages, form values —
   is expressed as standard PDF constructs. Any file it saves opens correctly in Acrobat,
   browsers, and phones. No proprietary sidecar formats. *The portability test is the
   acceptance test:* an edit that only looks right inside Rubrica is a bug.
3. **Instant or honest.** Interactions render in the same frame or show real progress. The tile
   pipeline exists to make a 500-page document scroll like a small one.

## Stack

One deliberate constraint shaped every choice: **no AGPL anywhere** (MuPDF, iText, Ghostscript
rejected). Entire stack BSD/MIT/Apache — zero cost, closed-source distribution stays possible.

| Layer | Choice |
|---|---|
| PDF engine | **PDFium** via `pdfium-render` (Rust) — one engine for rendering AND editing. Chrome's engine, BSD, prebuilt binaries from bblanchon/pdfium-binaries. Page-object editing APIs are why it beats pdf.js |
| Shell | **Tauri 2**, Windows-only, WebView2 (ships with Windows 11). Installer ~15 MB |
| UI | React 19 + TypeScript + Vite; design tokens (Bricolage Grotesque / Instrument Sans / JetBrains Mono, Rubrica's markup-red accent); Tailwind v4 + Radix behavior |
| i18n | From day one: pt-PT default + en, namespace-per-area locale files, no hardcoded UI strings |
| IPC typing | **tauri-specta**: Rust command/event types are the single source of truth; TS bindings are generated, never hand-written |
| App state | SQLite (rusqlite) in `%APPDATA%\Rubrica` — recents, prefs, per-doc view state. Documents never copied/imported |
| Distribution | NSIS installer + portable .exe, auto-update from GitHub Releases, unsigned initially |

## Architecture

The load-bearing rule: **the UI never touches PDFium.** All document truth lives in the Rust
core behind Tauri IPC; React is a projection. One writer (undo integrity), crash containment,
honest save semantics.

- **Rust core**: one `DocumentSession` per open file — PDFium document handle, command stack
  (undo/redo), dirty state, autosave journal. Tile renderer with LRU cache keyed by
  `(page, zoomBucket, revision)`; an edit bumps revisions only for the pages it touched.
- **Rendering**: pages render as 512px tiles at discrete zoom buckets, served to the webview
  through a custom protocol (`rubrica-tile://` — which the page reaches as
  `http://rubrica-tile.localhost/…` on Windows; every URL is built via `src/ipc/protocolUrl.ts`,
  never spelled by hand), composed on a virtualized canvas. Only visible
  tiles + a prefetch ring exist. While drawing, the UI renders the in-progress object as SVG
  overlay at 60 fps; it is committed to the PDF only on release.
- **Text layer** per page (PDFium text APIs) powers selection, copy, and search.
- **Editing model**: every mutation is a Command with `apply()`/`revert()` — the command stack
  is both undo/redo and crash safety (autosave journal replays committed commands over the last
  saved copy). Save is atomic: temp + fsync + rename, optional `.bak`.
- **Whiteout vs. redaction are separate tools by design**: whiteout draws an opaque object (the
  content underneath still exists); redaction removes the underlying objects and rasterizes the
  region. The UI names the difference.

## v1 feature scope (aligned 2026-09-02)

- **Viewer**: open, tiled scroll/zoom, text selection + copy, search, thumbnails, print,
  recents, tabs for multiple documents, **night reading mode** (client-side tile filter,
  view-only, never modifies the file).
- **Annotations**: highlight, underline, strikeout, ink, sticky notes, shapes, free text — as
  standard PDF annotations.
- **Pages & assembly**: thumbnail rail as editor — drag reorder, rotate, delete, insert blank
  or from another PDF (merge/extract fall out as gestures).
- **Form filling** (in v1 by decision): view all field kinds and fill *checkbox* fields via
  PDFium's form API, saving with the AcroForm intact. Text/radio/dropdown/listbox fields are
  view-only in v1 — `pdfium-render` 0.9.3 (the PDF engine's Rust binding) cannot actually persist
  their values, a verified upstream library limitation accepted rather than worked around (see
  `agents/reports/r5-report.md`). Form *creation* permanently out.
- **Text & object editing**: edit text runs in place (font reuse; visible flag on substitution;
  deliberately NO paragraph reflow — the one Acrobat feature not chased), add text boxes and
  images, whiteout, true redaction.
- **Windows citizenship**: NSIS + portable, `.pdf` association, jump-list recents, auto-update.

**Deferred past v1 (explicit decisions)**: signatures — visual (drawn/imported stamp) first
when they come; qualified digital signatures (Cartão de Cidadão / CMD, PKCS#11) as their own
project later. **Out of scope by design**: OCR, compression, conversions, form creation,
cloud anything.

## Repository layout

```
rubrica/
├── src/                      # React UI — projection only, no document logic
│   ├── viewer/               # canvas surface, tile composition, virtualization
│   ├── chrome/               # toolbar, tabs, thumbnail rail, search, command palette
│   ├── screens/              # home/recents, settings
│   ├── tools/                # one folder per tool: annotate, pages, forms, text-edit, redact
│   ├── ipc/                  # generated bindings + mock engine (module-per-domain)
│   ├── i18n/  locales/       # pt-PT + en, namespace-per-area files
│   └── tokens/               # design tokens
├── src-tauri/
│   ├── src/
│   │   ├── commands/         # one file per IPC domain (document, render, text, history,
│   │   │                     #   annotations, pages, forms, textedit, redact, app)
│   │   ├── engine/           # pdfium wrapper, session, tiles, journal — mirrors commands/
│   │   └── store/            # SQLite: recents, prefs, view state
│   └── tauri.conf.json
├── fixtures/                 # test corpus: text, scanned, forms, encrypted, corrupt, unicode
├── installer/                # NSIS config, .pdf association
├── agents/                   # parallel-work briefs
└── docs/
```

## Quality bar

Code and comments in English; UI strings only through i18n (pt-PT + en). `cargo clippy -D
warnings` + rustfmt; TS strict. Every engine feature has tests against the fixtures corpus.
Portability check on everything written: saved output re-opens in a fresh PDFium instance and
parses with pdf-lib; release checklist includes opening in Acrobat Reader and a browser.
