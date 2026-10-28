# R1 — Foundation report (wave 0)

Status: **done**. `pnpm dev` (mock, plain browser), `pnpm tauri dev` (real window), and
`pnpm tauri build --debug` (NSIS bundle) were all run to completion on this machine, not just
assumed to work. Tag `wave-0` follows this report.

## Machine note for whoever reads this next

This dev box had **no Rust toolchain and no MSVC C++ Build Tools** at all before this session —
confirmed with the user before installing rustup (stable-x86_64-pc-windows-msvc) and adding the
"Desktop development with C++" workload to the existing VS2022 Community install. Both work now
(`cargo`, `rustc`, `link.exe`, Windows SDK 10.0.22621/26100 all present). One persistent-shell
quirk: this session's shell processes were spawned before that PATH update, so `cargo`/`rustc`
aren't found without `export PATH="/c/Users/<you>/.cargo/bin:$PATH"` prefixed per command in an
*already-running* shell — irrelevant for CI and for any fresh shell (rustup added it to the user
PATH correctly), just a trap for this specific long-lived session.

## Deliverables (brief items 1–8)

1. **Repo scaffold** — git init on `main` (uncommitted until this report + tag, see bottom).
   pnpm + Vite 6 + React 19 + TS 5.7 strict. Tauri 2.11.5 app; `src-tauri` links
   `pdfium-render` 0.9.3 against a vendored bblanchon Pdfium binary (chromium/8035, non-V8,
   Windows x64). **The smoke test is real and passing**: `src-tauri/tests/pdfium_smoke.rs`
   opens `fixtures/smoke/tiny.pdf` (hand-built, 2 pages, byte-exact via
   `scripts/gen-smoke-fixture.py`) and asserts `pages().len() == 2`.
2. **IPC stubs, complete** — every CONTRACTS §3 command (35 total, 9 domains) exists in
   `src-tauri/src/commands/*.rs`, typed with specta, returning `UNSUPPORTED` — **except**
   `prefs_get/set` and `recents_list/clear` in `commands/app.rs`, which are wired to a real
   SQLite store (see §6 below; the brief explicitly allows this). Both custom protocols
   (`rubrica-tile://`, `rubrica-thumb://`) are registered in `lib.rs` and return a real
   generated placeholder PNG (`engine/tiles.rs`, checkerboard in the markup-red accent, drawn
   once via the `image` crate and cached in a `OnceLock`). All four CONTRACTS §4 events are
   declared (`DocStateChanged`, `SaveStateChanged`, `SearchBatch`, `RecoveryAvailable`) with
   explicit `#[tauri_specta(event_name = "...")]` so wire names match CONTRACTS exactly.
   `src/ipc/bindings.ts` is generated (never hand-edited) via `tests/export_bindings.rs`
   (`pnpm bindings:generate`); `scripts/check-bindings-drift.mjs` (`pnpm bindings:check`)
   regenerates it and fails CI on any diff.
3. **Mock engine** — full CONTRACTS §5 surface in `src/ipc/mock/` (module per domain, plus
   `state.ts` for the shared in-memory registry and `events.ts` for a mock pub/sub bus), over
   two fake documents (5-page text doc, form doc with text/checkbox/radio fields). Real
   undo/redo (whole-document `structuredClone` snapshots), revision bumps, dirty tracking,
   `doc_state_changed` firing on every mutation. `src/ipc/index.ts` picks mock vs. real
   automatically (`VITE_MOCK_ENGINE === '1'` OR `!isTauri()`) — the rest of the app is meant to
   import only from here, never `./bindings` or `./mock` directly. Placeholder tiles/thumbs are
   drawn to an offscreen canvas and returned as `data:` URLs (`mockTileUrl`/`mockThumbUrl` in
   `mock/render.ts`). Demo route at `src/screens/DemoRoute.tsx`, wired into `App.tsx`,
   demonstrates open → render tiles → add highlight annotation → undo → redo → save, driven
   entirely by real events, not direct state pokes — manually click-tested in the browser tool
   (see the mock-engine subagent's verification in conversation history; also re-verified via
   `pnpm typecheck`/`pnpm lint`/`pnpm build` after landing).
