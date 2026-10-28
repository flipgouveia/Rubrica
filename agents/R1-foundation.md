# R1 — Foundation (wave 0, runs alone, blocks everyone)

## Mission

Create the repository and transcribe `agents/CONTRACTS.md` into compiling reality: a Tauri 2 app
that boots, the **entire IPC surface stubbed in Rust** with generated TS bindings, and a working
**mock engine** so wave-1 UI agents develop in a plain browser. Your priority is unblocking three
agents, not building features. Anything not needed by wave 1 is out of scope.

## Read first

`docs/ARCHITECTURE.md`, `agents/CONTRACTS.md` (you implement it verbatim), `agents/README.md`.

## Deliverables

1. **Repo scaffold**: git init on `main`; pnpm + Vite + React 19 + TS strict; Tauri 2 app that
   builds and opens a window on Windows; `src-tauri` with `pdfium-render` compiled and linked
   against bblanchon prebuilt PDFium (a smoke test opens a tiny fixture PDF and reads its page
   count — proving the hardest build problem of the project is solved on day 0).
2. **IPC stubs, complete** (CONTRACTS §3–§4, §6): every command in every domain module exists,
   typed with specta, returning `UNSUPPORTED` (except `doc_open` on the smoke path if trivial);
   both custom protocols registered returning a placeholder PNG; all events declared;
   `src/ipc/bindings.ts` generated + CI drift check.
3. **Mock engine** (CONTRACTS §5): full surface over the two fake documents, revision bumps,
   undo/redo, canvas-drawn fake tiles/thumbs; auto-active outside Tauri. A demo route proving
   open → render tiles → annotate (mock) → undo works in a plain browser.
4. **i18n infrastructure** (CONTRACTS §7): react-i18next, pt-PT + en, namespace files created
   empty-but-wired, key-parity CI check, eslint rule against hardcoded UI strings.
5. **Tokens** (`src/tokens/`): the CONTRACTS §7 identity — fonts, markup-red accent, full
   light + dark themes — plus a handful of base primitives (Button, IconButton, Dialog,
   Tooltip, Menu) so wave 1 doesn't reinvent them divergently.
6. **SQLite store skeleton** (CONTRACTS §8): db bootstrap, `prefs_get/set` and `recents_list`
   actually working (they're trivial and everyone needs them).
7. **Fixtures + verify script** (CONTRACTS §9): assemble the corpus (generate what you can:
   text, unicode, 500-page, AcroForm via pdf-lib script; source scanned/encrypted/corrupt
   fixtures deterministically) and `scripts/verify-pdf.mjs`.
8. **CI** (`windows-latest`): rustfmt + clippy `-D warnings` + cargo test; pnpm lint/typecheck/
   test/build; bindings drift check; i18n parity check; tauri build (debug bundle) as artifact.

## Dependencies you may add

`pdfium-render`, `tauri-specta`+`specta`, `rusqlite`, `serde`; `react-i18next`+`i18next`,
`@radix-ui/*`, `tailwindcss@4`, `zustand` (UI state), `pdf-lib` (fixture generation + verify
script, dev only).

## Subagent plan

- SA-1: Tauri+pdfium build bring-up + protocols + smoke test (the risk item — start first).
- SA-2: command stubs + specta bindings + CI drift check.
- SA-3: mock engine + demo route.
- SA-4: i18n + tokens + base primitives.
- SA-5: fixtures + verify script + SQLite skeleton.
- Keep for yourself: wiring, CI, final review that stubs/mock/bindings agree exactly.

## Definition of done

- `pnpm dev` (browser, mock) shows the demo route working; `pnpm tauri dev` opens the real
  window with the pdfium smoke test green.
- CI fully green on `windows-latest`, including a debug bundle artifact.
- All CONTRACTS §3 commands present in bindings; mock covers all of them.
- Write `agents/reports/r1-report.md`. Tag `wave-0`.
