# R7 — Windows citizenship report (wave 2)

Status: **done**. Executed solo rather than via the SA-1..SA-4 subagent split the brief sketches —
every deliverable touches the same handful of shared files (`tauri.conf.json`, `lib.rs`,
`Cargo.toml`), so splitting it across isolated worktrees would have meant a nontrivial merge pass
for no real parallelism benefit (see R4's own report on worktree-base drift for how that can go
wrong). Everything below was built, then **actually run** on this Windows machine — installed,
launched, uninstalled, relaunched, portable-tested — not just compiled. Where a claim below says
"verified", it means a real `Get-Process`/registry/filesystem check backed it, not an assumption.

## Deliverables (brief items 1–6)

1. **NSIS installer + portable .exe.** `tauri.conf.json`'s `bundle.windows.nsis.installMode` is
   `"currentUser"` (no admin prompt, installs to `%LOCALAPPDATA%\Rubrica`) with a language
   selector (`Portuguese` — NSIS's name for pt-PT, matching the app's own default — plus
   `English`). Portable mode is a `portable.txt` marker file sitting next to the exe
   (`main.rs::redirect_portable_app_data`, checked once before `rubrica_lib::run()`): when
   present, it redirects the process's own `APPDATA`/`LOCALAPPDATA` env vars to a `data\` folder
   created next to the exe, before `store::Store::open`/`engine::journal` — both frozen,
   untouched files — ever read them. No new IPC, no touched session-core file. **Verified**:
   installed silently (`/S`), confirmed the app's files land under
   `%LOCALAPPDATA%\Rubrica`; separately ran a release-profile exe from a `C:\tmp` folder with a
   `portable.txt` beside it and confirmed it created `data\Roaming\Rubrica\rubrica.db` *there*
   while the real profile's `%APPDATA%\Rubrica` stayed untouched (byte-for-byte unchanged
   `LastWriteTime` across the run).
2. **File association (capability, not default).** `installer/hooks.nsh`, merged in via
   `installerHooks`. Deliberately **not** `tauri.conf.json`'s own `bundle.fileAssociations` —
   that feature's `APP_ASSOCIATE` macro (vendored `FileAssociation.nsh`) writes `.pdf`'s raw
   `Classes` default value directly, which *does* silently make Rubrica the default PDF handler
   on a machine with no prior default — exactly what the brief says never to do. Instead,
   hand-written NSIS writes the same `RegisteredApplications`/`Capabilities`/`OpenWithProgids`
   scheme Windows' own Default Programs picker is built on (the same pattern Chrome/Firefox use
   for "available but not default"), and never touches `.pdf`'s own default value. Single-instance
   routing: `tauri-plugin-single-instance` (registered first, per its own requirement) plus
   `os_integration.rs`'s `handle_relaunch`, which focuses the running window and forwards a
   relaunch's file argument as the same ad hoc `rubrica://open-file` event a cold start uses.
   **Verified end-to-end, not just compiled**: after a real silent install, launched
   `rubrica.exe "fixtures\text.pdf"`, then launched `rubrica.exe "fixtures\form.pdf"` a few
   seconds later — process count stayed at **1** the whole time (same PID, same start time — no
   second process ever spawned), and `SELECT * FROM recents` against the real
   `%APPDATA%\Rubrica\rubrica.db` afterward showed **both** files, each via a real `doc_open` call
   (not a mock), a few seconds apart. Registry after install: `HKCU\Software\Classes\Rubrica.PDF`
   present with the right `shell\open\command`, `.pdf\OpenWithProgids\Rubrica.PDF` added
   alongside the machine's existing entries (GIMP, a UWP app) without disturbing them, and
   `HKCU\Software\Classes\.pdf`'s own default value **untouched** (no `(default)` value at all —
   confirmed by direct registry read).
