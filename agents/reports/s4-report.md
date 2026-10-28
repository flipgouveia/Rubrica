# S4 report — PDF outline and search scope (Rust)

Branch: `worktree-agent-ada04ffeb0b7460c1` (reset to `search/phase-2` at start: the worktree had been cut from `main`, which lacks the F2.0 stubs; the branch had no commits of its own).

## What was built
- `engine/outline.rs::read_outline(&PdfDocument) -> CmdResult<Vec<OutlineItem>>`.
- `engine/search/scope.rs::{resolve_scope, deepest_item_for_page}`.
- `commands/outline.rs` unchanged: `with_session(...)?` already flattens the `CmdResult<CmdResult<_>>`, so session-store errors and engine errors reach the caller as-is. `read_outline` itself never fails (a PDF without bookmarks gives `Ok(vec![])`).

## How pages are resolved
PDFium's `FPDFBookmark_GetDest` (via `PdfBookmark::destination`) resolves, verified empirically: explicit `/Dest [page /Fit]`, a same-document GoTo action, and named destinations (both the catalog `/Dests` dictionary and the `/Names /Dests` name tree). Additions on top:
- A bookmark whose action is not a same-document GoTo (GoToR, GoToE, URI, Launch, unsupported) gets `page: None`. Without this check PDFium resolves a GoToR `/D [1 /Fit]` to page 1 of the current document.
- Destination page object not in the page tree (PDFium returns -1) gives `None`.
- Numeric page index `>= page_count` gives `None`.
- No destination gives `None`.
- Defensive fallback: if `destination()` is `None`, a local GoTo action is asked for its destination.

Titles are trimmed; a missing or empty title is `""`.

`pageEnd`: pre-order flattening, then for each entry with a page, the page before the next paged entry with depth `<=` its own, else the last page; clamped so `pageEnd >= page`. Computed with a backward pass, O(n * MAX_DEPTH). `None` when `page` is `None`. Pageless entries do not terminate other entries' ranges.

ids: child-index path over all siblings, pageless ones included (`"0"`, `"0.1"`, `"2.1.0"`), same scheme as the mock.

## Cycle / depth / size protection
- Visited set keyed by `PdfBookmark` (the crate hashes and compares by raw PDFium handle). A `/Next` or `/First` that reaches an already-visited bookmark ends that chain. PDFium itself does not guard against these loops.
- `MAX_DEPTH = 64` (entries at depth 0..=63 kept; children of depth 63 dropped) and `MAX_ENTRIES = 10_000` total (the rest is ignored). Both are `pub const` in `engine::outline`. Recursion depth is bounded by `MAX_DEPTH`.
- Truncation is silent (no error, no log).

## Synthesized cases (hand-built PDFs in `tests/outline.rs`, 3 pages)
| Case | Result |
|---|---|
| `/Dest [page /Fit]` | page resolved |
| no `/Dest`, no action | `page None`, `pageEnd None` |
| `/Dest` to a `/Page` not in the tree | `None` |
| `/A GoTo /D [p /XYZ ...]` | page resolved |
| named dest in `/Dests` dict (`/Dest /chap`) | resolved |
| named dest in `/Names /Dests` tree (`/Dest (str)`) | resolved |
| GoToR with numeric `/D` | `None` |
| URI action | `None` |
| `/Dest [99 /Fit]` (out of range) | `None` |
| padded title / empty title | trimmed / `""` |
| C `/Next` to the first sibling, to an earlier non-first sibling, to itself | `[A, B, C]`, ids 0,1,2 |
| child B `/First` to its ancestor A | `A` with child `B`; B has no children |
| entry with `/Next` and `/First` to itself | 1 entry |
| chain of 100 levels | exactly 64 entries, deepest depth 63; a 64-level chain is kept whole |
| 10 050 siblings | exactly 10 000 |

## Deviations / notes
- `deepest_item_for_page`: a pageless entry is skipped as a match but its children are still searched (the mock skips the whole subtree). This only differs for outlines with pageless parents that have paged children; otherwise identical to `deepestItem` in `src/ipc/mock/text.ts` (first sibling containing the page wins, then descend).
- `resolve_scope` for `Outline`: also `INVALID_ARG` when the entry's page is `>= page_count` (defensive; cannot happen for an outline read from the same document); the end is clamped to `page_count - 1`.
- Contract: nothing to change in `types.rs` or CONTRACTS. `resolve_scope` returns `INVALID_ARG` for an empty document even for `All`.
- The brief says the worktree is cut from `search/phase-2`; it was actually cut from `main`, so I reset it (no prior commits on the branch).

## Tests
- `src-tauri/tests/outline.rs` (one `#[test] outline_engine`, 10 sub-tests, PDFium on the SessionStore thread): `book_outline_matches_expected_json` (titles, pages, pageEnd, depth, children, ids, 18 entries), `fixtures_without_bookmarks_have_empty_outline` (`book-no-outline.pdf`, `text.pdf`, `500-page.pdf`), `mixed_destinations`, `sibling_cycles_terminate`, `first_cycle_to_ancestor_terminates`, `self_loop_terminates`, `deep_chain_is_cut_at_max_depth`, `wide_outline_is_capped`, `scope_on_book` (All, Outline `0`/`2.1.0`/`2.1`, unknown id, Pages errors, deepest for 3.2.1 / 3.2 / before the first entry, no-outline document), `scope_on_entries_without_pages`.
- Unit tests in `outline.rs` (ids/pageEnd, pageless entries, clamping) and `scope.rs` (every `resolve_scope` branch and error, deepest cases, pageless parent).

## Verification
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: clean.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: clean.
- `cargo test --manifest-path src-tauri/Cargo.toml`: all green (31 lib unit tests, book_fixture, engine_fixtures, export_bindings, outline, pdfium_smoke, search_engine pass; search_perf stays ignored).
