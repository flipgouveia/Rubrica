# Changelog

All notable changes to Rubrica are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Proximity search.** Switch the search panel to *Proximidade* (or press Alt+P) and type several
  words: each result is a zone of the document where all of them appear within a window you
  choose (500 characters by default). `"exact phrase"` counts as one term and `-word` excludes
  zones that contain it. Zones can run onto the next page, the most compact ones are listed first,
  and every term gets its own highlight color — editable from the panel or Settings → Search.
- **Search in part of the document.** Search the whole document, the current chapter, any
  chapter or sub-chapter picked from the PDF's outline, or a page range.
- **Accent-insensitive search, on by default.** "acao" finds "ação" and the other way round;
  ligatures, curly quotes and non-breaking spaces no longer get in the way, and a word split by a
  hyphen at the end of a line is found whole.
- **Ignore running headers and footers.** An option of the search skips the repeated lines at the
  top and bottom of the pages ("Página 3 de 40", chapter titles), shown dimmed and struck through
  on the page.
- **Results grouped by chapter**, with surrounding text, and a **density map** beside the
  scrollbar showing where the results are; click it to jump there.
- **Outline panel.** A new *Índice* tab next to the thumbnails shows the PDF's bookmarks; click to
  navigate. The section you're reading is highlighted, and during a search each chapter shows how
  many results it holds.
- **Choose the accent color.** Settings → Accent color swaps the app's red for blue, teal, green,
  purple or graphite, each tuned for the light and dark themes. Red stays the default; colors you
  write into the PDF (annotations, redaction) don't change.
- **Zoom from the keyboard and mouse.** Ctrl + (or Ctrl =, numpad +) and Ctrl − zoom in and out,
  Ctrl 0 goes back to 100%, and Ctrl + mouse wheel zooms around the point under the cursor
  instead of jumping. Only the page zooms, never the app's own interface.

### Fixed

- **Closing Settings returns to the document.** It used to drop you on the Home screen even with a
  PDF open; now the back button (or Escape) goes back to where you came from.
- **Selecting text looks clean.** A selection is one even band per line; it used to be a stack
  of overlapping rectangles of different heights that left darker patches. Highlights, underlines
  and redactions made from a selection are now one shape per line too.
- **Print preview shows the pages.** The pages to print were loaded through a channel the app
  never enabled, so the preview (and the printout) showed broken-image icons. Printing now also
  waits for every page to load, and says so if one can't be prepared.

- **Search counts and navigates real occurrences.** A match that wrapped onto the next line used
  to count as two results, and "next" could land on half a word; now each occurrence is one
  result, highlighted on every line it spans. Each result in the list shows the surrounding text
  instead of just "Page N", and the list stays fast with thousands of results.
- **Search no longer covers the page.** Ctrl+F opens a one-line bar over the viewer's margin;
  Ctrl+Shift+F (or the expand button) opens a resizable panel docked on the right that shrinks
  the page instead of hiding it. The app remembers which one you used last.
- **Search behaves correctly around edits, tabs and closing.** Results from the first pages are
  no longer occasionally lost, closing search cancels it, editing the document re-runs it instead
  of leaving stale highlights, and switching tabs keeps each document's query and results.
  Activating a result scrolls that exact spot into view, even when zoomed in.
- **Search shows its progress and explains scanned PDFs.** Long documents show "page X of N"
  while searching, and a document with no extractable text says so instead of "No results".
- New search keys: Enter / F3 for the next result, Shift+Enter / Shift+F3 for the previous one,
  Escape to close.
- **Searching again is much faster.** Text is indexed once per page and kept until the page
  changes, so repeating or refining a search is dozens of times quicker (a 500-page document goes
  from ~30 ms to under 1 ms), and the first search is no slower than before.
- **The page indicator no longer lags behind the scroll.** It reported a page up to two pages
  above the one on screen.

- **The viewer now actually shows the document.** Since the first build, every page tile and
  thumbnail was requested as a literal `rubrica-tile://` / `rubrica-thumb://` URL, which the
  Windows webview has no handler for — so the main viewer showed broken-image icons in place of
  pages and the thumbnail rail showed empty frames. URLs are now built in the form Tauri routes
  on each platform (`http://rubrica-tile.localhost/...` on Windows). A real-engine e2e spec now
  asserts that tiles and thumbnails decode and contain page content, so this can't regress
  silently again.

- **Opening and saving no longer require typing a file path by hand.** The app shipped without
  `tauri-plugin-dialog` registered, so there was no way to reach an OS file dialog: "Open" was a
  text box you pasted a path into, and "Save As" was another one. Both now open the real Windows
  file browser, filtered to PDFs — Save As starting in the document's own folder. A failed
  Save As also reports why instead of closing as though it had worked.

### Changed

- **The Forms tool shortcut is now Ctrl+Alt+F** (was Ctrl+Shift+F, which now opens the search
  panel).

- **The toolbar now has separate Open, Save, and Print buttons.** Save and Save As used to live
  inside a folder-open icon, which offered no way to open a document at all — so there was no
  visible way to save, and opening a second file meant going back to the Home screen. The
  folder-open icon now only opens (native browser, plus your recent documents inline), a save
  icon holds Save and Save As, and Print has its own button.
- **All PDFium access now runs on a single owner thread (internal stability hardening).** The
  vendored PDFium library corrupts/segfaults when called from more than one OS thread, even when
  serialized. With real page rendering now happening, opening/editing/rendering/saving could touch
  it from several threads at once; the document registry is now an actor that funnels every PDFium
  call — rendering, editing, saving, opening, closing, and library init — onto one thread, removing
  that latent crash risk. No user-visible behavior change.

