# Contributing to Rubrica

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

- **Bugs and ideas:** open an [issue](https://github.com/flipgouveia/Rubrica/issues). For a bug,
  say what you did, what you expected, and — if you can share it — attach the PDF.
- **Security problems:** please don't open a public issue; use
  [private vulnerability reporting](https://github.com/flipgouveia/Rubrica/security/advisories/new).
- **Pull requests:** open them against `main`. Every PR needs CI to pass, and the maintainer
  reviews and merges. For anything bigger than a small fix, open an issue first so we can agree
  on the approach.

## Ground rules

These are what make Rubrica what it is, so PRs that break them can't be merged:

1. **Local-first.** Every feature works offline. The only network call is the optional update
   check against GitHub Releases.
2. **Standard PDF only.** Everything Rubrica writes must be a standard PDF construct that opens
   correctly in Acrobat, browsers and phones. *An edit that only looks right inside Rubrica is a
   bug.*
3. **No AGPL dependencies.** The whole stack stays BSD/MIT/Apache.
4. **No hardcoded UI text.** Every user-facing string goes through i18n, in both `pt-PT` and `en`
   (`src/i18n/locales/`). An ESLint rule and `pnpm i18n:check` enforce this.
5. Code and comments in English; commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## Development setup

**Prerequisites:**

- Rust (stable, MSVC toolchain) + the Tauri 2 prerequisites for Windows (WebView2, which ships
  with Windows 11; "Desktop development with C++" via Visual Studio Build Tools)
- Node 22.x and pnpm 9.x

```bash
pnpm install
```

From here there are two ways to run the app:

- **`pnpm dev`** — a plain browser dev server (Vite) against a TypeScript mock engine (fake
  documents). No Rust toolchain needed; handy for UI work.
- **`pnpm tauri dev`** — the real native Windows app, backed by the real Rust/PDFium engine, with
  hot reload on the frontend.

Other useful scripts (see `package.json`):

| Script | What it does |
|---|---|
| `pnpm build` | Type-checks and builds the frontend (`tsc -b && vite build`) |
| `pnpm tauri build` | Builds the full native app (add `--debug` for a debug bundle) |
| `pnpm lint` | ESLint over the whole repo (includes the hardcoded-UI-string rule) |
| `pnpm typecheck` | `tsc -b --noEmit` |
| `pnpm test` | Vitest (frontend unit/integration tests) |
| `pnpm i18n:check` | Verifies pt-PT/en locale key parity across every namespace |
| `pnpm bindings:check` | Fails if `src/ipc/bindings.ts` has drifted from the Rust command surface |
| `pnpm bindings:generate` | Regenerates `src/ipc/bindings.ts` from the Rust side (tauri-specta) |
| `pnpm verify:pdf` | Parses every fixture PDF with pdf-lib — half of the portability gate |
| `pnpm e2e` | End-to-end suite against a built app (see `e2e/`) |

Rust-side checks (run from `src-tauri/`, or via `cargo ... --manifest-path src-tauri/Cargo.toml`):
`cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.

## How the code is organised

The UI never talks to PDFium directly — every document mutation goes through Tauri IPC to a Rust
core that owns the PDFium handle. `src/ipc/index.ts` picks the mock or the real engine
automatically (mock when not running inside Tauri, or when `VITE_MOCK_ENGINE=1`), so the same UI
code runs against either backend unchanged. The IPC bindings are generated from Rust — never edit
`src/ipc/bindings.ts` by hand.

Further reading:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the design and why PDFium was chosen
- [`agents/CONTRACTS.md`](agents/CONTRACTS.md) — the IPC contract and conventions
- [`src/chrome/TOOL-API.md`](src/chrome/TOOL-API.md) — how a tool plugs into the UI
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — known issues and planned work
- [`docs/PORTABILITY-CHECKLIST.md`](docs/PORTABILITY-CHECKLIST.md) — the manual release check
