# Frozen Contracts — v1.2.0 (Rubrica)

> v1.2.0 (search v2, phase 2 — `agents/SEARCH-ORCHESTRATION.md` §2.3): `text_search_start`
> takes a `SearchQuery` (phrase/proximity, scope, accents, headers/footers); hits carry per-term
> rects, window rects, score, page span and outline entry; `search_batch` gains `ranked` and
> `furniture`; new `doc_outline` command; new `search.*` preferences.
> v1.1.0 (phase 1): client-generated `searchId`, one `SearchHit` per occurrence with context,
> progress and `textless` on `search_batch`.

The law of the parallel build. **No agent may change this file.** If a contract is wrong or
missing: stop that piece, record it in your report (`agents/reports/`), continue with everything
else; the human orchestrator amends and bumps the version.

The single most important idea: **the entire IPC surface below is stubbed by R1 on day 0** —
every Rust command exists and compiles (returning `UNSUPPORTED`), TS bindings are generated,
and a TypeScript mock engine implements the same surface over a fake document. UI agents build
against the mock in a plain browser; engine agents replace stub bodies. Nobody waits for anybody,
and the shared registration files never change after wave 0.

## 1. Toolchain & naming

- Rust stable (MSVC), Tauri 2.x, `pdfium-render` + bblanchon prebuilt PDFium binaries.
- Node 22.x, pnpm 9.x, TypeScript 5.x strict, React 19 + Vite, Vitest. Windows CI runner.
- **tauri-specta v2**: Rust command/event/type definitions are the single source of truth;
  `src/ipc/bindings.ts` is generated (a CI check fails if it drifts) and never hand-edited.
- Commits: Conventional Commits. Branches `agent/rN`. Reports in `agents/reports/rN-report.md`.
- Naming: commands `snake_case`, domain-prefixed (`doc_open`, `annot_add`, `form_set_value`).
  Events `snake_case` past/state (`doc_state_changed`). i18n keys `namespace.section.key`.

## 2. Core IPC types

```ts
type DocId = string;                       // opaque, engine-assigned
interface DocInfo { docId: DocId; path: string; pageCount: number;
  pages: { width: number; height: number }[];   // PDF points
  encrypted: boolean; dirty: boolean; revision: number; hasForm: boolean }
interface MutationResult { revision: number; invalidatedPages: number[] }
interface RubricaError { code: 'ENCRYPTED'|'CORRUPT'|'IO'|'NOT_FOUND'|'UNSUPPORTED'
  |'FONT_MISSING'|'INVALID_ARG'|'INTERNAL'; message: string }
```

Every command returns `Result<T, RubricaError>`. Every mutation returns `MutationResult`; the
UI invalidates exactly those pages' tiles.

## 3. IPC command surface (stubbed in full by R1)

- **document**: `doc_open(path)` → `DocInfo` · `doc_close(docId)` · `doc_save(docId)` ·
  `doc_save_as(docId, path)` · `doc_list_open()` → `DocInfo[]`
- **outline**: `doc_outline(docId)` → `OutlineItem[]` (`[]` when the PDF has no bookmarks):
  ```ts
  interface OutlineItem { id: string;        // child-index path from the root, e.g. "2.1"
    title: string; page: number | null;       // 0-based; null = no resolvable destination
    pageEnd: number | null;                   // page before the next entry of the same or a
    depth: number; children: OutlineItem[] }  //   higher level, or the last page
  ```
- **render** (no commands — custom protocols):
  `rubrica-tile://<docId>/<page>/<zoomBucket>/<x>/<y>?rev=<revision>` → PNG tile (512×512;
  zoom buckets: 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4) ·
  `rubrica-thumb://<docId>/<page>?rev=<revision>` → PNG thumbnail (fit 160px) ·
  `rubrica-print://<docId>/<page>/<dpi>` → the PNG `print_render` already wrote for that page
  (`page` 0-based; 404 if it was not rendered; the handler never takes a file path from the
  webview, so no asset-protocol scope is needed)
  (logical spelling — the webview reaches a Tauri custom scheme as `http://<scheme>.localhost/…`
  on Windows, so the frontend builds these only via `src/ipc/protocolUrl.ts`, never by hand)
