# S2 report: search UI (React), Phase 1

Branch: `worktree-agent-ad88240e96315b7f4`, based on `d7cb658` (`chore(contracts): search v1.1.0`).
Scope: B1-B10, B12 and the `textless` state (B11 belongs to S1).

## B1-B12 status

"Failing first" evidence: the tests in `src/viewer/search/SearchPanel.test.tsx` were written before any
implementation and run against the F1.0 code. Most of them also needed the new test ids, so to make the
evidence about behaviour and not about a missing `data-testid`, I temporarily added two ids
(`search-count`, `search-close`) to the old `SearchPanel.tsx`, re-ran, and reverted. The failures below
are from that run (old behaviour, new ids).

| Bug | Status | Test (all in `SearchPanel.test.tsx` unless noted) | What failed on the F1.0 code |
|---|---|---|---|
| B1 race | Not reproducible on F1.0 (already fixed by construction: client-minted `searchId`, adopted before the await). Regression test added. | `B1 ... renders hits that arrive while the command promise is still pending`; `searchStore.test.ts` "keeps a batch that was emitted for an id adopted before the command resolved" | Passes on F1.0, as expected. It emits a batch from inside `textSearchStart` before it resolves and asserts the hits are kept. |
| B2 (UI) per-hit count | Fixed | `B2 ... counts a match that wraps across two lines once`; `searchStore.test.ts` "counts a hit with several rects once" | `data-total` was 10 (2 rects x 5 pages) instead of 5. |
| B3 cancel on close | Fixed | `B3 ... close button mid-search`, `... closed inside the debounce window`, `... unmounts`; `B8 ... Esc cancels a search that is still running` | `textSearchCancel` never called on close/unmount; `textSearchStart` still fired once, 250ms after the panel was closed (debounce timer not cleared). |
| B4 stale after edit | Fixed | `B4 ... re-runs on doc_state_changed and hides the old hits meanwhile` | `textSearchStart` called 1 time, expected 2: no re-search when `revision` changes. |
| B5 scroll to rect | Fixed | `B5 ... scrolls the viewer so a hit on page 3 is visible`, `... keeps the hit below the compact bar`; `store.test.ts` `computeRectScroll (...)` (7 tests) | `scrollTop` stayed 0 (expected > 1000); a hit 20px from the top stayed 18px from the top (needs >= 56 with the bar). |
| B6 virtualized list + context | Fixed | `B6 ... mounts a handful of rows for thousands of hits, with page and context` | Old list: no accessible list name, one `li` per hit, label "Página N" without context. Mounting 3000 hits now renders < 100 rows, each with "p. N" and before `<mark>`matched`</mark>` after (2-line clamp). |
| B7 identity by index | Fixed | `B7 ... keeps the same hit active when a batch for an earlier page arrives later`, `... outlines every rect of the active hit and only the active hit`; `searchStore.test.ts` | Old active identity was `flat[i].rect === rect` (object reference) and an index into a flat list that re-orders: after a late earlier-page batch the active hit moved to another one; wrapped hits outlined only one rect. Now `{page, hitIndex}`. |
| B8 keyboard | Fixed | `B8 ... Enter / Shift+Enter / F3 / Shift+F3 ... Esc`, `Esc cancels a search that is still running`, `Ctrl+F on an open panel focuses the field and selects its text`, `Ctrl+F opens the compact bar and Ctrl+Shift+F opens the docked panel`; `shortcuts.collisions.test.tsx` (new test) | Ctrl+F on an open panel did not move focus/select; Shift+Enter, F3, Esc, Ctrl+Shift+F did nothing. |
| B9 per-document state | Fixed | `B9 ... keeps query and results when switching tabs and coming back` | Old code closed the panel on tab change, so the input was gone and the query lost. |
| B10 progress (UI) | Fixed | `B10 ... shows 'página X de N' and a thin progress bar while searching` | Old UI only said "A pesquisar…". Now "A pesquisar… página X de N · M resultados" plus `role="progressbar"`. |
| textless | Fixed | `textless ... shows the no-searchable-text message instead of 'sem resultados'` (+ a control test) | Old UI said "Sem resultados". |
| B12 never cover the page | Fixed | `B12 ... renders the compact bar floating and the docked panel as a 370px column`, `... resizes with the keyboard, clamped to 300..520px`, `... remembers the last mode used`; `dockedFitWidth.test.tsx` | Old panel was `absolute right-4 top-4 w-80` over the page. |

Test totals: 22 component tests + 16 store tests (rewritten) + 7 `computeRectScroll` tests + 1 fit-width test
+ 1 new collisions test.

## How it is built

- `searchStore.ts`: per-document state (`byDoc`), hits as `{page, hitIndex}`, `activateNonce` so re-activating
  the same hit still scrolls, mode (`compact`/`docked`) and panel width (300..520, default 370) are global.
  The toolbar keeps working: top-level `isOpen` mirrors the focused document, `open(docId)` still exists.
- `searchController.ts`: IPC lifecycle outside React (mint id, adopt before await, cancel, debounce, revision
  in the search key, listener for `search_batch`, cleanup of closed tabs, `prefs` for `search.lastMode` and
  `search.panelWidth`).
- `SearchPanel.tsx` (wiring + shortcuts), `SearchBar.tsx` (compact), `SearchDock.tsx` (docked + resize
  handle with pointer and keyboard), `SearchResultsList.tsx` (`@tanstack/react-virtual`), `SearchParts.tsx`,
  `searchLabels.ts`, `scrollToHit.ts`.
