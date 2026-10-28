# Backlog

A deduplicated list of every open item raised across the wave reports (`agents/reports/r1-report.md`
through `r7-report.md`), compiled for the R8 (integration & release) wave. Split into items that
already have a deliberate "ship it this way" decision behind them, and items that are genuinely
still open for someone to pick up.

## Resolved: the PDF viewer never rendered real page content (was RELEASE-BLOCKING)

Found during R8's performance pass (deliverable 2), fixed in the follow-up that landed
`src/ipc/protocolUrl.ts` (see `CHANGELOG.md`'s Unreleased entry). Kept here rather than deleted
because the *shape* of the failure — an app that passed eight waves of tests plus a real-engine e2e
suite while its core function did nothing — is the most important lesson in this file.

**Symptom:** opening any document showed the browser's broken-image icon at every tile position in
the main viewer — and, contrary to R8's "blank/white, might be fine" read, at every rail thumbnail
too: a `PrintWindow` capture of the unfixed binary shows the icon plus the `alt` text ("Página 1")
in each rail slot. R8's Rust-side instrumentation was right: neither `handle_tile_request` nor
`handle_thumb_request` was ever invoked.

**Root cause:** not WebView2, not Tauri's registration, not CSP or the ACL — the frontend. All
three URL builders (`viewer/Tile.tsx`, `chrome/Thumbnail.tsx`, `tools/pages/PagesPanel.tsx`) used
CONTRACTS §3's *logical* spelling, `rubrica-tile://<docId>/...`, as the literal `<img src>`. A
Tauri custom scheme is not reachable under its own name on Windows: `register_uri_scheme_protocol`'s
own docs say the page must request `http://<scheme>.localhost/<path>` there
(`<scheme>://localhost/<path>` on macOS/Linux) — WebView2 can't register a real `rubrica-tile:`
handler, so Tauri maps the scheme onto a WebResourceRequested filter for that synthetic host
instead. Nothing rewrites a literal `rubrica-tile://...` on the way out; WebView2 simply has no
handler for it, the request never leaves the webview, and Rust never hears about it.
`protocols.rs`'s old header comment asserted the opposite ("the frontend's `rubrica-tile://` string
is unaffected; Tauri's own webview-side plumbing performs this rewrite") — that one sentence is
what let every later wave build on the wrong assumption. Tauri's `convertFileSrc(path, protocol)`
helper exists precisely to produce the right form, and the print path
(`chrome/print/printWindow.ts`) was already using it — for a protocol the app never enables; see
the new Correctness item below.

**Fix:** one shared builder, `src/ipc/protocolUrl.ts`, asks `convertFileSrc("", scheme)` for the
platform origin and appends the CONTRACTS path verbatim (passing the whole path through
`convertFileSrc` would percent-encode the `/`s, which `protocols.rs` can't split); the three call
sites import it. `protocols.rs` also now sends `Access-Control-Allow-Origin: *`, so a test can read
tile pixels back across the page/protocol origin boundary.

**Why nothing caught it, and what now does:** no test asserted on image content — every e2e and
component assertion was DOM-structural, layout-derived, or interaction-state-based. Two guards now
exist: `src/ipc/protocolUrl.test.ts` pins the exact URL shape `protocols.rs` parses (and that no
`rubrica-tile://` literal is ever emitted on Windows), and `e2e/specs/09-render.e2e.mjs` opens
`text.pdf` against the real engine and asserts every visible tile and rail/panel thumbnail decodes
(`naturalWidth > 0`), has the `http://rubrica-*.localhost/` form, is a 512×512 / 160px PNG, and —
by fetching one and counting non-white pixels — carries real ink from the page rather than a blank
rectangle. `09-render` is verified passing against the real built app; the fix is also confirmed by
a direct `PrintWindow` capture showing `text.pdf`'s real text where the broken-image icons used to
be.

**Follow-on issue this uncovered — 5 interactive e2e specs fail under `tauri-driver`, and it is a
harness limitation, not an app bug.** With rendering actually happening for the first time, the
five specs that mutate a document and keep interacting with it (`01-annotate`, `02-redact`,
`03-pages`, `04-forms`, `05-textedit`) fail: the WebView2 automation session drops ("browser closed
the connection") shortly after the first mutation's tiles re-render. The non-interactive specs —
`00-smoke`, `06`/`07` recovery, `08-i18n`, and the new `09-render` — pass.

This was chased hard and is now well understood. It is NOT a PDFium threading problem: the
single-PDFium-thread actor below was implemented (all PDFium, commands and rendering and library
init included, now runs on one owner thread) and it did **not** change the outcome. In total, six
threading arrangements were tried — synchronous render on the WebView2 UI thread, a dedicated
render thread, the tokio worker pool (`spawn`), the tokio blocking pool (`spawn_blocking`), the
single-owner actor, and the actor with `FPDF_InitLibrary` also on the owner thread — and all five
specs fail identically in every one. The only build that passes them is one that stubs
`render_tile`/`render_thumb` to a 1×1 PNG (i.e. does no real render work); a build that does the
full real render but returns a 1×1 image still fails. It is independent of image size, thumbnails,
WebView2 GPU flags (`--disable-gpu`), render pacing/throttling, and machine load. The real app is
correct — a native `PrintWindow` capture shows real page text, and `09-render` asserts real tile
and thumbnail pixels — so the conclusion is that `tauri-driver` + WebView2 cannot keep a WebDriver
session alive while the app does real per-tile custom-protocol rendering during active interaction.
This blocks those 5 specs from passing under the current harness regardless of app changes; fixing
it is a harness/automation problem (see the CI note below), not an app one. The 5 specs are left
in place (failing) and documented rather than skipped.

## Accepted v1 limitations

These were each found, verified empirically, and deliberately shipped as-is — not oversights, and
not candidates for a "quick fix" without reopening the underlying design tradeoff. Also listed in
`README.md`'s Known limitations and `CHANGELOG.md`'s [0.1.0] entry.

- **Only checkbox form fields can be saved.** `pdfium-render` 0.9.3 only reliably persists
  checkbox writes; text/radio/combo/listbox setters either silently no-op (text/radio) or don't
  exist at all (combo/listbox). Root-caused to a Field-vs-Widget dictionary write-target bug in
  the crate. Explicitly reviewed and accepted by the human orchestrator on 2026-09-03 (three
  options were presented — accept, fork `pdfium-render`, or file upstream and wait; "accept" was
  chosen). Source: `agents/reports/r5-report.md`.
- **Ellipse/line/arrow shape annotations are PDF `Stamp` annotations**, not native Circle/Line
  annotations — `pdfium-render` 0.9.3 has no API to create the latter, and no raw-FFI fallback
  exists (every handle accessor the crate would need is `pub(crate)`-gated with no exception).
  Visually identical in any conforming viewer; only a PDF inspector reading `/Subtype` would see
  the difference. Source: `agents/reports/r5-report.md`.
- **No CJK (or other non-WinAnsi) text editing.** Every standard PDF font is WinAnsi-family
  single-byte; asking PDFium to encode an out-of-repertoire character was found to crash the
  process outright (no substitute font could have helped, since none of the 14 base fonts go
  beyond WinAnsi). Rubrica has no CJK story anywhere else in the product either. Source:
  `agents/reports/r6-report.md`.
- **No paragraph reflow when editing text in place.** A deliberate scope decision from
  `docs/ARCHITECTURE.md` itself ("the one Acrobat feature not chased"), not a technical
  limitation.
- **Form and text/object edits round-trip losslessly except where the engine literally cannot
  write the value** (see above) — this is the general shape of the "standard PDF only" principle
  working as intended, not a gap.

## Real follow-up work

Genuinely open items — things a future contributor could pick up, roughly in the order they'd
matter for a v1.1 or a hardening pass. No priority ranking beyond the grouping below is implied
within each group; "Correctness / data-integrity" items are more load-bearing than "Polish."

### Correctness / data-integrity

- **`AnnotId` can go stale under concurrent structural edits.** PDFium exposes no persistent
  per-annotation id, so `AnnotId` is `"p{page}a{index}"` — valid only within one session between
  successive `annot_list` calls. A concurrent pages-domain operation (reorder/delete) on a page
  with a selected annotation could shift that index out from under a stale reference. R5 audited
  the real UI flows and found the realistic failure mode today is "selection silently clears"
  (safe) rather than "wrong annotation mutated," because the pages and annotate tools aren't
  interactively active at the same time in the current chrome architecture — but that's a
  property of today's UI wiring, not a guarantee at the engine level. Would need session-level
  annotation identity to close properly. Source: `agents/reports/r5-report.md`.
- **Image objects can't be selected or deleted after placement.** `imageobj_add` doesn't return
  the new object's id (`MutationResult` has no id field — the same gap R4 hit for `annot_add`),
  and unlike text runs there's no `image_objects` getter to diff against. Today the only way to
  remove a just-placed image is undo. Worth a CONTRACTS bump: either have `imageobj_add` return
  the new id, or add an `image_objects` getter mirroring `text_objects`. Source:
  `agents/reports/r6-report.md`.
- **`annot_add` also never returns the new annotation's id** (same shape of gap as above,
  found first). Placing a sticky note currently works around this by diffing `annot_list`
  before/after the add. Source: `agents/reports/r4-report.md`.
- **`freeText`'s text and font size aren't patchable after creation.** `AnnotPatch` has no field
  for either — a free-text box's body/size can only be set at creation time; there's no
  contracted way to edit it afterward short of delete-and-recreate. The toolbar disables text
  editing for a selected free-text box rather than no-op-ing silently. Source:
  `agents/reports/r4-report.md`.
- **`freeText.fontSize`/`.color` are also not persisted at the engine level even at creation
  time** — `pdfium-render` 0.9.3 has no setter for font size in any version, and font color needs
  a Cargo feature this codebase doesn't enable. Every free-text annotation saves at a fixed
  12pt/black. Distinct from the patchability gap above (this one is "can't even set it once").
  Source: `agents/reports/r5-report.md`.
- **`shape:rect`'s stroke width and fill opacity aren't round-tripped.** No public getter/setter
  for `/BS` border width; `/IC` (interior color) has no alpha channel in the PDF spec at all.
  Accepted on write, not persisted back. (The Stamp-based ellipse/line/arrow shapes don't have
  this problem — their stroke/fill live on a real path object with genuine alpha.) Source:
  `agents/reports/r5-report.md`.
- **Radio group option labels are unavailable.** `pdfium-render` 0.9.3 wires up
  `FPDFAnnot_GetOptionLabel` for ComboBox/ListBox but never for RadioButton (a gap the crate
  author left a `// TODO` acknowledging). Radio options currently surface as raw index strings
  ("0", "1", ...) instead of their real labels (e.g. "Solteiro(a)"). A real UX/fidelity loss in
  `RadioFieldEditor.tsx`, distinct from — and additional to — the "radio values can't be saved"
  limitation above. Source: `agents/reports/r5-report.md`.
- **`DocInfo.pages` exposes only post-rotation width/height, never the rotation angle itself.** A
  180° rotation is architecturally invisible to any UI reading only `DocInfo` (width and height
  don't swap for 180°, unlike 90°/270°). The pages tool shows 90°/270° via thumbnail aspect
  ratio; 180° has no visual feedback under the current contract. Source:
  `agents/reports/r4-report.md`.
- **Generated TS bindings claim several `f64` fields are nullable when the real Rust struct
  requires a concrete number — worth a full audit, not just the two instances R8 happened to
  hit.** `StrokeFill.opacity` and `BlankPageSpec.width`/`.height` are all plain (non-`Option`)
  `f64` in `types.rs`, yet `bindings.ts` (freshly regenerated, confirmed no drift against the
  current struct shapes) shows `number | null` for all three — and the *mock* engine's own
  implementations correctly treat a `null` there as "use a sensible default"
  (`mock/pages.ts`: `spec.width ?? 612`), which is almost certainly what led the frontend to
  reasonably (but wrongly, for the real engine) send `null` for "no explicit value." Both call
  sites R8 found this way — drawing an unfilled shape, inserting a blank page — are fixed (send a
  real number instead). Neither the TS binding nor a passing mock-driven test caught this; only
  driving the real engine did. `AnnotSpec::Highlight`/`Underline`/`Strikeout`/`Ink`'s own
  `opacity: f64` fields show the identical pattern in the bindings but are never sent as `null`
  by any current call site — they're fine today, but the same landmine is sitting there for the
  next person who writes a new call site trusting the generated type. Source:
  `agents/reports/r8-report.md`.
- **Home screen's three quick-launch buttons ("Documento de texto de exemplo" / "Formulário de
  exemplo" / "Documento de exemplo com 500 páginas") don't work in the real app.** They call
  `doc_open("demo-text.pdf")` / `"demo-form.pdf"` / `"demo-500-pages.pdf"` (`HomeScreen.tsx`'s
  `QUICK_LAUNCH` list) — bare relative filenames that only the *mock* engine's own
  `resolveDocKindFromPath` convention resolves (any path containing "text"/"form"/"500"/"perf").
  No such files are bundled as Tauri resources (`tauri.conf.json`'s `bundle.resources` lists only
  `pdfium/bin/pdfium.dll`) or synthesized by any Rust command, so `doc_open` fails for all three
  in the shipped app — a first-launch discovery feature that's been non-functional since it was
  built, invisible until R8 tried using it directly (every R8 e2e spec opens fixtures by real
  absolute path instead, via `openByPath`, and so never exercised these buttons). Fix needs
  bundling real PDF files as Tauri resources (matching how `pdfium.dll` itself is already handled)
  and resolving them via the app's resource directory from `HomeScreen.tsx`, rather than a bare
  relative string. Source: `agents/reports/r8-report.md`.
- **Printing loads the hidden print window's page images over a protocol the app never enables.**
  `chrome/print/printWindow.ts` loads each `print_render` PNG via `convertFileSrc(path)` — the
  default `asset://` protocol (`http://asset.localhost/...` on Windows), which Tauri only serves
  when the `tauri` crate's `protocol-asset` feature is on AND `tauri.conf.json` has
  `app.security.assetProtocol.enable: true` with a scope covering the files. Rubrica has neither
  (`Cargo.toml`: `features = []`; no `assetProtocol` key), so in the real app those `<img>`s
  can't load and the printout should come out blank. Same mechanism as the resolved viewer bug
  above — found while fixing it, not yet verified end-to-end (the e2e harness can't drive the
  OS print dialog). Fix: enable the feature plus `assetProtocol` with a scope on
  `%TEMP%\rubrica-print\**` (where `print_render` writes), or serve the rendered pages over a
  `rubrica-tile`-style custom protocol and drop the temp files. Source: the render-bug follow-up.
- **Save As doesn't rebind the open tab's displayed filename.** `CONTRACTS`' `doc_state_changed`
  event carries no `path` field, so after "Save As" the tab keeps showing the original filename
  (e.g. still "text.pdf" after saving to "annotate.pdf") until the document is closed and
  reopened. Found and worked around in every R8 e2e spec that exercises Save As (matches the
  still-displayed original name rather than the saved-as one when closing the tab afterward).
  Fixing it for real needs either a `path` field on `doc_state_changed` or an explicit `DocInfo`
  refetch in `TabsBar.tsx` after a successful Save As. Source: `agents/reports/r8-report.md`.
- **PDFium's cross-thread crash was worked around, never root-caused.** R2 found the vendored
  PDFium build reliably crashes when touched from more than one OS thread — even serialized,
  even against different documents. Fixed at the two points that needed it (locking `doc_open`
  fully, restructuring the Rust test suite to run single-threaded) and confirmed safe under
  Tauri's actual (stable, reused) worker-thread model, but the defect itself lives in a
  closed-source-ish vendored binary and was never traced further. Worth a dedicated
  multi-document stress pass (open several files in quick succession, hammer undo/redo across
  tabs) during hardening. Source: `agents/reports/r2-report.md`.

### Security / platform hardening

- **CSP is still `null`.** `tauri.conf.json`'s `security.csp` was left unset by R1 (wave 0,
  explicitly deferred to R7/R8) and R7 made a deliberate call not to touch it either — a wrong
  CSP fails silently as a blank/broken UI with no visual-verification tool available to catch a
  mistake, so R7 chose to ship nothing over shipping something unverifiable. Needs at minimum an
  allowance for the two custom URI schemes (`rubrica-tile://`, `rubrica-thumb://`). Sources:
  `agents/reports/r1-report.md`, `agents/reports/r7-report.md`.
- ~~**No native file picker.**~~ Done — `tauri-plugin-dialog` is now in `Cargo.toml`, registered
  in `lib.rs`, and permitted (`dialog:allow-open`, `dialog:allow-save`) in
  `src-tauri/capabilities/default.json`. `src/chrome/filePicker.ts` wraps it and degrades to
  `null` wherever no OS dialog exists (mock/browser dev, vitest), so every caller keeps its
  typed-path fallback — which the e2e suite still drives, since WebDriver cannot reach an
  OS-owned window. As predicted, `doc_open(path)` / `doc_save_as(docId, path)` needed no changes.
  The same change split the toolbar's single folder-open "File" menu — which held Save and Save
  As and no way to open anything — into an Open menu (browse + recents), a Save menu (Save /
  Save As), and a Print button. Flagged independently by both R3 and R7. Sources:
  `agents/reports/r3-report.md`, `agents/reports/r7-report.md`.
- **Drag-and-drop capability permissions unverified.** `getCurrentWebview().onDragDropEvent` is
  called unconditionally when running inside Tauri; R3 could not verify against a real window
  (mock-only wave) whether the default capabilities file already permits it. If drag-drop
  silently no-ops in the real app, check capabilities there first. Source:
  `agents/reports/r3-report.md`.
- **Authenticode code signing** — see Post-v1 roadmap below; tracked here too since it's also a
  platform-hardening item, not purely a roadmap feature.

### Settings / UX gaps

- **No Settings toggle for the updater's "check on startup" preference.** The pref
  (`updater.checkOnStartup`) is real, read via `prefs_get`/`prefs_set`, and defaults to on — but
  nothing in `SettingsScreen.tsx` writes it yet. The mechanism honors the pref the instant
  something sets it false; only the UI control is missing. Source: `agents/reports/r7-report.md`.
- **No mock form field is ever `readOnly: true`.** A test-data gap, not a product gap — the
  forms tool's read-only handling is covered by component-level tests with fabricated fields
  rather than the real-mock-IPC integration test, since the shared mock fixture (owned outside
  this wave) never exercises it. Source: `agents/reports/r4-report.md`.
- ~~**`journal_recover`'s UI reading was never exercised against a real journal.**~~ Done — R8's
  e2e recovery scenario (kill mid-edit, relaunch, replay) found and fixed a real bug here: the
  backend's `recovery_available` event fires inside Tauri's `setup()` hook, before the WebView2
  JS runtime has loaded the page or mounted `RecoveryDialog.tsx`'s listener. That's a
  100%-reproducible miss on every real launch (confirmed against a fully manual, non-automated
  launch, not just under test automation) — not the timing race it might look like. Fixed by
  also querying `journal_recover(null)` directly on mount, which has no such ordering dependency.
  "Open and recover"/"Not now" themselves needed no changes; R3's read of CONTRACTS/ARCHITECTURE
  was correct. Source: `agents/reports/r3-report.md`; fixed in `agents/reports/r8-report.md`.

### Performance / rendering

- **DONE (correctness win, but did not fix the e2e): all PDFium is now confined to one thread.**
  `SessionStore` was changed from `Mutex<HashMap<DocId, DocumentSession>>` to an actor — one
  long-lived `rubrica-pdfium` owner thread owns the registry, and every command/handler runs its
  PDFium work through `SessionStore::with_store`/`with_session` (see `engine::document`), so
  `doc_open`, all rendering (via the render thread), text extraction/search, mutations, saves, the
  drop of each `PdfDocument`, and even `FPDF_InitLibrary` all run on that single thread. This closes
  the real multi-thread PDFium hazard `agents/reports/r2-report.md` documents (the "PDFium's
  cross-thread crash was worked around" item in Correctness). It was adversarially reviewed (no
  deadlocks / drop-off-thread / behavioral drift beyond one trivial `print_render` edge case, since
  fixed). **However, it did NOT make the 5 interactive e2e specs pass** — that failure is a
  `tauri-driver`/WebView2 harness limitation, not a PDFium threading problem (see the "Follow-on
  issue" paragraph in the resolved section at the top of this file for the full six-arrangements
  investigation). The remaining open work here is therefore on the harness, not the app:
  - **CI's e2e job cannot even attach a WebDriver session** (a separate, pre-existing failure from
    the interactive-spec issue). On `windows-latest` (WebView2 152) every spec fails at
    `POST /session` with "session not created: Chrome instance exited" / a 30 s timeout — the app
    launches (its jump-list log line appears) but `msedgedriver` never attaches, so the suite is
    0/9 in CI regardless of any app change. Likely a `tauri-driver`/WebView2/`msedgedriver`
    version-detection or runner-environment issue (`e2e/lib/webview2.mjs` reads the Runtime version
    from the registry; the runner's actual WebView2 may differ). Needs push-and-observe CI iteration
    to fix; not reproducible locally, where sessions attach fine.
  - **Even with attach fixed, the 5 interactive specs need the harness to survive real rendering.**
    Options to explore: a WebDriver-resilient wrapper that reconnects a dropped session; driving the
    app a different way (e.g. Chrome DevTools Protocol directly, or a non-`tauri-driver` harness);
    or accepting those flows as covered by unit/component tests plus the `09-render` pixel guard and
    marking them non-CI. Source: the render-bug follow-up.

- **Tile/thumbnail rendering runs off the UI thread, on one dedicated `rubrica-render` thread**
  (`protocols.rs`, `register_asynchronous_uri_scheme_protocol`), so a tile burst no longer stalls
  input/IPC on WebView2's UI thread. Two smaller notes on top of that: (1) the debug build's PNG
  encode was ~10× slower than release (unoptimized `png`/`miniz_oxide`), addressed by opt-level'ing
  just those codec crates in `[profile.dev.package.*]` (`Cargo.toml`) — a debug convenience, no
  effect on the shipped app; (2) opening `text.pdf` renders the page's tiles twice (once at the
  initial zoom bucket, once at the fit-to-width bucket it settles on), visible in a render trace —
  worth having the viewer settle its zoom before the first tile request to halve the open-time
  render work. `render_thumb` is also still uncached (`engine::tiles`), so every revision bump
  re-renders each rail thumbnail's full page; an LRU there (like `TileCache`) would cut the
  per-mutation render burst. Source: the render-bug follow-up.

### Polish / cosmetic

- **Real font files (Bricolage Grotesque / Instrument Sans / JetBrains Mono) still don't exist.**
  Flagged in R1's wave-0 report and never picked up since — `tokens.css` has ready-to-uncomment
  `@font-face` rules waiting for `.woff2` files under `src/tokens/fonts/`; system-font fallbacks
  are used everywhere in the meantime (confirmed still true as of this check — no `.woff2` files
  anywhere in the repo). Source: `agents/reports/r1-report.md` (restated, unresolved, in
  `agents/reports/r3-report.md`).
- **No visual confirmation of the taskbar Jump List UI or the SmartScreen warning screen
  itself.** Both were verified indirectly (fresh `customDestinations-ms` files on disk, documented
  Windows behavior) since no tool in R7's environment could drive live Windows shell chrome.
  Worth a real look during manual release testing. Source: `agents/reports/r7-report.md`.
- **`release.yml` has never been run end-to-end.** Needs a pushed tag and a human with repo-admin
  access to add the `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` secrets first (see
  `docs/INSTALL.md`'s "Update signing" section). Everything it does was verified piecewise
  (`tauri-action`'s own build-and-sign step was reproduced locally). A rehearsal tag is the
  natural next step for whoever has repo access. Source: `agents/reports/r7-report.md`.

### Search (left out of search v2, `agents/SEARCH-ORCHESTRATION.md` §3)

- **Out of scope by decision:** semantic/AI search, OCR of scanned PDFs (`scanned.pdf` still
  finds nothing, with a clear "no searchable text" message), regex, searching several documents
  at once, saved searches.
- **Diacritics folding covers Latin-1 and Latin Extended-A only** (U+00C0–017F plus combining
  marks): enough for Portuguese and Western European text, not for Vietnamese and other scripts.
  Swapping in full NFD is local to `normalize::strip_diacritic`. Source: `agents/reports/s3-report.md`.
- **A proximity window or phrase continues onto the next page only**, never further: two terms
  four pages apart are never one zone, whatever the window. Source: `agents/reports/s3-report.md`.
- **The 30 px density-map strip is always reserved** (even without results), so fit-width never
  re-zooms while typing; revisit if the margin bothers users. Source: `agents/reports/s7-report.md`.
- **Header/footer detection relies on the 8 % bands**: a running line just outside them is body
  text (the 500-page fixture's label only qualifies by intersecting the band). Source:
  `agents/reports/s5-report.md`.

## Post-v1 roadmap

In this explicit order, per `docs/ARCHITECTURE.md`'s "Deferred past v1" section:

1. **Visual signatures** (drawn or imported stamp). The first feature planned after v1.
2. **A "send to DoItAllTool" handoff** — passing the current document to DoItAllTool for the
   batch/conversion-shaped work Rubrica itself will never do (OCR, compression, format
   conversion).
3. **The Authenticode code-signing decision.** Currently deferred; the installer ships unsigned,
   and Windows SmartScreen shows a first-run warning as a result (see `docs/INSTALL.md`'s "About
   the SmartScreen warning" section). Revisit once there's a certificate/budget decision to make.

Further out, and explicitly **never** planned regardless of how far past v1 the roadmap goes (per
`docs/ARCHITECTURE.md`): OCR, compression, or format conversion (those stay in DoItAllTool's
scope permanently), form *creation*, or anything cloud-based. Qualified digital signatures
(Cartão de Cidadão / Chave Móvel Digital, PKCS#11) are noted in ARCHITECTURE.md as a possible
future project of their own, separate from and after visual signatures — not part of the
numbered list above because it was never given a firm position in it, unlike items 1–3.
