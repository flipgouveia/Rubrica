# R2 — Engine core report (wave 1)

Status: **done**. `cargo test`, `cargo clippy --all-targets -- -D warnings`, and `cargo fmt --
--check` are all green against `src-tauri/`; `pnpm typecheck`/`lint`/`i18n:check`/`verify:pdf`/
`bindings:check` all still pass on the frontend side (only `src/ipc/bindings.ts` changed, and
only additively — see below). The built app (`cargo build`, then launched directly) opens a
real "Rubrica"-titled window and stays up, exercising the full `lib.rs` setup path (Pdfium bind,
journal startup scan, state management, protocol registration) end to end. `src-tauri/API.md`
is written and is the canonical design doc for everything below — this report covers the same
ground at a level aimed at whoever picks up wave 2, plus the deviations/decisions log CONTRACTS'
own rules ask for.

## Deliverables (brief items 1–7)

1. **DocumentSession** (`engine/document.rs`) — real `open`/`close`/`save`/`save_as` over
   `pdfium-render`, multiple concurrent documents via `SessionStore` (`Mutex<HashMap<DocId,
   DocumentSession>>`, `.manage()`d), revision tracking, dirty state (`undo_stack.len() !=
   saved_at_depth`), `doc_state_changed`/`save_state` events. `ENCRYPTED` vs `CORRUPT` vs `IO`
   classification on open is a real mapping of `PdfiumError` variants (see API.md), verified
   against the actual `encrypted.pdf`/`corrupt.pdf` fixtures, not just plausible-looking code.