- `viewer/store.ts`: `computeRectScroll` (pure geometry that mirrors `ViewerSurface`'s layout) + tests.
- `AppShell.tsx`: comment only. The compact bar sits in a zero-width slot at the viewer's right edge (so it
  never lands on the tool panel); the docked panel is a flex sibling, so the viewer shrinks. `ViewerSurface`'s
  existing `ResizeObserver` recomputes fit-to-width (pinned by `dockedFitWidth.test.tsx`), and I verified it in
  a browser against the mock engine (zoom went 175% to 115% when the panel opened).
- `e2e/lib/search.mjs`: reads `data-total`/`data-done`/`data-query` from `[data-testid="search-count"]`, closes
  through `[data-testid="search-close"]`. Exported API unchanged (`openSearch`, `searchAndCountHits`,
  `closeSearch`). Not run (needs the Tauri build); the three consuming specs were read for compatibility.

Stable test ids: `search-panel` (root, both modes, with `data-mode`), `search-input`, `search-count`
(`data-total`, `data-done`, `data-query`), `search-close`, `search-results`.

## Decisions that need your attention

1. **Ctrl+Shift+F collided with the Forms tool.** `src/tools/forms/index.ts` already bound `mod+shift+f` to
   "activate Forms" (an "always" shortcut), so the collisions test failed the moment the docked-panel shortcut
   was added. I rebound Forms to `mod+alt+f` (one-line change in a file outside my ownership) rather than
   weaken the test or ignore the brief. **`README.md` line 122 still says Ctrl+Shift+F for Forms** and needs
   updating, and the orchestrator may prefer a different combo. Ctrl+Alt is AltGr on some layouts.
2. **Escape** is registered with `scope: "tool-active"` because "clear selection" already owns Escape as an
   "always" shortcut. `shortcuts.ts` fires every handler bound to a combo regardless of scope, so both run.
   The collisions test asserts this deliberate pair.
3. **`src/test/integration.test.tsx`** (not on my list) had to change: it expected "Página N" buttons right
   after typing, but the default Ctrl+F surface is now the compact bar, which has no list. It now clicks the
   expand button first. Everything else in it is untouched.
4. **`ViewerSurface.tsx` is not mine**, so B5 is implemented without touching it: `scrollToHit.ts` finds the
   visible `[data-testid="viewer-scroll"]` (not inside `[hidden]`) and sets `scrollTop`/`scrollLeft` from
   `computeRectScroll`. `VIEWER_PAGE_GAP`/`VIEWER_PADDING` are duplicated in `store.ts` and must match the
   constants in `ViewerSurface.tsx`. A cleaner follow-up would be a `pendingScrollRect` consumed by
   `ViewerSurface`, with those constants exported from one place.

## i18n keys still needed

- `viewer.shortcuts.searchClose` (en + pt-PT, e.g. "Close search" / "Fechar a pesquisa"). The Escape shortcut
  currently uses `viewer.search.close` ("Fechar (Esc)") as its `labelKey`.

No other keys were missing.

## Deviations from the mockup

- Compact bar has no Aa / ab| toggles (as in the mockup state 0); they are in the docked panel only, so
  case/whole-word cannot be changed from the one-line bar.
- Compact bar while searching shows "N resultados" (or "A pesquisar…") and a 2px progress line along its
  bottom edge, not the full "página X de N" text: the 420px bar has no room for it. The docked panel shows
  the full text and the 3px bar, as in state B.
- No-text message in compact mode is a small card under the bar (state F is drawn inside the panel only). It
  is the one case where compact UI can sit over part of the page at very narrow widths.
- Right offset of the bar is 40px (mockup 42px) to leave room for the future density map.
- Result rows are fixed-height (58px) so the virtualizer needs no measuring; phase-2 group headers will need
  variable rows.
- Footer key hints use the literal key names "Enter", "Shift+Enter", "Esc" (not translated).

## New bugs / observations

- **`SearchHighlights` leaked across tabs** (found while rewriting it): it read the single global search
  state, so every mounted tab (hidden ones too) drew the active tab's hits. It now reads the page's own
  `viewport.docId` state.
- **Suspected, not verified:** at zoom above fit-width the page is wider than the scroller and
  `justify-center` overflows both sides, so the left part of the page cannot be scrolled to. Not touched
  (ViewerSurface is not mine). `computeRectScroll` clamps `scrollLeft` to >= 0 and cannot fix it.
- After an edit (B4) the re-search resets the active hit to the first result and scrolls there. Restoring the
  previous position would be nicer; left for later.
- `e2e/specs/05-textedit.e2e.mjs` presses Escape before Save As: Escape now also closes an open search (harmless).
- Searches keep running in the background when you switch tabs (their results land in that document's
  state); closing a tab cancels and drops its search.

## Commands run (worktree, PowerShell, Node 22, pnpm 9.15)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | OK |
| `pnpm lint --ignore-pattern ".claude/**"` | 0 errors, 4 warnings (existing `react-refresh` warnings in `errors.tsx`, `Dialog.tsx`, `Menu.tsx`, `Tooltip.tsx`) |
| `pnpm typecheck` | OK |
| `pnpm test` | 30 files, 193 tests passed (the search component suite alone takes ~15s because it drives the mock engine in real time) |
| `pnpm i18n:check` | OK, 9 namespaces match |
| `pnpm build` | OK (existing chunk-size warning only) |
| Browser check (vite dev + mock engine, 1280x800) | Compact bar over the margin, expand to docked panel (viewer 175% to 115%), list rows clamp to 2 lines, clicking a result scrolls and centres the hit. Found and fixed the `line-clamp` being disabled on a grid item. |

Not run: `pnpm e2e`, `pnpm tauri build` (need the real app), Rust checks (no Rust changes).