## [0.1.0] — 2026-09-15

First release. A local-first PDF editor for Windows — open a file, edit it, save it back where
it was, with no server, account, subscription, or telemetry involved.

### Viewer

- Open PDFs and scroll them, however long the document — page content is served in tiles so only
  the pages you're actually looking at need to be rendered. **Known issue:** real page tiles
  currently fail to render in the packaged app (see "Known limitations" below) — this is being
  actively investigated and is release-blocking until fixed.
- Zoom continuously (Ctrl+scroll or the zoom controls), with a percentage menu for exact levels.
- Select and copy text, including selections that span multiple pages.
- Search the whole document, with next/previous navigation and a clickable list of hits.
- A thumbnail rail for jumping around the document at a glance.
- Multiple documents open at once, each in its own tab, with a dirty-state indicator.
- Print, with all/current-page/custom-range options.
- Recent documents, remembered across sessions.
- A night reading mode (inverted/sepia tile filter) that only affects how the page looks on
  screen — it never modifies the saved file.

### Annotations

- Highlight, underline, and strikeout text directly from a selection.
- Freehand ink drawing.
- Sticky notes you can reopen and edit.
- Shapes: rectangle, ellipse, line, and arrow.
- Free text boxes.
- Every annotation can be selected, moved, resized, restyled (color/opacity/width where
  applicable), and deleted, with full undo/redo.
- All written as standard PDF annotations — no proprietary markup format.

### Pages

- Reorder pages by dragging thumbnails, with multi-select (click/Ctrl/Shift).
- Rotate one or many pages at once.
- Delete pages, with a confirmation that names how many pages you're about to remove.
- Insert a blank page at any position.
- Insert pages from another PDF, optionally a specific page range — this is how merging and
  extracting pages work in Rubrica, rather than being separate dedicated features.
- Existing annotations and form fields survive every page operation.

### Forms

- View every field kind in a filled PDF form: text, checkbox, radio, dropdown, and listbox.
- Fill and save **checkbox** fields, round-tripping correctly through save and reopen.
- Text, radio, dropdown, and listbox fields are shown correctly but are view-only in this
  release — attempting to edit one shows a clear "Not saved" indicator rather than silently
  discarding the change. See Known limitations below.
- Form *creation* (adding new fields to a PDF) is not supported and not planned.

### Text & object editing

- Edit existing text runs in place, reusing the original font whenever possible; a visible badge
  marks the (rare) case where a substitute font had to be used instead.
- Add new text boxes and images to a page.
- Deliberately **no paragraph reflow** — editing a run of text does not re-wrap surrounding text,
  by design.

### Redaction

- Two distinct tools, kept separate on purpose:
  - **Whiteout** draws an opaque shape over content — the underlying content still exists in the
    file underneath it.
  - **Redaction** actually removes the underlying text and image objects in the marked area and
    replaces that region with a flattened image, so nothing sensitive can be recovered from the
    saved file.
- Mark redaction regions by dragging, or convert a text selection into marks directly.
- A review panel lists all pending marks before you commit; a two-step confirmation dialog
  explains exactly what redaction does and how it differs from whiteout before anything is
  applied.

### Windows integration

- NSIS installer (per-user, no administrator prompt) and a portable `.exe` — pick either from
  GitHub Releases.
- Optional `.pdf` file association, available from "Open with" and Default Apps — Rubrica never
  makes itself the default PDF handler without you choosing to.
- Single-instance behavior: opening another PDF while Rubrica is running adds a tab to the
  existing window instead of launching a second copy.
- A taskbar Jump List with your recent documents and a "New window" action.
- Auto-update from GitHub Releases (checked once on startup), signed and verified before
  installing anything. The portable build never checks for updates. **Known limitation:** there's
  no Settings control yet to turn the startup check off — see "Known limitations" below.
- Crash recovery: an autosave journal can replay unsaved edits after an unexpected shutdown.

### Known limitations

- **Release-blocking:** real page tiles fail to render in the packaged app — the main viewer
  shows a broken-image icon instead of rendered PDF content. Root cause is unresolved as of this
  entry; see `docs/BACKLOG.md`'s "RELEASE-BLOCKING" section for the full investigation.
- No Settings control to turn off the startup update check yet — the preference exists and is
  honored the instant something sets it, but nothing in the UI writes it.
- Only **checkbox** form fields can actually be saved; text/radio/dropdown/listbox fields are
  view-only (a verified upstream limitation in the PDF engine's Rust binding, not a shortcut
  taken in Rubrica's own code).
- Radio button options show as raw index numbers ("0", "1", ...) instead of their real labels —
  the underlying library has no public way to read them.
- Ellipse/line/arrow shape annotations are saved as PDF `Stamp` annotations (visually identical
  in any viewer, but reported as "Stamp" rather than "Circle"/"Line" by a PDF inspector).
- No support for editing text containing CJK or other non-WinAnsi characters.
- Free-text annotation font size and color are not saved — free-text always saves at a fixed
  12pt/black.
- No visual or qualified digital signatures yet (see Post-v1 roadmap in `docs/BACKLOG.md`).
- The Windows installer is not Authenticode-signed, so SmartScreen shows a first-run warning
  (see `docs/INSTALL.md`).

[Unreleased]: https://github.com/flipgouveia/Rubrica/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/flipgouveia/Rubrica/releases/tag/v0.1.0