4. **i18n infrastructure** — react-i18next, `pt-PT` default + `en` fallback, both loaded
   eagerly via `import.meta.glob` in `src/i18n/index.ts` (new namespace files "just work," no
   further edits needed there). Namespace files at `src/i18n/locales/{pt-PT,en}/*.json`:
   `chrome`, `viewer`, `screens`, `tools-annotate`, `tools-pages`, `tools-forms`,
   `tools-textedit`, `tools-redact` are empty-but-wired (`{}`); `common` is seeded (see
   convention below) and `screens` now has the demo route's own keys.
   `scripts/check-i18n-parity.mjs` (`pnpm i18n:check`) deep-compares key sets across languages
   and is wired into CI. `eslint-plugin-i18next`'s `no-literal-string` rule is active
   repo-wide (`eslint.config.js`), with test files exempted (literal strings in
   render()/assertions aren't user-facing UI).
   **Key convention** (not specified precisely by CONTRACTS, so pin it here for R3/R4/R6): each
   namespace file's top-level JSON key repeats the namespace name, then a section, then the
   leaf — e.g. `common.json` is `{ "common": { "actions": { "save": "..." } } }`, called as
   `t('common:common.actions.save')`. The part after `namespace:` is the literal
   `namespace.section.key` path CONTRACTS §7 describes.
5. **Tokens** — `src/tokens/tokens.css` (Tailwind v4 `@theme`/`@theme inline`, full light+dark
   palettes, markup-red accent `#a3243a`/`#e6808f`) + `tokens.ts` (JS mirror for canvas code) +
   base primitives `src/tokens/components/{Button,IconButton,Dialog,Tooltip,Menu}.tsx` on Radix,
   barrel-exported. No real font files yet (see Deviations).
6. **SQLite store** — `src-tauri/src/store/mod.rs`: bootstraps
   `%APPDATA%\Rubrica\rubrica.db`, `recents`/`prefs` tables, `Store::open/open_at`,
   `prefs_get/set`, `recents_list/upsert/clear`. Self-contained (no dependency on
   `crate::types`, injectable path for tests) — 7 unit tests, all passing. Wired into
   `commands/app.rs` as `tauri::State<Mutex<Store>>`; `lib.rs` opens it once at startup via
   `Store::open()` and `.manage()`s it.
7. **Fixtures + verify script** — `fixtures/{text,unicode,500-page,form,scanned,encrypted,
   corrupt}.pdf`, generated deterministically (`fixtures/generate.mjs` via pdf-lib for the
   first five; `fixtures/gen-encrypted.py` via pypdf for `encrypted.pdf`, since pdf-lib can't
   write PDF encryption). `scripts/verify-pdf.mjs` (`pnpm verify:pdf`) checks the pdf-lib half
   of the portability gate; full rationale and regeneration steps in `fixtures/README.md`.
8. **CI** (`.github/workflows/ci.yml`, `windows-latest`, 3 jobs) — `rust`: rustfmt --check,
   clippy `-D warnings`, `cargo test` (all green locally). `frontend`: lint, typecheck, test,
   i18n parity, bindings drift, fixtures verify, build (all green locally). `tauri-build`:
   `pnpm tauri build --debug`, uploads the NSIS bundle as an artifact — **verified locally**,
   produces `Rubrica_0.1.0_x64-setup.exe`.

## Verified end-to-end, not just assumed

- `cargo test --manifest-path src-tauri/Cargo.toml` — 9 tests (7 store + smoke + bindings
  export), all pass.
- `cargo fmt -- --check` and `cargo clippy --all-targets -- -D warnings` — both clean.
- `pnpm typecheck`, `pnpm lint` (0 errors, 3 pre-existing `react-refresh` warnings in
  Dialog/Menu/Tooltip — harmless, not blocking), `pnpm test` (vitest, 1 file), `pnpm i18n:check`,
  `pnpm bindings:check`, `pnpm verify:pdf`, `pnpm build` — all pass.
- `pnpm tauri dev` — real window compiles and launches (`target\debug\rubrica.exe`), HMR
  connects live. No native-window screenshot tool available to me, so this is process-behavior
  verification (clean compile, clean launch, live HMR round-trip), not a visual check.
- `pnpm tauri build --debug` — full NSIS bundle produced successfully.

## Deviations / contract problems found (per CONTRACTS' own rule: recorded here, not fixed by editing CONTRACTS)

1. **Every `f64` field renders as `number | null` in `bindings.ts`, not plain `number`.** This
   is deliberate, unconditional upstream behavior in `specta-typescript` (their own source
   comment: *"`null` comes from `NaN`, `Infinity` and `-Infinity`... this looks wrong but `f64`
   is the direct equivalent of `number`"*) — not a bug in this setup, and not configurable away.
   Affects every width/height/coordinate/opacity/fontSize/zoom field across the whole API
   surface. In practice these values are never actually `NaN` in Rubrica, but TypeScript will
   still make every call site handle the `| null` branch. Mock engine code already does
   (`?? 0` where needed); wave-1 UI/engine agents should expect this rather than be surprised
   by it. Not fixed by hacking specta — flagging for the human orchestrator to decide whether
   CONTRACTS' `number` sketches should be amended to `number | null`, or whether a future
   custom serializer is worth the complexity (I don't think it is, for wave 0).
2. **`revision` is `u32` in Rust** (not `u64`) — specta forbids exporting `u64`/`i64`/`usize`/
   `i128`/`u128` at all ("BigInt forbidden," precision-loss guard), so a literal `u64` wouldn't
   compile through to TS at all. `u32` (max ~4.29 billion mutations per document) is not a real
   ceiling. `DocInfo.revision`, `MutationResult.revision`, `DocStateChanged.revision` all `u32`.
3. **`AnnotSpec`'s union is 7 separate tagged variants** (`highlight`, `underline`,
   `strikeout`, `ink`, `note`, `shape`, `freeText`), matching CONTRACTS §3's prose literally,
   rather than one collapsed `markup` variant with a `markupKind` field (my first draft, wrong —
   caught before handoff). Discriminant key is `kind` (CONTRACTS doesn't specify the tag name).
4. **`RubricaErrorCode` needed an explicit `SCREAMING_SNAKE_CASE` rename** to produce
   `"ENCRYPTED" | "CORRUPT" | "IO" | "NOT_FOUND" | ...` matching CONTRACTS §2 exactly — Rust's
   default enum serialization would otherwise have produced PascalCase (`"Encrypted"`, ...).
5. **A real, known Tauri-on-Windows bug** (tauri-apps/tauri#13419): `cargo test` on any binary
   that links `tauri::Wry`/`tauri_specta::Builder` types crashes at process start with
   `STATUS_ENTRYPOINT_NOT_FOUND`, because `tauri-build`'s Windows manifest embedding only
   applies to the final app binary (`rustc-link-arg-bins`), not to `cargo test` targets — the
   test binary loads the OS's stub ComCtl5 facade instead of ComCtl6 and a required function
   isn't there. Fixed in `build.rs` per a Tauri maintainer's own workaround: disable
   `tauri-build`'s bins-only manifest (`WindowsAttributes::new_without_app_manifest()`) and
   embed the same manifest (`windows-app-manifest.xml`) ourselves via a bare
   `cargo:rustc-link-arg=/MANIFEST:EMBED` (no `-bins` suffix ⇒ applies to every link target,
   `export_bindings`/`pdfium_smoke` included). **If this breaks again after a tauri-build
   upgrade, this is why** — check whether upstream has finally shipped
   `compile_for_everything` instead of `compile` internally, which would make this workaround
   unnecessary.
6. **Pdfium binds at runtime, not compile time.** `pdfium-render`'s own docs recommend this
   (`Pdfium::bind_to_library`, not static linking) — it's also what makes the portable-exe
   distribution mode (ARCHITECTURE.md) trivial: the dll just needs to sit next to the exe.
   `engine/pdfium.rs::bind()` tries, in order: a Tauri resource dir (production, when an
   `AppHandle` is available — not yet wired anywhere, since nothing calls `bind()` from inside
   a running app yet), the running exe's own directory (covers `tauri dev`, `cargo test`, and a
   portable-exe copy — `build.rs` copies `pdfium.dll` there on every build), then
   `CARGO_MANIFEST_DIR` (dev-only fallback, would NOT work in an installed bundle since that
   path is baked in from the CI build machine — fine, it's tier 3 of 3), then a
   system-installed library as a last resort. **R2**: when you build the real
   `DocumentSession`, call `bind()` once at startup (it uses a process-global `OnceLock`
   internally via `pdfium-render` itself — calling it twice in one process fails with
   `PdfiumLibraryBindingsAlreadyInitialized`; share one `Pdfium` handle, don't rebind per
   document).

## Dependencies added beyond the brief's explicit list (CONTRACTS §10)

- Rust: `thiserror` (ergonomic `RubricaError`), `image` 0.25 default-features=false+["png"]
  (placeholder tile/thumb PNG encoding — R2's own brief already plans to add this for real
  tile rendering, so this just pulls it forward a wave), `specta-typescript` 0.0.12 (the actual
  TS exporter crate paired with `specta`/`tauri-specta` — implied by "tauri-specta+specta" but
  worth naming explicitly since it's a separate crate), `tempfile` (dev-dependency, store
  tests).
- Frontend: `@types/node` (needed for `vite.config.ts`'s `process.env.TAURI_*` reads — standard
  in the official Tauri+Vite template), `@testing-library/user-event` (interaction testing),
  `globals` + `eslint-plugin-i18next` (eslint config plumbing for the CONTRACTS §7 hardcoded-
  string rule). `fast-glob` was added speculatively then removed once unused — check
  `package.json` doesn't need it before adding it back for something else.
- `pdfium.dll` (7.3 MB) and `src-tauri/icons/icon-source.png` are vendored binaries committed
  to the repo, same treatment as any other fixture; see `src-tauri/pdfium/README.md`.

## What the next wave needs to know

- **R2**: `src-tauri/API.md` is yours to write per your own brief — nothing here defines a
  session API yet (`engine/{document,text,history,annotations,pages,forms,textedit,redact}.rs`
  are all one-line placeholder-comment files, intentionally empty). `engine/pdfium.rs` and
  `engine/tiles.rs` (protocol placeholder) are the two real pieces already there — read the
  `AlreadyInitialized` note above before wiring the session. `store/mod.rs` is
  self-contained by design (no `crate::types` import) — your call whether that boundary
  survives once you're doing real cross-cutting session work, but the field-mapping happens in
  `commands/app.rs` today, not in `store` itself.
- **R3**: `src/ipc/mock/{document,render,text,history}.ts` are yours to extend (not rebuild —
  they're fully working already, covering the whole two-fake-doc surface). Same for
  `chrome`/`viewer`/`screens`/`common` locales. `DemoRoute.tsx` is a throwaway wave-0 proof —
  feel free to delete/replace it once real screens exist; `App.tsx` will need updating either
  way. `mock/app.ts` exists (recents/prefs/print/journal) even though CONTRACTS §5's module
  list doesn't name it explicitly — it's not owned by any later wave per the ownership map, so
  it's effectively yours if it needs to change, or flag it back if that's wrong.
- **R4**: `src/ipc/mock/{annotations,pages,forms}.ts` are fully working (annotations persist
  with ids and survive undo/redo; pages ops permute the fake doc; form fields accept values) —
  extend, don't rebuild. Locales `tools-annotate`/`tools-pages`/`tools-forms` are empty and
  waiting for you.
- **Everyone**: `src/ipc/index.ts` is the only place that should ever be imported for
  `commands`/`events` — never `./bindings` or `./mock` directly, so real-vs-mock stays a
  one-line switch. The i18n nesting convention above applies to every namespace you populate.
  Vite's production bundle is ~940 KB / ~180 KB gzip already (all of Radix + i18n + one demo
  screen) — not urgent, but worth code-splitting once real screens/tools land.

## Not done / explicitly out of scope for wave 0

- `doc_open` and every other document-touching command are real `UNSUPPORTED` stubs in Rust —
  by design, that's R2's mission, not this one's.
- No CSP configured (`tauri.conf.json`'s `security.csp` is `null`) — fine for wave 0, R7/R8
  should define one before release (needs to allow the two custom URI schemes at minimum).
- No code signing / auto-updater config — R7's mission (`installer/`, `tauri.conf.json`
  updater block, `.github/workflows/release.yml`).
- Real font files (Bricolage Grotesque / Instrument Sans / JetBrains Mono `.woff2`) don't exist
  yet — `tokens.css` has a ready-to-uncomment `@font-face` template; system-font fallbacks are
  wired everywhere in the meantime so the app already looks reasonable.