- **text**: `text_page_layout(docId, page)` → char boxes for selection ·
  `text_extract_range(docId, range)` → string ·
  `text_search_start(docId, searchId, query: SearchQuery)` → `null`. The
  **client** mints `searchId` (a UUID) and starts listening for it *before* calling, so no batch
  can arrive for an id the UI doesn't know yet. `INVALID_ARG` if that id is already running, the
  text is empty, a proximity query has no positive term or a window outside 20–5000, the page
  range is invalid, or the outline `itemId` is unknown.
  Results stream via the `search_batch` event; `text_search_cancel(searchId)` stops it (unknown
  or finished id: silent no-op). Search types:
  ```ts
  interface SearchQuery { text: string; mode: 'phrase' | 'proximity';
    proximity: { window: number } | null;     // chars; required in proximity mode
    scope: { kind: 'all' } | { kind: 'pages'; from: number; to: number }  // 0-based, inclusive
         | { kind: 'outline'; itemId: string };                           // [page, pageEnd]
    caseSensitive: boolean; wholeWord: boolean;
    ignoreDiacritics: boolean;                // also ligatures, curly quotes, NBSP, soft hyphens
    excludeHeadersFooters: boolean }
  // Proximity syntax: terms split on spaces, "…" = one exact-phrase term, -term = exclusion.
  // A hit is a WINDOW holding every positive term within `window` chars (headers/footers don't
  // count when excluded) with no excluded term inside. Any hit (both modes) may continue onto
  // the NEXT page, never further, and never outside the scope. Hard hyphens at a line end
  // match both with and without the hyphen ("contra-|to" ~ contrato, "pré-|aviso" ~ pré-aviso).
  interface SearchMatch { page: number; hits: SearchHit[] }   // hits that START on `page` (0-based)
  interface SearchHit {
    rects: { page: number; rect: Rect; term: number }[]; // one per line run of each term
                                        // occurrence (phrase mode: term 0); PDF points
    charStart: number; charLen: number; // start page's text_page_layout char_index space
    context: { before: string; matched: string; after: string;  // ~60 chars each side,
      terms: { start: number; len: number; term: number }[] };  // whitespace collapsed;
                                        // proximity `matched` = the window, elided " … " past
                                        // 160 chars; `terms` = UTF-16 offsets into `matched`
    windowRects: { page: number; rect: Rect }[]; // proximity: the window outline; phrase: []
    score: number | null;               // proximity: window length in chars; phrase: null
    spansPages: [number, number] | null;// [start, start+1] when it continues on the next page
    outlineItemId: string | null;       // deepest outline entry containing the start page
  }
  ```
- **history**: `history_undo(docId)` / `history_redo(docId)` → `MutationResult` ·
  `history_state(docId)` → `{ canUndo, canRedo, dirty }`
- **annotations**: `annot_list(docId, page)` → `Annot[]` · `annot_add(docId, spec)` ·
  `annot_update(docId, annotId, patch)` · `annot_delete(docId, annotId)`.
  `AnnotSpec` discriminated union: `highlight | underline | strikeout` (page + quadpoints),
  `ink` (strokes: point arrays, width, color), `note` (page, point, contents),
  `shape` (rect|ellipse|line|arrow, geometry, stroke/fill), `freeText` (rect, text, font size,
  color). Colors as `#rrggbb` + opacity 0–1.
- **pages**: `pages_reorder(docId, order: number[])` · `pages_rotate(docId, pages, degrees)` ·
  `pages_delete(docId, pages)` · `pages_insert_blank(docId, at, {width,height})` ·
  `pages_insert_from_file(docId, at, path, range?)`
- **forms**: `form_fields(docId)` → `FormField[]` `{ id, page, rect, kind:
  'text'|'checkbox'|'radio'|'combo'|'listbox', value, options?, readOnly, required }` ·
  `form_set_value(docId, fieldId, value)` → `MutationResult`
- **textedit**: `text_objects(docId, page)` → runs `{ objectId, rect, text, fontName,
  fontSize, embeddedFontUsable }` · `textobj_set_text(docId, objectId, text)` →
  `MutationResult & { fontSubstituted: boolean }` · `textobj_add(docId, page, spec)` ·
  `imageobj_add(docId, page, {rect, path})` · `object_delete(docId, objectId)`
- **redact**: `redact_apply(docId, page, rects[])` → `MutationResult` — removes underlying
  text/image objects and rasterizes the region. (Whiteout is NOT here — it's an opaque `shape`
  annotation; the tools are separate on purpose.)
- **app**: `recents_list()` / `recents_clear()` · `prefs_get(key)` / `prefs_set(key, value)` ·
  `print_render(docId, pages, dpi)` → temp PNG paths for the print flow (the webview shows
  them via `rubrica-print://`, not by path) ·
  `journal_recover(docId?)` → recovery info

## 4. Events (tauri-specta typed)

- `doc_state_changed { docId, revision, dirty, invalidatedPages }` — after every mutation,
  undo, redo, save.
