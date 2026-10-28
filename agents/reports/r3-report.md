# R3 — Viewer & shell UI report (wave 1)

Status: **done**. Built entirely against the mock engine in a plain browser
(`pnpm dev`, no `VITE_MOCK_ENGINE=1` needed — a plain browser already resolves to mock per
`src/ipc/index.ts`), verified interactively via the browser tool at every step below, not just
assumed to work. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm i18n:check`, and `pnpm build`
all pass clean.

## TOOL-API.md — published first, as required

`src/chrome/TOOL-API.md` was written before any chrome/viewer component, matching the real code
in `src/chrome/tool-api.tsx` and `src/chrome/shortcuts.ts` (the doc describes what the code does,
not a proposal). Five extension points: `toolbarEntry`, `panel`, `overlayLayer` (+
`overlayAlwaysOn`), `railExtension`, `shortcuts`/`paletteCommands`. Key pieces R4/R6 need:

- `registerTool(def)` — idempotent by `id`, HMR-safe, returns an unregister function.
- `PageViewport.toScreen/toDoc` — the one place the PDF-point↔CSS-pixel flip lives; every
  overlay/rail/panel author gets it from `viewport`, never hand-rolls it.
- `useActiveTool`/`setActiveTool`/`toggleTool`, `useToolbarTools`, `useOverlayTools`,
  `useActiveToolPanel`, `useActiveRailExtension`, `usePaletteCommands`.
- `src/chrome/shortcuts.ts`: single global registry (`registerShortcut`, `listShortcuts`,
  `useShortcutList`, `formatCombo`), form-field-aware dispatch, dev-time duplicate detection for
  `"always"`-scope collisions. `registerTool` forwards a tool's `shortcuts` here automatically.
- `src/chrome/errors.tsx`: `useRubricaErrorMessage()` + `<ErrorDialog>` — the one place
  `RubricaError` becomes localized copy; tools should use this rather than another error-code
  switch.
- `App.tsx` has a one-line comment marking where a future tool package's top-level import goes
  (no tool packages exist yet this wave, so nothing to import).

## Deliverables (brief items 1–7)

1. **Viewer surface** (`src/viewer/`): `ViewerSurface.tsx` virtualizes the page list with
   `@tanstack/react-virtual` (re-measures on zoom change, `scrollToIndex` for jump-to-page).
   `TileLayer.tsx`/`Tile.tsx` compose 512px tiles per the render protocol, always requesting the
   nearest zoom bucket `>=` the continuous UI zoom and CSS-scaling the result — zoom feels
   continuous (pinch/ctrl-wheel both work; `onWheel` handles ctrl-wheel, zoom buttons/menu handle
   the rest) while tile requests stay keyed to the contract's 8 buckets. Selection
   (`src/viewer/selection/`): mouse drag hit-tests char boxes from `text_page_layout` via
   `nearestCharIndex` (pure, tested), supports **cross-page drags** via
   `document.elementFromPoint`, keyboard extension (Shift+Left/Right, Ctrl+A select-page,
   Escape, Ctrl+C copy — registered through the shared shortcut map), and renders one highlight
   rect per text row (`buildHighlightRects`, pure, tested) rather than per character. Search
   (`src/viewer/search/`): debounced `text_search_start`/`cancel`, live `search_batch`
   accumulation into a page-ordered flat list, next/prev with wraparound, clickable hit list,
   distinct active-vs-other highlight color. Night mode (`nightModeStore.ts`): `invert`/`sepia`
   CSS filter over the tile layer only (never touches selection/search/tool overlays), persisted
   via `prefs_get/set`, toggle in toolbar + default style in Settings. Verified smooth against
   the mock's synthetic tile latency up to page ~498 of the 500-page fixture (see Mock upkeep).
2. **Chrome** (`src/chrome/`): `Toolbar.tsx` (Home nav, File menu with Save/Save As/Print,
   undo/redo bound to `history_*` + live `history_state`, zoom controls incl. a bucket-percentage
   menu, search/night-mode/command-palette/settings toggles, per-registered-tool toolbar
   buttons), `TabsBar.tsx` (dirty dot, close-with-unsaved-changes confirm via `ConfirmDialog`),
   `ThumbnailRail.tsx` (view-only, virtualized, click-to-scroll, auto-follows the current page,
   `railExtension` slot for R4), `CommandPalette.tsx` (Ctrl+K, built-ins + every registered
   tool's implicit "activate" entry + `paletteCommands`), `shortcuts.ts` (documented above).
3. **Screens** (`src/screens/`): `HomeScreen.tsx` (recents grid via `recents_list`, quick-launch
   for the mock's three fixtures, typed-path fallback since a native file picker needs
   `tauri-plugin-dialog` registered in `src-tauri/**` — out of scope, see Deviations — real
   Tauri drag-drop via `getCurrentWebview().onDragDropEvent`, browser-DnD fallback for the mock),
   `SettingsScreen.tsx` (language pt-PT/en switches `i18n.changeLanguage` live, theme
   system/light/dark toggles `data-theme`, night-mode default, `.bak` toggle, and a **live**
   shortcut list read straight from the shortcut registry), `RecoveryDialog.tsx` (on
   `recovery_available`; see Deviations for the "no discard command" interpretation).
4. **Print flow**: `PrintDialog.tsx` (all/current/custom range) always calls the real
   `print_render(docId, pages, dpi)` per contract; `printWindow.ts` builds a detached, zero-size
   `<iframe>` (DOM APIs only, no `doc.write(templateString)`) and calls `print()` on it. In mock
   mode the preview image substitutes a tile placeholder since the mock has no real filesystem
   for `print_render`'s returned paths (documented limitation, same seam pattern as `mockTileUrl`
   elsewhere) — the IPC call itself is exercised identically to how the real engine will use it.
5. **Error surfaces**: `useRubricaErrorMessage`/`ErrorDialog` cover every `RubricaErrorCode`
   including dedicated encrypted/corrupt copy; `ToastHost`/`pushToast` for non-blocking notices
   (print failures, etc).
6. **Mock upkeep**: extended (not rebuilt) `mock/{document,render,text,history}.ts` per the
   ownership note. Added a third fake document, `mock-perf-doc` (500 uniform pages), resolved by
   any path containing `"500"` or `"perf"` — `resolveDocKindFromPath` documents the convention.
   Added `mockTileUrlAsync`/`mockThumbUrlAsync` with a small synthetic latency + resolved-URL
   cache (`src/ipc/mock/render.ts`) so the viewer is built against genuinely async tile loading
   instead of the instant synchronous draw — this is what the brief's "smooth 500-page behavior
   against the mock's synthetic latency" is exercised against. `Tile.tsx`/`Thumbnail.tsx` are
   the per-item components that resolve these asynchronously (kept out of `TileLayer`'s
   `.map()` deliberately — that loop's length changes with zoom, which would violate
   rules-of-hooks if the per-tile async state lived there).
7. **Tests** (36 tests, 7 files, `pnpm test` green): selection math
   (`selectionStore.test.ts`, `nearestCharIndex.test.ts`, `highlightRects.test.ts` — all pure,
   no React needed), search-hit navigation (`searchStore.test.ts` — streaming accumulation,
   stale-search-id rejection, wraparound), tab lifecycle (`viewer/store.test.ts` — dedup on
   re-open, active-tab reassignment on close, pending-scroll signal). One real end-to-end
   integration test (`src/test/integration.test.tsx`) drives **open → scroll → search → copy →
   close** through the actual rendered `<App/>` against the real mock engine — nothing stubbed
   or spied. jsdom has no layout engine, so `src/test/setup.ts` gained a few narrow, documented
   shims (fixed `clientWidth/Height`/`getBoundingClientRect` so `@tanstack/react-virtual`
   actually renders rows instead of virtualizing everything away against a 0×0 viewport;
   `ResizeObserver`/pointer-capture/`scrollIntoView` stubs Radix and the fit-width effect need;
   a `getContext` stub so the mock's canvas-drawn placeholders degrade quietly instead of
   spamming jsdom's "not implemented" logger). "Scroll" in the integration test is driven by
   clicking a real thumbnail-rail row (exercising the same `scrollToPage` path real scrolling
   uses); "copy" asserts the underlying `text_extract_range` call directly rather than the
   browser clipboard API, which jsdom doesn't implement.

## A real bug caught before it shipped

Manual browser testing (not just the automated suite) caught a genuine **infinite-render loop**:
`shortcuts.ts`'s `listShortcuts()` returned a fresh `Array.from(...)` on every call, which
`useShortcutList`'s `useSyncExternalStore` requires to be referentially stable — React's own
"getSnapshot should be cached" diagnostic fired, and opening Settings crashed to a blank screen.
Fixed by caching the array and invalidating only on actual register/unregister. Left as a
cautionary note: **the automated test suite did not catch this** (no test rendered
`SettingsScreen`) — it was found only by clicking through the app in the browser tool, which is
why that step wasn't skipped despite the mock/component tests already being green.

## Deviations / contract gaps found (recorded per CONTRACTS' own rule, not fixed by editing it)

1. **No native file picker.** Real file selection needs `tauri-plugin-dialog` added to
   `Cargo.toml`, registered in `lib.rs`, and permitted in `src-tauri/capabilities/default.json`
   — all `src-tauri/**`, which this brief forbids R3 from touching. `HomeScreen`'s "Open" is a
   typed path (still a fully correct `doc_open(path)` call, just not ergonomic) plus quick-launch
   buttons for the mock's fixtures. **Flagging for R7/R8**: someone needs to add that plugin and
   wire a real picker before v1 ships; R3's `doc_open` call site needs no changes when it lands.
2. **Drag-drop capability gap, unverified.** `getCurrentWebview().onDragDropEvent` is called
   unconditionally when `isTauri()` — this is core `@tauri-apps/api`, no plugin needed, but I
   could not verify against a real Tauri window this wave (mock-only UI work) whether the
   default `src-tauri/capabilities/default.json` (R1-authored, off-limits to me) already permits
   it. If drag-drop silently no-ops in the real app, check capabilities there first.
3. **`journal_recover` is a query, not an apply step**, and CONTRACTS has no "discard journal"
   command. Per ARCHITECTURE.md ("autosave journal replays committed commands over the last
   saved copy"), I read replay as happening inside the engine's own `doc_open` — so
   `RecoveryDialog`'s "Open and recover" is a plain `doc_open(path)`, and "Not now" just
   dismisses the dialog (the journal stays on disk, per CONTRACTS §8's "deleted on clean save").
   Never exercised against a real journal this wave (mock's `journal_recover` always reports
   unavailable, by design) — R2/R8 should double check this reading once a real journal exists.
4. **Print preview in mock mode substitutes a tile placeholder for `print_render`'s output.**
   The command itself is called exactly per contract (`printRender(docId, pages, dpi)` → temp
   paths) so the real engine integration is a no-op change; only the `<img>` source in the
   generated print `<iframe>` branches on `isMockEngine` (same pattern as every other
   mock/real seam in this codebase).
5. **`pnpm bindings:check` not verified this session** — this dev shell has no `cargo` on PATH
   (the same pre-existing shell quirk R1's report flagged: rustup updated the *user* PATH, but
   long-lived shell processes from before that update don't see it). Irrelevant to risk here:
   R3 never touches `src-tauri/**` or `src/ipc/bindings.ts`, so there's nothing for it to drift
   from. CI (fresh shell) isn't affected.

## Dependencies added beyond the brief's explicit list

None beyond what the brief already named: `@tanstack/react-virtual` and `lucide-react`
(brief's "Dependencies you may add"). `testing-library`/`jsdom` were already present from R1.

## What the next wave needs to know

- **R4**: `TOOL-API.md` is real and load-bearing — read it before touching chrome mounting.
  `useToolbarTools`/`useOverlayTools`/`useActiveRailExtension`/`usePaletteCommands` are the
  hooks your components get rendered through; you shouldn't need to touch
  `AppShell.tsx`/`Toolbar.tsx`/`ThumbnailRail.tsx` at all — register and the slots pick you up.
  Only one `railExtension` is meaningfully supported at a time in the rendering (whichever
  tool is `activeTool`); that's almost certainly just your pages tool, but flag it back if two
  tools need rail presence simultaneously. `src/ipc/mock/{document,render,text,history}.ts`
  gained a third fake doc (`mock-perf-doc`, `DocKind = "perf"`) — if your annotation/page/form
  mocks ever need to branch on `DocKind`, there are now three, not two.
- **R6**: your text-edit/redact tool overlays get `PageViewport` the same way annotate/pages/
  forms do — `viewport.toScreen`/`toDoc` already handle the PDF-point flip, no separate
  coordinate math needed for your in-place editor's overlay positioning.
- **R7/R8**: native file dialog (`tauri-plugin-dialog`) and drag-drop capability permissions
  (item 1–2 above) are real gaps for the release checklist, not just style choices.
- **Everyone**: `src/chrome/errors.tsx`'s `useRubricaErrorMessage`/`ErrorDialog` and
  `src/chrome/toastStore.ts`'s `pushToast` are the shared error/notice surfaces — please reuse
  rather than re-implement per-tool error UI. i18n key convention from R1 continues unchanged;
  `chrome`/`viewer`/`screens`/`common` are fully populated (pt-PT authored directly, not
  machine-translated from the English, then English written to match) — `tools-*` namespaces
  are still `{}`, waiting on you.

## Not done / explicitly out of scope for this wave

- No tool packages exist yet (`src/tools/**` is R4/R6's, wave 1/2) — the toolbar's tool cluster,
  overlay stack, rail extension, and command-palette extra-commands are all empty in a fresh
  checkout of this wave; they're proven working structurally (registration API, hooks, rendering
  slots) but have nothing registered to show yet.
- Real font files still don't exist (R1's note, unchanged) — system-font fallbacks throughout.
- No native file picker / verified drag-drop capability (see Deviations 1–2).
