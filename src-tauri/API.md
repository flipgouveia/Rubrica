# Engine internals — session API (R2, wave 1)

Not part of CONTRACTS.md (that's the IPC surface); this is the Rust-internal API wave-2
(`annotations`/`pages`/`forms`/`textedit`/`redact`) builds on. Frozen as of this commit per
CONTRACTS §6 — a needed change goes in your report, not a silent edit here.

## Coordinate convention

Every `Rect`/`QuadPoints` the engine produces or accepts is in **PDF points, origin
bottom-left** (PDFium's native page space) — `Rect { x: left, y: bottom, width, height }`.
CONTRACTS doesn't pin this down explicitly; this is R2's call, applied consistently across
`text_page_layout`, `text_search_*`, and left as the convention wave-2 annotation/textedit specs
should also follow. If the viewer needs top-left/CSS-pixel space, that conversion belongs in the
frontend (it already knows each page's height from `DocInfo.pages`).

## `engine::pdfium`

`pdfium::shared() -> &'static Pdfium` binds once (via `engine::pdfium::bind`, unchanged from
wave 0) into a `OnceLock<Pdfium>` and hands out a `'static` reference forever after. Every
`PdfDocument<'static>` in every session borrows from this one handle — never call `bind()`
directly outside this function. `pdfium-render`'s `thread_safe` feature (default-on, see
`Cargo.toml`) is what makes `unsafe impl Send for PdfDocument<'a>` possible (confirmed in the
vendored crate source), which is *only* what lets a `DocumentSession` be moved into/held inside a
`Mutex` shared across threads at all — it does **not** make concurrent PDFium calls from
different threads safe by itself. See `SessionStore`'s doc comment below for why that distinction
matters and turned out to be load-bearing, not academic.

## `engine::document`

```rust
pub struct DocumentSession {
    pub id: DocId,
    pub path: PathBuf,
    document: PdfDocument<'static>,
    pub revision: u32,
    pub encrypted: bool,          // has a security handler, even if it opened without a password
    pub has_form: bool,
    undo_stack: Vec<Box<dyn history::Command>>,
    redo_stack: Vec<Box<dyn history::Command>>,
    saved_at_depth: usize,        // undo_stack.len() at the last clean save
    journal: journal::Journal,
}

pub struct SessionStore { tx: Sender<StoreJob> } // an actor; see below
```

`SessionStore` is `.manage()`d once in `lib.rs`; every command/protocol handler goes through
`tauri::State<SessionStore>`. `DocumentSession` itself has no Tauri dependency — engine code
never imports `tauri`, only `commands/*.rs` does (kept the same separation R1 set up for `store`).

**`SessionStore` is an actor, and that is a hard safety requirement, not a convenience.** The
`pdfium-render` README's claim that its `thread_safe` feature "locks access to Pdfium behind a
mutex" describes the bindings-singleton's cross-thread *visibility* (the `OnceCell::wait()` used
internally, and the `unsafe impl Send` on `Pdfium`/`PdfDocument`) — it does **not** actually
serialize concurrent FFI calls (confirmed by reading the vendored source: nothing in
`bindings/dynamic_bindings.rs` or anywhere else in the crate wraps a call in a `Mutex`). Worse,
the vendored PDFium is thread-*identity* sensitive: it segfaults/corrupts when touched from more
than one OS thread even if every call is serialized (a `Mutex` gives mutual exclusion but not a
single thread identity). So the store is not a `Mutex<HashMap<...>>` any more — it is one
long-lived `rubrica-pdfium` owner thread that owns the `HashMap<DocId, DocumentSession>`, plus a
channel. Callers use `with_store(|map| ...)` / `with_session(&doc_id, |session| ...)`, which send a
boxed closure to that thread and block on a reply channel. **Every** PDFium touch anywhere in the
app runs inside such a closure and therefore on that one thread: `DocumentSession::open`
(`FPDF_LoadDocument`), rendering, text extraction/search, mutations, saves, the drop of each
`PdfDocument` (`FPDF_CloseDocument`, on close and at shutdown), and `FPDF_InitLibrary` itself
(`lib.rs`'s setup binds Pdfium via `with_store`, not on the setup thread). A closure passed to the
store must never call back into the store (it would deadlock the owner thread against itself), and
a future wave adding a PDFium call site must go through `with_store`/`with_session` or reintroduce
the crash.

Key methods (see doc comments in `engine/document.rs` for the exact signatures):

- `DocumentSession::open(path) -> Result<Self, RubricaError>` — loads with `password: None` (v1
  never prompts for a password), classifies a load failure into `ENCRYPTED`/`CORRUPT`/`IO` (any
  unrecognized `PdfiumError` variant also falls back to `CORRUPT` — a load failure that isn't a
  password/security or file-system problem is, in practice, always a malformed document), replays
  a matching journal if one is found on disk (`Journal::path_for` + `journal::read`), and mints a
  fresh opaque `DocId` (a process-wide atomic counter — "opaque" is the only contract requirement,
  so no UUID dependency).
- `.info() -> DocInfo` — the CONTRACTS §2 projection. Page sizes come straight from
  `page.width()`/`.height()` (`FPDF_GetPageWidthF`/`HeightF`), which — per the vendored crate's
  own doc comment ("changing the rotation of the page affects the return value") — already
  account for `/Rotate`, unlike the mock's `getDocInfo`, which stores an unrotated width/height
  and swaps them itself when `/Rotate` is 90/270. Same end result, no swap needed on this side.
- `.commit(command: Box<dyn history::Command>) -> CmdResult<MutationResult>` — the **only** way
  wave-2 code should mutate a document. Calls `command.apply(&mut self.document)`, pushes it to
  `undo_stack`, clears `redo_stack`, bumps `revision`, appends the command to the journal, and
  returns the invalidated pages. Wave-2 command handlers still own emitting `doc_state_changed`
  themselves (same pattern `commands/history.rs` uses) and invalidating the tile cache for the
  returned pages — see "Tile cache invalidation" below.
- `.undo()` / `.redo() -> CmdResult<Option<MutationResult>>` — `None` means nothing to
  undo/redo, which callers (see `commands/history.rs`) treat as a no-op returning the current
  revision, not an error — matches `mock/history.ts` exactly.
- `.dirty() -> bool` — `undo_stack.len() != saved_at_depth`.
- `.discard_unsaved()` — pops `undo_stack` down to `saved_at_depth`, calling `revert()` on each
  popped command. Not currently called by `doc_close` — a real `PdfDocument` is loaded fresh
  from disk bytes on every `doc_open`, so dropping a dirty session (which `doc_close` does
  unconditionally, after deleting its journal file) already discards unsaved edits for free; the
  mock's `structuredClone`-and-revert dance exists only because its two fake documents are
  singletons reused across close/reopen. `discard_unsaved` is kept as a building block for a
  future "revert to saved" affordance that keeps a document open.
- `.save(bak: bool) -> Result<(), RubricaError>` / `.save_as(path, bak)` — see "Atomic save".

## `engine::history` — the `Command` trait

```rust
#[typetag::serde(tag = "type")]
pub trait Command: Send {
    /// Mutates `doc` forward. Returns the 0-based pages whose tiles are now stale.
    /// May stash whatever state it needs for `revert()` in `&mut self`.
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError>;

    /// Undoes exactly what the last `apply()` did. Returns the same invalidated pages.
    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError>;
}
```

A **trait**, not an enum, per the brief: wave-2 modules define their own `struct FooCommand { .. }`
in their own `engine/{annotations,pages,forms,textedit,redact}.rs`, `impl Command for FooCommand`,
and that's the entire integration — no central match statement to extend, and nothing in this
file changes. `#[typetag::serde]` is what makes that possible while *also* keeping the journal
generic: it derives `Serialize`/`Deserialize` for `Box<dyn Command>` by embedding a `"type"` tag
per concrete struct, self-registering a deserializer for that tag via a macro-generated static —
no central registry to update either. This is the one addition beyond the brief's suggested
dependency list (`image`/`png`, `lru`, `sha2`, `tempfile`, `tokio` utilities); see the report.

**Practical rule for wave-2**: every field on your `Command` struct must be `Serialize +
DeserializeOwned` (plain data: ids, rects, colors, strings, before/after values needed for
`revert()`). Don't hold PDFium handles or borrowed data in a `Command` — it must survive being
written to the journal as JSON and reconstructed after a crash.

## Autosave journal (`engine::journal`)

One file per open document at `%LOCALAPPDATA%\Rubrica\journal\<sha256(canonical path)>.jsonl`
(hex digest, so the filename never leaks the original path). First line is a header:
`{"path": "...", "openedAt": "..."}`; every subsequent line is one committed command:
`{"seq": N, "command": <Box<dyn Command> JSON>}`.

- **Append on commit** — `DocumentSession::commit` appends one line and `fsync`s it before
  returning, so a crash immediately after a commit still has that command durably on disk.
- **Delete on clean save/close** — `.save()`/`.save_as()` delete the journal file once the atomic
  rename lands; `doc_close` deletes it too (a deliberate close-without-saving is a discard, not a
  crash — see `discard_unsaved` above — so nothing is left to "recover" next time). Only a hard
  crash (process dies before `doc_close` or `doc_save` ever runs) leaves a journal file behind.
- **`recovery_available` at startup** — `lib.rs`'s `setup()` scans the journal directory once and
  emits one `RecoveryAvailable { path, journal_id, saved_at }` event per orphaned file found
  (`journal_id` is the filename stem; `saved_at` is the last entry's timestamp, or the file's
  mtime if it has no entries yet beyond the header).
- **`journal_recover(doc_id)`** — `None` reports the most-recently-modified orphaned journal (if
  any); `Some(id)` reports whether *that already-open* session has a live (non-empty) journal,
  which doubles as a generic "does this doc have unsaved autosave state" query. Not fully pinned
  down by CONTRACTS (the command's shape allows both readings); this is R2's resolution — see the
  report if a later wave needs it to mean something else.
- **Replay** — `DocumentSession::open` checks for a journal matching the path *before* anything
  else touches `undo_stack`; if found, it deserializes each `command` line in order and calls
  `apply()` on the freshly-opened `PdfDocument`, skipping (not aborting on) any line that fails to
  deserialize or apply — a half-written last line from an interrupted `fsync` should never turn a
  recoverable crash into a failed open. Successfully replayed commands land on `undo_stack` with
  `saved_at_depth = 0` (the doc is dirty — none of this was ever saved), and the *same* journal
  file keeps being appended to for whatever the user does next.

## Atomic save (`engine::document::DocumentSession::save`)

1. `document.save_to_bytes()` (in-memory serialize — avoids a half-written destination file even
   under the wrong error path).
2. Write those bytes to `<dir>/.rubrica-tmp-<pid>-<counter>` next to the target (same volume, so
   the final rename is atomic), then `File::sync_all()`.
3. If the backup pref (`prefs_get("save.backup")`, default **on** — see "Store" below) is set and
   a file already exists at the target path, rename it to `<path>.bak` first.
4. Rename the temp file onto the target path (atomic on the same volume).
5. Delete the journal file, set `saved_at_depth = undo_stack.len()`, emit `save_state: 'saved'`.

Step 3 is two renames, not one atomic operation — a crash between them can leave the original at
`.bak` and nothing at the target path yet, but the temp file from step 2 is already durably on
disk and step 5 hasn't run yet, so the journal replay on next open reconstructs the same content
regardless. Never partially written: the destination path is either the old file or the new one,
never a half-flushed one.

## Custom protocols (`protocols.rs`)

`register_uri_scheme_protocol`'s own doc comment on `tauri::Builder` confirms Windows rewrites a
custom scheme to `http://<scheme>.localhost/<path>` rather than `<scheme>://<host>/<path>` —
Rubrica is Windows-only, so `request.uri().host()` is always `"rubrica-tile.localhost"`, never
the `docId`; every CONTRACTS §3 URL field (`docId`/`page`/`zoomBucket`/`x`/`y`) lives in
`request.uri().path()`'s segments instead. `protocols.rs` is the one file that knows this — it
parses the path/query and calls `engine::tiles::render_tile`/`render_thumb`, the same
Tauri-facing/engine split `commands/` keeps with `engine/` elsewhere.

## Tile pipeline (`engine::tiles`)

`rubrica-tile://<docId>/<page>/<zoomBucket>/<x>/<y>?rev=<revision>` and
`rubrica-thumb://<docId>/<page>?rev=<revision>` are registered in `lib.rs` against
`tiles::render_tile`/`tiles::render_thumb`, both `(SessionStore, TileCache) -> Result<Vec<u8>,
RubricaError>`. Zoom buckets are the fixed CONTRACTS list `[0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0,
4.0]`; a page renders at `points × bucket` pixels (bucket `1.0` == 1 PDF point per pixel == 72
DPI). A tile is always a full 512×512 bitmap — PDFium's `set_origin`/destination-bitmap clipping
(`PdfRenderConfig::set_origin`, confirmed against the vendored crate source: "the rendered page is
clipped to the destination bitmap's own width and height") renders exactly the requested
512×512 window of the full scaled page without ever allocating a full-page bitmap, so edge tiles
past the page's own bounds come back as blank/white rather than being a special case.

`TileCache` is an `lru::LruCache<TileKey, Arc<Vec<u8>>>` (`TileKey = (DocId, page, bucket-index,
x, y, revision)`), capacity 1024 entries, `.manage()`d in `lib.rs`. Revision is part of the key,
so a stale tile is simply never requested again once the frontend re-fetches at the new
`?rev=`; `TileCache::invalidate_pages(doc_id, pages)` additionally sweeps out any cached entry —
at *any* revision — for exactly the pages a mutation just touched, so memory from a
heavily-edited page doesn't linger for LRU eviction to eventually catch. **Wave-2 mutation
commands must call this** after committing, the same way `commands/history.rs`'s `history_undo`/
`history_redo` do — the engine layer doesn't reach into Tauri state itself.

## Text layer & search (`engine::text`, `engine::search`)

`text_page_layout`/`text_extract_range` (`engine::text`) are direct `PdfPageText` calls
(`chars().get(i)`, `tight_bounds()`, falling back to `loose_bounds()` then skipping the char
entirely if both fail — e.g. a few generated/zero-width glyphs — rather than erroring the whole
page). Search itself is the v2 engine below (CONTRACTS v1.2.0 §3–§4,
`agents/SEARCH-ORCHESTRATION.md` §2); the phase-1 PDFium-search code (`search_page_hits`,
`run_search_pages`, ...) no longer exists.

### Pipeline (`engine::search::pipeline`)

`text_search_start(docId, searchId, query)` takes the **client-minted** `searchId`:
`engine::text::register_search` registers it in `SearchRegistry` (a duplicate id is
`INVALID_ARG`) after `pipeline::prepare` has validated the query synchronously, so `NOT_FOUND` /
`INVALID_ARG` reach the caller. It then spawns one `spawn_blocking` task that runs
`pipeline::run` — Tauri-free, so `tests/search_v2_pipeline.rs` and `tests/search_engine.rs` drive
it with a bare `SessionStore` and a closure as event sink.

1. `prepare(store, docId, query) -> SearchPlan`: compiles the query (`matcher::compile`), reads the
   outline (`engine::outline`; an unreadable outline searches as if there were none) and resolves
   the scope to an inclusive 0-based page range (`scope::resolve_scope`). `INVALID_ARG`: empty or
   blank text; a proximity query without options, with a window outside 20–5000, or without a
   positive term (only `-excluded` terms); a `pages` scope with `from > to` or `to >= pageCount`;
   an unknown outline item id, or one without a page range (also: any outline scope on a document
   without bookmarks); an empty document. Unknown document: `NOT_FOUND`.
2. `run(store, docId, searchId, plan, cancelled, emit) -> bool`: with `excludeHeadersFooters`,
   first makes sure every page of the document is indexed and headers/footers are detected
   (cached; detection needs all pages); then feeds the scope's pages, in order, to the `Matcher`
   and streams `search_batch`es. Returns `true` iff `done` was emitted.

**Threading.** PDFium is only touched inside `SessionStore::with_session` hops, and only through
`search::extract`: cached page indexes are fetched together in ONE hop, missing pages are built
one hop each (so rendering and mutations interleave between pages). Matching, hit building and
batching run on the search task, off the PDFium thread, over `Arc<PageIndex>`/`Arc<Furniture>`
taken out of the session's cache.

### Cache and invalidation (`SearchCache`)

Each `DocumentSession` owns a `SearchCache`: one `Arc<PageIndex>` per page plus the document's
`Arc<Furniture>`. The index is option-independent (it stores one normalization fold; stricter
queries verify candidates against the original chars), so one cache serves every query and every
flag combination, and a repeated search only re-matches. `DocumentSession::commit/undo/redo`
invalidate it: the mutation's `invalidatedPages` are dropped, and because header/footer detection
depends on every page, any invalidation also drops the furniture; a change of page count clears
everything. The next search rebuilds what is missing on demand, so a stale index is never reused
(`tests/search_v2_pipeline.rs::cache_reuse_and_invalidation`: redacting the trio zone makes it
disappear from the next search, undo brings it back). The cache dies with the session (`doc_close`).
`SearchCache::heap_bytes()` reports its size: 16.2 bytes/char (u16 char, quantized u16 box edges,
u16 normalized char, u32 map), ~48 KB per `book.pdf` page, ~25 MB extrapolated to 500 dense pages
(budget ~40 MB).

### Batching rules (`search_batch`)

- **All hits that START on a page travel in ONE batch** (`matches: [{ page, hits }]`, pages
  ascending across the whole search, hits within a page in document order). A hit may end on the
  next page, so page `k` is only emitted once page `k+1` has been matched (or at the end).
- A batch goes out for every finished page with hits and **at least every 25 scope pages**
  (`PROGRESS_EVERY_PAGES`; empty `matches`) so the UI can show "page X of N". `pagesSearched`
  counts scope pages, is monotonic (non-decreasing: the last progress batch and `done` can both be
  at `pageCount`) and equals `pageCount` on `done`; `pageCount` = pages **in scope**.
- The last batch is `done: true`; `textless` is meaningful only there (no searched page had any
  extractable non-blank char — a scanned PDF).
- `ranked: true` only on the `done` batch of a **proximity** search (scores are final; the UI may
  then sort by compactness itself). Phrase searches and progress batches are `ranked: false`.
- `furniture` (with `excludeHeadersFooters`): the excluded lines' rects of the pages this batch
  covers, one `PageFurniture` per page that has any (empty otherwise).
- **Cancellation.** `text_search_cancel` sets the flag and removes the registry entry. The flag is
  checked before and after every page hop (and between pages of the furniture pass), so a cancel
  that lands mid-hop does not leak that page's batch. A cancelled search emits **nothing
  further**, not even `done` (`run` returns `false`), and a closed/gone document likewise ends
  silently. `SearchRegistry::finish` frees the id once a search ends, so ids are reusable.

### Normalization and matching

One streaming fold (`search::normalize`) feeds the index, the query terms and the strict
re-check, so they cannot drift apart: every whitespace run (NBSP, `\r`, `\n`, tabs) is one space;
soft hyphen and zero-width chars vanish; ligatures U+FB00–FB06 expand to letters; curly quotes
become `'`/`"`; case is folded unless `caseSensitive`; with `ignoreDiacritics` accents are
stripped (table for U+00C0–017F plus combining marks U+0300–036F; stroked letters stay).
**Line-end hyphens:** PDFium reports a hyphen that ends a line (hard or soft) as **U+0002** with no
line break; the fold turns it into a marker unit that a pattern without `-` skips and a `-` in the
pattern consumes, so `contrato` and `contra-to` both find the text `contra` U+0002 `to`, and `pré-aviso` /
`préaviso` both find a split `pré-`/`aviso`. A plain `-` followed by a letter on the next line is
promoted the same way by the index builder; a mid-line hyphen stays a real hyphen. Whole word =
boundaries are non-alphanumeric, the hyphen marker counts as part of the word.

- **Phrase:** every non-overlapping occurrence; one `SearchHit` per occurrence, wrapped across
  lines as ONE hit with one rect per line run (B2); it may continue onto the next page
  (`spansPages = [k, k+1]`, rects on both pages, `charLen` stops at the start page's end).
- **Proximity:** whitespace-separated terms (`"..."` = exact-phrase term, `-term` = excluded term).
  A *window* is the stretch from the first character of its first term to the last character of
  its last term; its length (the `score`; lower = more compact) counts normalized chars, a
  whitespace run or page break as 1, excluded header/footer text and hyphen markers as 0. Windows
  are kept when length ≤ `window`, they are minimal (not containing a shorter window), contain no
  excluded term, and of two overlapping windows the shorter wins (tie: the earlier). A window may
  continue onto the next page only. The hit's `rects` carry one rect per line run of each term
  occurrence (`term` = index in the query); `windowRects` outline the window per line; `context`
  `matched` is the window text, elided past 160 chars as `head … tail`, with `terms` UTF-16 ranges.
- `charStart/charLen` are in the start page's `text_page_layout` `char_index` space (PDFium char
  indices, **not** UTF-8 offsets; every hit's range agrees with the `page_layout` boxes). `context`
  is ~60 chars either side, whitespace collapsed, `before`/`after` keep boundary spaces.
  `outlineItemId` = deepest outline entry containing the START page (`None` without an outline).

### Headers and footers (`search::furniture`)

With `excludeHeadersFooters` the matcher treats detected furniture lines as absent (no match may
use them; they do not count toward a proximity window; a phrase can therefore span the page break
across footer + header). Detection is a pure function of all pages' lines, cached per document:
candidates are lines in the outer 8 % band of the page (top/bottom); a line's key is its text
case-folded with digit runs and Roman numerals replaced by `#`. Rule A: a key at one position
cluster on ≥ 3 pages and ≥ 30 % of all pages (or of the even/odd pages alone) is furniture. Rule B
(running-head slots): a side/parity/position slot filled on ≥ 60 % of that parity's pages whose
lines are ≥ 50 % repeated keys treats its repeated lines as furniture (chapter titles in odd
heads); a unique line in such a slot is left alone, since hiding a real hit is worse than showing
a header hit.

### Coordinates (B11)

Hit rects and `text_page_layout` boxes come from the same PDFium char boxes and are in the same
space: unrotated PDF user space, independent of `/Rotate` and of the CropBox (verified on
`/Rotate 90` and CropBox ≠ MediaBox pages: identical rects for identical content; each hit's rects
equal the union of the `page_layout` boxes of its char range, line by line). Index boxes are
quantized outwards, so a rect can be up to ~0.012 pt larger than the exact union. PDFium reads a
`/Rotate 90` page in rotated reading order, so a phrase that wraps in the content stream may not
be adjacent in the extracted text there (and is then correctly not found).

### Performance (release, from `agents/reports/s3-report.md`)

| fixture / query | phase 1 first | v2 first | v2 cached |
|---|---|---|---|
| book.pdf `contrato` | 105 ms | 57 ms | 1.9 ms |
| 500-page.pdf `page` | 20 ms | 22 ms | 0.6 ms |
| text.pdf `the` | 3.3 ms | 3.6 ms | 0.4 ms |

Budget (first ≤ 1.5× phase 1, cached ≥ 3× faster) met on all three. Synthetic 500 × 4000-char
document: index build 88 ms, whole-word phrase 23,418 hits 83 ms, three-term proximity 23,040
hits 328 ms. Run `search_perf.rs` (`--release -- --ignored --nocapture`) for current numbers.

## Store (`store` — unchanged shape, new call sites only)

No changes to `store/mod.rs`'s schema or method signatures. `commands/document.rs::doc_open` and
`::doc_save_as` call the existing `Store::recents_upsert(path, 0, 1.0)` — matching
`mock/app.ts::recordRecent`, which also always resets to defaults on open/save-as rather than
preserving a prior view-state (there is no CONTRACTS command that ever *writes* a different
`last_page`/`last_zoom`, so "reset to defaults on open" is the only value that's ever actually
meaningful until a future wave adds one). `doc_save`/`doc_close` do not touch recents, again
matching the mock. The `save.backup` pref (default `"true"`, JSON-encoded per `prefs_*`'s
existing convention) gates the `.bak` step in atomic save.

## What's deliberately NOT here

`commands/{annotations,pages,forms,textedit,redact}.rs` and their `engine/` counterparts are
untouched `UNSUPPORTED` stubs — that's R5/R6's wave. R2's own test suite (`tests/`) exercises the
`Command`/journal/cache machinery with two small, real, generically-useful `Command` impls
(`InsertBlankPageCommand`, `RotatePageCommand` in `engine::history::test_commands`) precisely
because no real domain command exists yet. They're deliberately **not** `#[cfg(test)]`-gated —
`tests/engine_fixtures.rs` is a separate integration-test binary that links this crate as an
ordinary dependency, so anything gated on the *library's own* test build wouldn't exist for it to
call. Not part of the public IPC surface either way; wave-2 code adds alongside them, doesn't
need to touch or remove them.
