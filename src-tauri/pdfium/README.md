# Vendored Pdfium

`bin/pdfium.dll` is the prebuilt, non-V8 Windows x64 release from
[bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries), tag `chromium/8035`.
MIT-licensed wrapper (`LICENSE-pdfium-binaries.txt`) around Google's BSD-3-Clause Pdfium
(`LICENSE-pdfium.txt`) — no AGPL, per `docs/ARCHITECTURE.md`.

`pdfium-render` binds to it at runtime (see `src-tauri/src/engine/pdfium.rs`), not at compile
time — there is nothing to statically link. `build.rs` copies the dll next to every build output
(`target/<profile>/` and `target/<profile>/deps/`) so `cargo test`, `cargo run`, and `tauri dev`
all find it by convention (same folder as the running executable). The installed NSIS bundle and
the portable .exe instead get it via `bundle.resources` in `tauri.conf.json`.

## Updating

1. Download the latest non-V8 `pdfium-win-x64.tgz` from the
   [releases page](https://github.com/bblanchon/pdfium-binaries/releases).
2. Replace `bin/pdfium.dll`, `LICENSE-pdfium-binaries.txt` (`LICENSE` in the archive),
   `LICENSE-pdfium.txt` (`licenses/pdfium.txt` in the archive), and `VERSION`.
3. Re-run the fixture and engine test suites — Pdfium releases occasionally change edge-case
   behaviour (form rendering, font substitution).

We use the plain (non-V8) build: Rubrica never executes PDF JavaScript, so the V8 build's extra
~9 MB buys nothing.
