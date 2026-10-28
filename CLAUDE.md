# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Rubrica is a local-first, Windows-only PDF editor: Tauri 2 shell, Rust core on PDFium
(`pdfium-render` 0.9.x), React 19 + TypeScript + Vite UI. Read `docs/ARCHITECTURE.md` for the
design and `agents/CONTRACTS.md` for the frozen IPC contract and conventions.

## Commands

Prereqs: Rust stable (MSVC), Node 22, pnpm 9. `pnpm install` first.

- `pnpm dev` — Vite dev server on port 1420 against the **TypeScript mock engine** (no Rust needed; plain browser).
- `pnpm tauri dev` — real native app with the Rust/PDFium engine.
- `pnpm build` / `pnpm tauri build [--debug]` — frontend build / full native bundle.
- `pnpm lint` · `pnpm typecheck` · `pnpm test` (Vitest, jsdom).
- Single frontend test: `pnpm vitest run src/chrome/appViewStore.test.ts` (or `-t "<name>"`).
- `pnpm i18n:check` — pt-PT/en key parity across all namespaces.
- `pnpm bindings:generate` — regenerate `src/ipc/bindings.ts` from Rust; `pnpm bindings:check` fails CI on drift.
- `pnpm verify:pdf` — pdf-lib parse of fixture PDFs (half of the portability gate).
- Rust (all with `--manifest-path src-tauri/Cargo.toml`, or run from `src-tauri/`):
  `cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
  Single test file: `cargo test --test engine_fixtures`; single test: `cargo test --test engine_fixtures <name>`.
  `engine_fixtures` shells out to `node scripts/verify-pdf.mjs`, so Node + `pnpm install` are required for `cargo test`.
- E2E (real app via tauri-driver + WebdriverIO): requires `cargo install tauri-driver --locked` and a built
  exe (`pnpm tauri build --debug`). `pnpm e2e`; single spec: set `RUBRICA_E2E_SPECS=./specs/10-search.e2e.mjs`
  (path relative to `e2e/`). `RUBRICA_E2E_EXE` overrides the exe path. The CI e2e job is non-blocking (known WebView2 runner crash).

CI (`.github/workflows/ci.yml`) runs all of the above plus a "mock hygiene" check on `dist/assets`.

## Architecture

**The UI never touches PDFium.** All document truth lives in the Rust core; React is a projection.

- **IPC is generated, single-sourced from Rust** (tauri-specta). Never hand-edit `src/ipc/bindings.ts` —
  change Rust command/types, then `pnpm bindings:generate`. Commands are `snake_case` and domain-prefixed
  (`doc_open`, `annot_add`, `form_set_value`); every command returns `Result<T, RubricaError>` and every
  mutation returns `MutationResult { revision, invalidatedPages }` so the UI invalidates exactly those tiles.
- **Backend selection** happens only in `src/ipc/index.ts`: the rest of the app imports `commands`/`events`
  from there, never from `./bindings` or `./mock`. The mock (`src/ipc/mock/`, one file per domain) is
  used when `VITE_MOCK_ENGINE=1` or not inside Tauri. It must stay a dynamic `import()` isolated in its
  own chunk — CI greps built chunks for the `mock-perf-doc` marker. When adding/changing a command,
  update the matching mock domain file too so `pnpm dev` keeps working.
- **Rust layout** (`src-tauri/src/`): `commands/<domain>.rs` are thin IPC handlers; `engine/<domain>.rs`
  holds the logic (mirrors `commands/`); `store/` is SQLite (recents, prefs, view state) at
  `%APPDATA%\Rubrica\rubrica.db`; `protocols.rs` serves custom schemes; `os_integration.rs` covers
  single-instance, Jump List, updater. `src-tauri/API.md` documents the session/engine API.
- **Editing model**: one `DocumentSession` per open file. Every mutation is a `Command` with
  `apply()`/`revert()` (trait objects serialized via `typetag`), which is both undo/redo and the autosave
  journal (`%LOCALAPPDATA%\Rubrica\journal\<doc-hash>.jsonl`, replayed over the last saved file).
  Saves are atomic (temp + fsync + rename, optional `.bak`).
- **Rendering**: 512px PNG tiles at discrete zoom buckets via custom protocols (`rubrica-tile://`,
  `rubrica-thumb://`, `rubrica-print://`), LRU-cached by `(page, zoomBucket, revision)`. On Windows the
  webview reaches them as `http://<scheme>.localhost/…` — always build URLs via `src/ipc/protocolUrl.ts`.
  In-progress drawing is an SVG overlay, committed to the PDF only on release.
- **PDFium** ships as a prebuilt `src-tauri/pdfium/bin/pdfium.dll`; `build.rs` copies it next to the build output.
- **Frontend**: `src/chrome/` (shell, toolbar, tabs, command palette, central shortcut map
  `shortcuts.ts`), `src/viewer/` (tiles, virtualization, selection, search, outline), `src/tools/<tool>/`.
  Tools plug in through `registerTool(...)` in `src/chrome/tool-api.tsx` — see `src/chrome/TOOL-API.md`.
  All shortcuts go through `src/chrome/shortcuts.ts`. State via zustand stores.

## Rules that are easy to break

- **Standard PDF only.** Anything written must be a standard PDF construct; output must re-open in a
  fresh PDFium instance and parse with pdf-lib. An edit that only looks right inside Rubrica is a bug.
- **No AGPL dependencies** (MuPDF, iText, Ghostscript are rejected). Stack stays BSD/MIT/Apache.
- **Local-first**: no network calls except the GitHub Releases updater.
- **i18n**: no hardcoded user-facing strings (enforced by an ESLint i18next rule). Locale files are
  `src/i18n/locales/{pt-PT,en}/<namespace>.json` (pt-PT is default); add keys to both languages.
  Keys are `namespace.section.key`. Code and comments in English.
- **Whiteout ≠ redaction**: whiteout is an opaque `shape` annotation; `redact_apply` actually removes
  objects and rasterizes. Keep them separate in UI and engine.
- Known `pdfium-render` 0.9.3 limitations are intentional v1 boundaries, not bugs to "fix" ad hoc:
  only checkbox form values persist; ellipse/line/arrow are saved as `Stamp` annotations; no non-WinAnsi
  (CJK) text editing (a lower-level call crashes the process); free-text font size/color not persisted.
  See README "Known limitations" and `docs/BACKLOG.md` (which also tracks the release-blocking tile
  rendering bug in the packaged app).
- Commits follow Conventional Commits. Never hand-edit `pnpm-lock.yaml`/`Cargo.lock`; regenerate them.
- `agents/` holds the historical parallel-build briefs and reports (`agents/reports/r*-report.md`);
  they're useful background for why things are the way they are.
