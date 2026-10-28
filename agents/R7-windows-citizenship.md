# R7 — Windows citizenship (wave 2)

## Mission

Make Rubrica a real Windows application: installer, portable build, file association, jump list,
auto-update. Everything here is packaging and OS integration — you change no document behavior.

## Read first

`agents/CONTRACTS.md` (§1, §8), `docs/ARCHITECTURE.md` (distribution decisions), R1's and R2's
reports (build/bundling notes).

## Owns / must not touch

Owns: `installer/`, `src-tauri/tauri.conf.json`, app icons, updater configuration,
`.github/workflows/release.yml`. Small, clearly-scoped hooks in `src-tauri` for OS integration
(single-instance, jump list, file-open events) are allowed in a dedicated
`src-tauri/src/os_integration.rs` — nothing else in `src-tauri`, and never the session core.
Must not touch: `src/**` except a minimal file-open event listener wiring point agreed via
report if one doesn't already exist.

## Deliverables

1. **NSIS installer + portable .exe** via Tauri bundler: per-user install (no admin), proper
   app icon set, uninstaller clean (leaves user documents alone; asks about `%APPDATA%\Rubrica`).
2. **File association**: `.pdf` "Open with" registration (per-user, never force-default —
   Windows lets the user choose the default; register capability + friendly name + icon);
   opening a file when Rubrica is already running routes to the existing instance as a new tab
   (single-instance plugin + file-open event).
3. **Jump list**: recent documents (from the SQLite recents) + "New window" task.
4. **Auto-update**: Tauri updater against GitHub Releases (signed update manifests with the
   updater's own keypair — generate and document key handling; this is NOT Authenticode, which
   stays deferred), user-controlled check ("check on startup" pref, default on; never
   auto-install without consent), disabled cleanly in the portable build.
5. **Release pipeline**: `.github/workflows/release.yml` — on tag: build both bundles on
   `windows-latest`, attach to a draft GitHub Release with generated notes; CI keeps producing
   debug bundles per push.
6. **Docs**: `docs/INSTALL.md` — install, portable mode, update behavior, association setup,
   and the honest SmartScreen note (unsigned binaries warn; how to proceed; Authenticode is a
   future purchase decision).

## Dependencies you may add

`tauri-plugin-single-instance`, `tauri-plugin-updater`, windows-rs helpers for jump list if
needed.

## Subagent plan

- SA-1: bundling (NSIS + portable) + icons + uninstall behavior.
- SA-2: association + single-instance + open-into-tab routing.
- SA-3: updater + release workflow + key handling docs.
- SA-4: jump list + INSTALL.md.
- Keep for yourself: end-to-end install/update rehearsal on a clean Windows VM or sandbox.

## Definition of done

- Clean machine (Windows Sandbox is fine): install → double-click a PDF → opens in Rubrica;
  second PDF opens as a tab in the same window; uninstall leaves documents untouched.
- Portable .exe runs from a USB-style folder with updater disabled.
- A rehearsal tag produces a draft release with both artifacts; an old build detects and
  installs the update after user consent.
- Write `agents/reports/r7-report.md`.