- `save_state { docId, state: 'dirty'|'saving'|'saved' }`
- `search_batch { searchId, matches: SearchMatch[], done: boolean, pagesSearched, pageCount,
  textless: boolean, ranked: boolean, furniture: { page, rects: Rect[] }[] }` —
  `pageCount` is the number of pages IN THE SCOPE and `pagesSearched` counts those finished so
  far (monotonic, equals `pageCount` on `done`). The engine emits a batch at least every 25
  pages even with no matches (progress). `textless` is meaningful on the `done` batch only:
  `true` when no searched page had any extractable text (scanned PDF), so the UI can say "no
  searchable text" instead of "no results". `ranked` is `true` only on a proximity `done`
  batch: scores are final and the UI may switch to compactness order (it sorts by `score`
  itself; nothing is re-sent). `furniture` (only with `excludeHeadersFooters`) lists the
  excluded header/footer line rects of this batch's pages, for the UI to dim. All hits that
  start on a page arrive in ONE batch (a page is emitted once the next page is matched), in
  document order, so the UI may replace a page's hits wholesale. A cancelled search emits
  nothing further.
- `recovery_available { path, journalId, savedAt }` — on startup when a journal exists.

## 5. Mock engine (`src/ipc/mock/`)

Implements the full §3 surface in TypeScript over two in-memory fake documents (a 5-page text
doc and a form doc), including revision bumps, undo/redo, and fake tile/thumb rendering (canvas-
drawn placeholders with page numbers). Active when `import.meta.env.VITE_MOCK_ENGINE === '1'`
or when not running inside Tauri — so `pnpm dev` in a plain browser always works.
**Module-per-domain files** (ownership matters): `mock/{document,render,text,history}.ts`
(owned by R3 after wave 0) and `mock/{annotations,pages,forms}.ts` (owned by R4).
`mock/textedit.ts`, `mock/redact.ts` (owned by R6).

## 6. Rust module slots (fixed at wave 0, bodies replaced later)

`src-tauri/src/commands/{document,text,history,annotations,pages,forms,textedit,redact,app}.rs`
and matching `engine/` modules. `lib.rs`, the specta builder, protocol registration, and the
session type's public API are **frozen after wave 1 (R2)** — wave-2 agents replace stub bodies
inside their own module files only; a needed session change goes in the report instead.

## 7. UI conventions

- Components/styling: tokens in `src/tokens/` (type: Bricolage Grotesque / Instrument Sans /
  JetBrains Mono; accent markup-red `#A3243A` light / `#E6808F` dark; full light+dark themes),
  Tailwind v4 + Radix primitives. No stock component-library look.
- **i18n from day one**: react-i18next, default `pt-PT`, `en` required. Locale files are
  namespace-per-area: `locales/<lng>/{chrome,viewer,screens,tools-annotate,tools-pages,
  tools-forms,tools-textedit,tools-redact,common}.json` — an agent owns the namespaces of the
  areas it owns, both languages. CI checks key parity between pt-PT and en. Zero hardcoded
  user-facing strings (eslint rule from R1).
- Keyboard: every tool reachable by keyboard; shortcuts registered through one central map
  (`src/chrome/shortcuts.ts`, R3-owned; other agents request additions via report or use the
  tool-registration API R3 exposes).

## 8. Persistence & files

- SQLite via rusqlite at `%APPDATA%\Rubrica\rubrica.db`: `recents(path, last_opened_at,
  last_page, last_zoom)`, `prefs(key, value_json)`.
- Search preference keys (string values via `prefs_get`/`prefs_set`): `search.lastMode`
  (`compact`|`docked`), `search.panelWidth` (300–520), `search.mode` (`phrase`|`proximity`),
  `search.proximityWindow` (20–5000, default 500), `search.ignoreDiacritics` (`true` default),
  `search.excludeHeadersFooters` (`false` default), `search.sort` (`compact`|`position`),
  `search.highlightColors` (JSON array of 4 `#RRGGBB` strings, no alpha; the UI applies ~50 %
  opacity). Side panel: `ui.sidePanelTab` (`thumbnails`|`outline`). Accent colour:
  `ui.accentColor` (preset id: `rubrica` default |`blue`|`teal`|`green`|`purple`|`graphite`;
  unknown ids read back as the default).
- Autosave journal: `%LOCALAPPDATA%\Rubrica\journal\<doc-hash>.jsonl`, command log since last
  save; deleted on clean save; offered for replay on next open.
- Save: write temp in target dir + fsync + atomic rename; optional `.bak` (pref, default on).
- Documents are never copied into app storage.

## 9. Fixtures & portability

`fixtures/`: text-first PDF, image-heavy, 500-page, scanned, AcroForm (a real government-style
form), encrypted, corrupt, unicode (PT accents). Portability gate for anything written: output
re-opens in a fresh PDFium instance AND parses with pdf-lib (node script `scripts/verify-pdf.mjs`,
R1-provided); the release checklist adds manual Acrobat Reader + browser opens.

## 10. Dependencies & lockfiles

Each brief lists allowed additions; anything beyond goes in the report. `pnpm-lock.yaml` and
`Cargo.lock` conflicts: regenerate (`pnpm install` / `cargo update -w --offline` equivalent),
never hand-edit.