3. **Jump list.** `os_integration.rs` builds it via raw COM (`windows` crate: `ICustomDestinationList`,
   `IShellLinkW`, `IPropertyStore`/`PKEY_Title` for each item's label — `SetDescription` alone
   isn't what Explorer reads for a Jump List item's text) — a "Recent" category from
   `Store::recents_list()` (already-`.manage()`d, read-only from here, no changes to `store/
   mod.rs`) plus a "New window" task. Refreshed once at startup and again on every
   `doc_state_changed` event (listened to as a plain Tauri event by name — no change to the
   frozen specta event surface). Every COM call is best-effort: a failure anywhere logs to
   stderr and is swallowed, never crashes the app. **Verified twice**: (a) an isolated standalone
   probe (`cargo build`+`run` in a scratch crate, not part of the repo) confirmed the exact COM
   call sequence produces a real `%APPDATA%\...\CustomDestinations\<hash>.customDestinations-ms`
   file *before* writing any of this into `os_integration.rs`; (b) after that code was integrated
   and the real app run, a **new** `customDestinations-ms` file appeared within ~10 seconds of
   launching `rubrica.exe`, matching the timing exactly, with no other explanation available (no
   other app was touched in that window). "New window" task: launching the installed exe with
   `--new-window` while already running did **not** spawn a second process (single-instance still
   caught it) but **did** open a second top-level window — confirmed by enumerating this
   process's own visible windows via `user32!EnumWindows` and seeing two windows titled "Rubrica"
   (plus the single-instance plugin's own hidden message window) where there was one before.
   No visual confirmation of the *taskbar UI itself* was possible (no tool here can right-click a
   live taskbar icon) — the above is the strongest verification available short of that.
4. **Auto-update.** `tauri-plugin-updater`, configured against
   `https://github.com/flipgouveia/Rubrica/releases/latest/download/latest.json`
   (`windows.installMode: "passive"`). A fresh signing keypair was generated
   (`pnpm tauri signer generate`, password-protected) — the **public** half's content is in
   `tauri.conf.json`'s `plugins.updater.pubkey` (safe to commit); the **private** half lives only
   at `.secrets/rubrica-updater.key` (gitignored, confirmed via `git status` it was never staged)
   and must be added as the `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   GitHub Actions secrets before a release can be signed — see `docs/INSTALL.md`'s "Update
   signing" section; **I cannot add repository secrets myself**, so this is the one manual step
   left for a human with repo admin access. `bundle.createUpdaterArtifacts` is deliberately
   **not** in the base `tauri.conf.json` — it's only in the new
   `src-tauri/tauri.release.conf.json`, merged in solely by `release.yml` via `--config` — so
   every contributor's plain `pnpm tauri build` and `ci.yml`'s unmodified debug-bundle job never
   need the signing secret at all (**verified**: `pnpm tauri build --debug` with no
   `TAURI_SIGNING_*` env vars set succeeded both before and after this change, several times).
   Locally verified the signing path itself works: with
   `TAURI_SIGNING_PRIVATE_KEY_PATH`/`_PASSWORD` set to the generated key,
   `pnpm tauri build --config src-tauri/tauri.release.conf.json` produced a real
   `Rubrica_0.1.0_x64-setup.exe.sig` alongside the installer (see "Verified end-to-end" below for
   the exact run). Frontend: `check()`/`downloadAndInstall()` from `@tauri-apps/plugin-updater`
   called directly (not through `src/ipc`, which CONTRACTS freezes) from a new
   `src/chrome/updaterCheck.ts`, gated on a `updater.checkOnStartup` pref (default on, via the
   *existing* `prefs_get`/`prefs_set` commands — no new IPC). Consent gesture: a toast (via R3's
   existing `pushToast`) with an "Install and restart" button — see "A second `src/**` touchpoint"
   below for why `toastStore.ts`/`ToastHost.tsx` needed a small additive change to support that
   button at all. Portable build: the updater plugin is **never registered** when
   `os_integration::is_portable()` is true, so the frontend's `check()` call rejects (unknown
   command) rather than reaching the network or offering to overwrite a copy it doesn't own the
   location of — this is "disabled cleanly", not just hidden in the UI.
5. **Release pipeline.** `.github/workflows/release.yml`, triggered on `v*` tags:
   `tauri-apps/tauri-action` builds the signed NSIS installer, drafts a GitHub Release named after
   the tag with generated notes, and uploads the installer + its `.sig` + a generated
   `latest.json` (the exact URL `plugins.updater.endpoints` already points at). A second step
   assembles the portable `.zip` (the release-profile exe + `pdfium.dll` + an empty `portable.txt`)
   and attaches it to the same draft via `gh release upload`. `ci.yml` is **completely untouched**
   — it keeps producing an unsigned debug NSIS bundle on every push/PR exactly as before, on its
   own schedule, unrelated to this pipeline. Not runnable end-to-end from here (no way to push a
   tag or hold GitHub secrets in this environment) — the local signing test above is the closest
   substitute; a rehearsal tag is the next step for whoever has repo access (see below).
6. **Docs.** `docs/INSTALL.md` — install, portable mode, file association (with the "we never
   force a default" framing spelled out for end users, not just in code comments), update
   behavior, the honest SmartScreen note, plus a "maintainers" section covering key handling and
   cutting a release.

## A real bug found and fixed: the autosave journal survives uninstall

With `installMode: "currentUser"`, `$INSTDIR` **is** `%LOCALAPPDATA%\Rubrica` — the exact same
folder CONTRACTS §8 puts the autosave journal in (`%LOCALAPPDATA%\Rubrica\journal\`). The stock
NSIS template's uninstall section only `Delete`s the specific files it knows it installed, then
does one plain (non-recursive) `RMDir "$INSTDIR"` — which silently no-ops if anything else is
still in that folder. The journal directory is written by the *running app*, not the installer, so
it's invisible to that file list, and a real install → launch → uninstall rehearsal confirmed
`%LOCALAPPDATA%\Rubrica` (with an empty `journal\` inside) was left behind after every uninstall.
Fixed with a `NSIS_HOOK_PREUNINSTALL` in `installer/hooks.nsh` that removes
`$INSTDIR\journal` unconditionally (crash-recovery scratch state, not user data, so it isn't
gated on the "delete app data" checkbox) *before* the stock template's own file deletions run —
confirmed fixed by repeating the same install → launch → uninstall cycle and seeing
`%LOCALAPPDATA%\Rubrica` gone afterward. `engine/journal.rs`'s own path (CONTRACTS §8, frozen) was
not touched — this is installer-side cleanup only.

## Deviations / contract interpretations (recorded per CONTRACTS' own rule)

1. **A second `src/**` touchpoint beyond the pre-approved file-open listener.** The brief
   pre-approves exactly one: "a minimal file-open event listener wiring point" (delivered as
   `src/chrome/fileOpenEvents.ts` + two lines in `main.tsx`). Deliverable 4's own wording — "never
   auto-install without consent" — cannot be satisfied by Rust/config alone; some UI has to ask.
   Rather than reach for an unstyled, un-i18n'd `window.confirm()` (which would dodge the
   `src/**` restriction on paper but sit badly with how much every other wave here cared about
   i18n and UI consistency), this wave made one more small, additive, backward-compatible
   extension: `Toast` gained optional `actionLabel`/`onAction` fields
   (`src/chrome/toastStore.ts`), `ToastHost.tsx` renders an action button when they're present,
   and two real `pt-PT`/`en` keys were added to the shared `common.json` (parity-checked,
   authored properly, not machine-sounding). `src/chrome/updaterCheck.ts` is the new file that
   uses all of it. I believe this is squarely inside the brief's own "a minimal wiring point...
   agreed via report" allowance, but it's flagged here explicitly rather than silently expanding
   scope, exactly as that clause asks.
2. **No Settings UI toggle for "check on startup".** The pref (`updater.checkOnStartup`) is real,
   read via the existing `prefs_get`/`prefs_set` commands, and defaults to on — but nothing writes
   it yet (`SettingsScreen.tsx` is R3's file, and adding a checkbox there is a bigger UI change
   than this wave's allowance covers). The mechanism honors the pref the moment something sets it
   false. Flagging this for R3/R8, the same way R3 itself flagged the missing native file picker
   for R7/R8 in its own report — a real gap, not a design choice.
3. **CSP left untouched.** R1's report explicitly asked R7/R8 to define one (`security.csp` is
   still `null`). I made a deliberate call not to: the app has no visual verification tool
   available here for a native Tauri window (R1 and R2's reports note the same gap for their own
   verification), and a wrong CSP fails *silently* as a blank/broken UI, not a crash — I could not
   have caught a mistake here the way I caught everything else in this report. Given it's not one
   of this brief's 6 listed deliverables, I chose not to ship something risky I can't verify over
   shipping nothing. Still open for R7/R8 (or whoever can drive a real browser devtools session
   against the built app) to pick up.
4. **`rust-version` bumped `1.77` → `1.77.2`.** `tauri-plugin-process` (briefly added, then
   removed — see below) needed it; left in place since it's a no-op given the installed toolchain
   (1.98) and doesn't affect anything else.

## A dependency added, then removed: `tauri-plugin-process`

Tauri's own docs show the updater's Windows flow using `@tauri-apps/plugin-process`'s `relaunch()`
after `downloadAndInstall()`. Added it, then read `@tauri-apps/plugin-updater`'s own TypeScript
doc comment more carefully: *"Windows: This function exits the app after launching the updater
installer successfully"* — `downloadAndInstall()` itself already exits Rubrica once the (passive)
installer has launched, and the installer's own completion relaunches it. A separate relaunch
plugin would be dead weight (and one more capability/permission surface) for a step Windows'
installer already performs. Removed cleanly — confirmed zero references left in `Cargo.toml`,
`Cargo.lock`, or `package.json`.

## Dependencies added

- Rust: `tauri-plugin-single-instance`, `tauri-plugin-updater` (brief's own suggested list);
  `windows` (`Win32_UI_Shell`, `Win32_UI_Shell_Common`, `Win32_UI_Shell_PropertiesSystem`,
  `Win32_Storage_EnhancedStorage`, `Win32_System_Com`, `Win32_Foundation`) for the Jump List COM
  calls — brief's own "windows-rs helpers for jump list if needed".
- Frontend: `@tauri-apps/plugin-updater` (its own JS bindings, invoked directly, not through
  `src/ipc`).
- `installer/hooks.nsh` reuses `FileAssociation.nsh`'s `UPDATEFILEASSOC`-adjacent
  `SHChangeNotify` call pattern but not its `APP_ASSOCIATE` macro itself (see Deliverable 2).

## Verified end-to-end, not just assumed

- `cargo fmt -- --check`, `cargo clippy --lib --all-targets -- -D warnings`, `cargo test --lib`
  (12 tests: 5 new `os_integration` tests + the 7 pre-existing store tests) — all clean.
  `cargo test` (full suite incl. `engine_fixtures`/`export_bindings`/`pdfium_smoke`) — all green,
  nothing regressed.
- `pnpm typecheck`, `pnpm lint` (0 errors; same pre-existing `react-refresh` warnings R1 already
  flagged as harmless, nothing new), `pnpm test` (104 tests, 19 files), `pnpm i18n:check` (9
  namespaces, pt-PT/en parity holds), `pnpm bindings:check` (no drift — this wave never touched
  CONTRACTS' command/event surface), `pnpm build` — all pass.
- `pnpm tauri build --debug`: real NSIS bundle, `installer/hooks.nsh` compiles into it cleanly
  (a syntax error there would have failed `makensis` loudly — it didn't).
- **A full real install/uninstall rehearsal**, silent (`/S`) end to end on this machine:
  installed → registry capability keys confirmed correct (and `.pdf`'s own default confirmed
  untouched) → launched with a file argument → launched again with a different file argument
  while running (single-instance confirmed: process count never left 1) → confirmed both files
  landed in the real SQLite `recents` table via real `doc_open` calls → confirmed a Jump List
  file was freshly written → uninstalled silently → confirmed the install directory (including
  the journal-survives-uninstall bug above) was fully gone → confirmed `%APPDATA%\Rubrica` (the
  SQLite store) survived, matching the unchecked-by-default "delete app data" checkbox.
- **A portable-mode rehearsal**: assembled a release-profile exe + `pdfium.dll` + `portable.txt`
  in an isolated `C:\tmp` folder (outside the repo, so no accidental relative-path coincidences),
  ran it with a file argument, and confirmed its SQLite store landed at
  `<that folder>\data\Roaming\Rubrica\rubrica.db` while the real profile's own
  `%APPDATA%\Rubrica` was untouched throughout.
- **A "New window" Jump List task rehearsal**: launched the installed exe once, then again with
  `--new-window` — single-instance still caught it (no second process), and `EnumWindows` showed
  a genuine second top-level window had opened in the same process.
- **Signing rehearsal**: with the generated (non-shared, gitignored) private key exported as
  `TAURI_SIGNING_PRIVATE_KEY_PATH`/`_PASSWORD`, `pnpm tauri build --config
  src-tauri/tauri.release.conf.json` (the exact override `release.yml` uses) produced a real
  `.sig` file alongside the installer.
- The dev machine was left clean after every rehearsal above — nothing installed, no stray
  `%APPDATA%\Rubrica`/`%LOCALAPPDATA%\Rubrica`, no lingering `rubrica.exe` processes, no scratch
  files under `C:\tmp`.

## Not done / explicitly out of scope for this wave

- The actual `release.yml` pipeline was never run for real (that needs a pushed tag and, first, a
  human with repo-admin access adding the two signing secrets — see `docs/INSTALL.md`). Everything
  it does was verified piecewise instead (`tauri-action`'s own `tauri build --config ...` call is
  exactly what was tested locally above).
- No visual confirmation of the taskbar Jump List UI itself, or of SmartScreen's actual warning
  screen — no tool here can drive the live Windows shell chrome or a fresh-reputation download
  prompt; both are described from documented Windows behavior plus the strongest indirect
  evidence available (fresh `customDestinations-ms` files, the INSTALL.md SmartScreen note).
- CSP (see Deviations #3), a Settings toggle for the update-check pref (Deviations #2), and a
  native file picker (R3's own flag, not this brief's deliverable) all remain open for a future
  wave.
- Authenticode code signing stays deferred, per `docs/ARCHITECTURE.md`'s own explicit decision —
  `docs/INSTALL.md` explains the resulting SmartScreen prompt rather than working around it.