2. **Command stack** (`engine/history.rs` + `engine/journal.rs`) — `Command` is a trait
   (`#[typetag::serde]`-backed, not an enum — wave-2 modules add new `impl Command for
   TheirStruct` in their own files, nothing here changes), `CommandStack` owns undo/redo +
   dirty tracking, `history_undo`/`history_redo`/`history_state` are real. Autosave journal:
   append-on-commit (fsync'd), delete-on-clean-save-or-close, `journal_recover` command, and a
   `recovery_available` scan at startup. `doc_save`'s atomic write is temp-file + fsync +
   optional `.bak` rotation + atomic rename, verified with a real injected-failure test (see
   below), not just written-and-hoped.
3. **Tile pipeline** (`engine/tiles.rs` + `protocols.rs`) — both custom protocols render real
   PDFium output now: 512×512 tiles via `PdfRenderConfig::set_origin` against a small
   destination bitmap (never allocates a full-page bitmap per tile — see API.md), an `lru`-
   backed `TileCache` keyed by `(doc, page, bucket, x, y, revision)` with active
   `invalidate_pages` sweeping on top of the revision-keyed cache-busting. Verified rendering a
   tile from page 250 of the 500-page fixture.
4. **Text layer** (`engine/text.rs`) — `text_page_layout`/`text_extract_range` over
   `PdfPageText`; `text_search_start`/`cancel` stream `search_batch` per page from a
   `spawn_blocking` task, cancellable via a registry of `Arc<AtomicBool>` flags, matching the
   mock's cancel-then-silence semantics exactly.
5. **Print support** — `print_render` renders each requested page via
   `engine::tiles::render_page_at_dpi` and writes real PNGs to
   `%TEMP%\rubrica-print\<docId>\page-<n>-<dpi>dpi.png`.
6. **Store** — schema/methods unchanged (R1's skeleton was already complete); `doc_open`/
   `doc_save_as` now actually call `recents_upsert`, matching `mock/app.ts::recordRecent`'s
   reset-to-defaults-on-open behavior exactly (see API.md for why "reset", not "preserve", is
   the correct reading here). A `save.backup` pref (default on) gates the `.bak` step.
7. **Tests** (`tests/engine_fixtures.rs`) — the full corpus (text/unicode/500-page/form/
   scanned/encrypted/corrupt), a journal crash-replay test (commit twice, drop the session
   without saving, reopen, assert both commands replayed and nothing lost, save, assert the
   journal is gone), an atomic-save test that injects a real failure (marks the target
   read-only so the final rename fails) and asserts the original file is byte-identical
   afterward with no stray temp file, and the portability gate wired both ways (a fresh-handle
   PDFium re-open in Rust, plus shelling out to `scripts/verify-pdf.mjs` for the pdf-lib half —
   its own header comment names the PDFium half as this wave's job). `.github/workflows/ci.yml`'s
   `rust` job now also installs Node/pnpm so that shell-out actually runs in CI, not just
   locally.

## A real bug found and fixed along the way: PDFium is not safe across threads, at all

This is the one finding worth reading even if nothing else in this report is: **the vendored
PDFium build reliably crashes (segfault, stack-buffer-overrun abort, access violation — three
different signatures across repeated runs) when called from more than one OS thread, even
against completely different documents, even with every individual call already serialized
behind a `Mutex`.** `pdfium-render`'s README claims its `thread_safe` feature "locks access to
Pdfium behind a mutex" — reading the actual vendored source (`grep -rl Mutex src/`) shows nothing
does that; the feature only makes the bindings singleton visible across threads and lets
`PdfDocument`/`Pdfium` be marked `Send`. It does not serialize FFI calls.

Caught it via this crate's own test suite going from "reliably passing alone" to "~40% crash
rate" once run alongside other test binaries — not from reading a warning anywhere. Root-caused
with an isolated repro (`DocumentSession::open` + commit + save + reopen + tile-render, looped
15× on **one** thread: zero crashes; the same sequence spread across libtest's one-thread-per-test
default: frequent crashes even with a `Mutex` around every PDFium call). That rules out true
concurrent access as the only culprit and implicates something thread-*identity*-sensitive
(a font cache, or similar global state, that doesn't like being touched from a series of
different threads even one at a time) inside the prebuilt binary or the bindings layer — I did
not chase it further into the native binary itself; see "what the next wave needs to know" below.

**Fixes landed, both real and necessary, not just defensive:**

- `commands/document.rs::doc_open` now runs `DocumentSession::open` itself *inside*
  `SessionStore`'s lock, not just the registry insert afterwards — previously two concurrent
  `doc_open` calls for different files had no shared lock between them at all. Every other
  command already held the lock across its whole PDFium touch; this was the one gap. Tauri's
  actual runtime (a fixed tokio thread pool, threads reused for the app's lifetime) looks
  nothing like libtest's spawn-a-thread-per-test pattern that triggered the crash, so I believe
  this closes the real risk for the shipped app — but see below for why I'm flagging it rather
  than declaring it definitely fully closed.
- `tests/engine_fixtures.rs` restructured into **one** `#[test]` function that calls ten plain
  sub-test functions itself, sequentially, on the one thread libtest hands that single test —
  rather than ten separate `#[test]`s. Confirmed reliable across 15+ repeated runs after the
  change (0 failures), vs. roughly every-other-run crashing before it, with the lock already in
  place. The module doc comment there has the full writeup.

## Design decisions on things CONTRACTS left open (not contract violations — just filling gaps)

- **Coordinate convention**: every `Rect` is PDF points, origin bottom-left (PDFium's native
  space) — `{x: left, y: bottom, width, height}`. Not pinned down anywhere; wave-2 annotation/
  textedit specs should follow the same convention for consistency.
- **`journal_recover(doc_id)`**: `None` → the most-recent orphaned journal on disk (the startup-
  recovery reading); `Some(id)` → whether that *already-open* session currently has live
  (non-empty) autosave state. Both are legitimate readings of one ambiguous command; picked both
  rather than one, since they don't conflict.
- **Journal covers commits only, not undo/redo.** A crash after the user hit undo (but before
  saving) recovers to the state as if every originally-committed command were still applied —
  not to the exact undo/redo position at crash time. "Zero lost committed commands" (the brief's
  own DoD wording) is satisfied literally; exact undo-position fidelity across a crash was a
  deliberate scope cut, not an oversight. Journaling undo/redo as their own entries is a
  straightforward follow-up if a later wave wants it (append an entry-kind discriminant instead
  of always assuming "command").
- **`encrypted: bool` on `DocInfo`** means "has a security handler" (`security_handler_revision()
  != Unprotected`), independent of whether a password was needed to open it — an owner-password-
  only PDF opens fine but should still report `true`. Caught a real bug here: my first pass used
  `.is_ok()` on that same call, which is **wrong** — `Unprotected` is itself a non-error `Ok`
  variant, so that check reported every ordinary unencrypted PDF as encrypted. Fixed once the
  fixtures test caught it (`opens_text_pdf` asserting `!info.encrypted`).
- **`PdfPageRenderRotation`/degrees mapping** lives in `engine::pdfium` (shared by
  `engine::document`'s `DocInfo` projection and `engine::history`'s test-only
  `RotatePageCommand`) rather than duplicated. `page.width()`/`.height()` already account for
  `/Rotate` (confirmed in the vendored bindgen doc comment — "changing the rotation of the page
  affects the return value"), so, unlike the mock's `getDocInfo`, there's no separate swap step.
- **Custom-protocol wire format on Windows**: `register_uri_scheme_protocol`'s own doc comment
  confirms Windows rewrites a custom scheme to `http://<scheme>.localhost/<path>`, not
  `<scheme>://<host>/<path>` — so `request.uri().host()` is never the `docId`; every field lives
  in the path. `protocols.rs` is the one file that knows this.

## Dependencies added beyond the brief's suggested list

`lru` (tile cache — the brief did suggest this one), `sha2` (journal filename hashing — also
suggested), `image`'s already-present PNG support (also suggested), `tempfile` moved from
dev- to a normal dependency (print/atomic-save code doesn't need it directly, but tests do, and
it was already present). **Not on the suggested list**: `typetag` (0.2) — needed to make
`Box<dyn Command>` itself serializable for the journal without a hand-maintained central
registry of every command type, which is exactly what "make it a trait, not an enum" is asking
for; see API.md's `engine::history` section for the full reasoning. No other additions.

## Verified end-to-end, not just assumed

- `cargo test --manifest-path src-tauri/Cargo.toml`: 10 unit tests (store) + 1 engine-fixtures
  meta-test (10 real sub-checks) + bindings-export + pdfium-smoke, all green, repeatedly (15+
  reruns of the engine-fixtures binary alone with zero failures after the thread fix).
- `cargo fmt -- --check` and `cargo clippy --all-targets -- -D warnings`: clean.
- `pnpm typecheck`, `pnpm lint` (same 3 pre-existing warnings R1 already flagged as harmless,
  nothing new), `pnpm i18n:check`, `pnpm verify:pdf`, `pnpm bindings:check` (reports drift only
  because the regenerated `bindings.ts` — one added JSDoc block on `journalRecover`, nothing
  structural — isn't committed yet; regenerating and diffing confirms it's stable, not
  actually still drifting).
- `cargo build` then launching `target/debug/rubrica.exe` directly (both from a shell and via
  PowerShell's `Start-Process`): opens a real window titled "Rubrica" and stays up past startup
  — exercises Pdfium binding via the resolved resource dir, the journal startup scan, and state
  management registration for real, not just "it compiled".
- **Not verified**: driving the R1 demo route's UI against the real backend interactively. No
  GUI-automation tool here can attach to a native Tauri/WebView2 window (the available browser
  tool drives a separate, unrelated browser). The demo route's "add highlight annotation" step
  specifically would fail against the real backend regardless — `annot_add` is still an
  `UNSUPPORTED` stub by design (R5's wave, not this one's) — so a literal "run the demo route
  unchanged" wasn't fully possible yet even setting the tooling gap aside. Everything the demo
  route *can* exercise against the real engine (open, tile/thumb render, undo/redo, save) is
  covered by the automated suite instead.

## What the next wave needs to know

- **Everyone adding a `Command` impl (R5, R6)**: read `API.md`'s `engine::history` section.
  Fields must be plain serializable data (the journal round-trips them through JSON); stash
  whatever `revert()` needs in `&mut self` during `apply()` (see `RotatePageCommand`/
  `InsertBlankPageCommand` in `engine/history.rs` for the pattern — they're real, working,
  non-test-only-flavored examples, just not wired to any IPC command). Call
  `DocumentSession::commit`, never mutate `document()` directly. After a successful commit (or
  undo/redo), call `TileCache::invalidate_pages` with the returned pages yourself — the engine
  layer doesn't reach into Tauri state, same split `commands/history.rs` already follows.
- **Whoever adds the next PDFium call site anywhere** (a new command, a new protocol, anything):
  it must happen while holding `SessionStore`'s lock. See the thread-safety section above — this
  isn't a style preference, calling PDFium without it can crash the whole app.
- **R3 (viewer)**: tiles/thumbs are real now — `rubrica-tile://<docId>/<page>/<bucket>/<x>/<y>
  ?rev=<revision>` and `rubrica-thumb://<docId>/<page>?rev=<revision>` both return actual PNG
  bytes or an HTTP error status (404 for `NOT_FOUND`, 400 for `INVALID_ARG`, 500 otherwise) — no
  UI-facing change needed, this was always the contract. Rect coordinates from `text_page_layout`/
  `search_batch` are PDF-points/bottom-left-origin; converting to screen/CSS space is on the
  frontend, which already has each page's height from `DocInfo.pages`.
- **R7/R8 (release, integration)**: the thread-safety finding above is exactly the kind of thing
  worth a deliberate multi-document stress pass during manual release testing (open several
  files in quick succession, hammer undo/redo across tabs) — I believe the `doc_open`-under-lock
  fix closes the real risk given Tauri's actual (stable, reused) worker-thread model, but "the
  vendored binary crashed under a thread-churn pattern nothing else in the codebase produces"
  is not the same confidence level as "provably safe", and a native crash bypasses Rust's
  panic/error handling entirely (the whole app dies, not just one command). If it's ever seen
  in the wild, this report and `API.md` are where to start.
- `src-tauri/API.md` is the frozen session API per CONTRACTS §6 — `lib.rs`, the specta builder,
  protocol registration, and `DocumentSession`'s public surface are frozen as of this commit.
  A needed change from here goes in a future report, not a silent edit.

## Not done / explicitly out of scope for this wave

- `commands/{annotations,pages,forms,textedit,redact}.rs` and their `engine/` counterparts:
  untouched `UNSUPPORTED` stubs, exactly as the brief scoped (R5/R6's wave). This wave's own
  `Command`/journal/cache tests use two small, real, generically-useful test-only commands
  (`InsertBlankPageCommand`, `RotatePageCommand` in `engine/history.rs`) to exercise the
  machinery, since no real domain command exists yet to test it with — wave-2 code adds to that
  file, doesn't need to touch or remove them.
- No attempt to root-cause the PDFium thread-affinity crash inside the prebuilt binary itself
  (would need a debugger against a closed-source-ish vendored DLL) — worked around at the two
  points that actually needed it (production `doc_open` locking, this crate's own test
  structure) and documented for whoever hits it next.
