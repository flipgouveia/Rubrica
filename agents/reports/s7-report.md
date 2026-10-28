# S7 - density map and outline side panel (React)

Branch: `worktree-agent-a1ac398c6fba752e4` (fast-forwarded onto `search/phase-2` first: the worktree was cut from the phase-1 merge, which has no `selectors.ts`/`outlineStore.ts`).

## What was built

| Piece | Files |
|---|---|
| Density map component | `src/viewer/search/DensityMap.tsx` |
| Its pure model (buckets, opacity, ticks, viewport rect, marker, hit-testing) | `src/viewer/search/DensityMapModel.tsx` |
| Outline tree panel | `src/viewer/outline/OutlinePanel.tsx`, `outlineModel.ts` |
| Remembered side-panel tab (`ui.sidePanelTab` via `prefs_get/prefs_set`) | `src/viewer/outline/sidePanelTabStore.ts` |
| Side panel with tabs "Miniaturas" / "Indice" | `src/chrome/SidePanel.tsx`, mounted in `AppShell.tsx` in place of the bare `ThumbnailRail` |
| Strip mount | `src/viewer/ViewerSurface.tsx` |

Search state is read only through `selectors.ts` (`useHasResults`, `useHitCountsByPage`, `useHitCountsByOutlineItem`, `useActiveHit`, `useResultKind`, `activateFirstHitFrom`); `outlineStore.ts` is used, not edited. `searchStore.ts` is not imported by any production file I wrote.

### Against the mockup
- Density map: 30px strip, `border-l` + surface at 85 %, track inset 8px, accent buckets with `log(1+n)` opacity, 1px `border-strong` chapter ticks that overhang the track by 8px, `text`-coloured 1.5px viewport rectangle at 55 % opacity, amber (`--search-active`) triangle at the active hit, inverted-colour tooltip (`bg-text`/`text-background`) to the left of the strip. Same geometry values as the mockup's CSS.
- Outline panel: tabs row, rows with chevron, title, accent count pill, right-aligned page number, depth indentation (16px per level), 3px accent bar + 10 % accent background on the current entry, bold titles for top-level entries that hold hits.
- Checked visually in `pnpm vite` against the mock book document (search "contrato": strip, ticks, viewport rectangle, active triangle, tooltip "p. 7 · 3 resultados · 2.2 Por incumprimento", Indice tab with counts 6/10/6, click-to-navigate, current entry following scroll). Not checked: light theme, and the real Tauri build (not built).

## Layout decision: the strip and fit-width
**The 30px are always reserved**, with or without results (`DensityMap` renders an empty `w-[30px]` gutter when `useHasResults` is false). Reserving only while visible would resize the scroller every time a keystroke flips "has results" (typing a query that momentarily has no hits), and `ViewerSurface`'s fit-width ResizeObserver would re-zoom the document each time. The cost is a permanent 30px of margin (about 2.5 % of zoom at 1200px). The strip is a sibling of the scroll element (new wrapper `flex h-full min-w-0 flex-1`), so it never scrolls and `viewer-scroll` still measures only the scroller. `dockedFitWidth.test.tsx` and all other viewer tests stay green; `ViewerSurface.test.tsx` pins the structure.

The compact search bar (`SearchBar`, `right-10`) already leaves 40px at the right, so it does not cover the strip.

## Bucket algorithm
- Track height measured by a ResizeObserver (fallback 600px). `pagesPerBucket = max(1, ceil(pageCount / trackPx))`: one bucket per page until the document has more pages than the track has pixels, then runs of pages.
- Only non-empty buckets exist (pages without hits, including everything outside the search scope, draw nothing). Count = sum of hits that start on its pages.
- Opacity = `0.25 + 0.75 * log(1+n) / log(1+max)` (the mockup's formula; the floor keeps a lone hit visible next to a dense one).
- Chapter ticks: depth-0 entries with a page > 0, as page/pageCount.
- Viewport rectangle: computed in page units (prefix sums of `height * zoom + gap`, binary search, same constants as `ViewerSurface`/`store.ts`), so it is right for mixed page sizes; follows the scroller's `scroll` event and resize.
- Active marker: middle of the active hit's page.
- Pointer: nearest bucket within 4px for hover/click; clicking empty strip behaves like a scrollbar (`activateFirstHitFrom(docId, pageUnderPointer)`); clicking a bucket uses its first page.
- Tooltip: `viewer.density.tooltip` / `tooltipChapter`; unit by `useResultKind` (zonas/resultados, pluralised by count); chapter = `deepestItemForPage(items, bucket.fromPage)`, omitted without an outline (empty, loading or error) or for pages the outline does not cover.

## Accessibility
- The picture is `role="img"` with `viewer.density.summary` (total, first/last page, densest page; unit by mode). Because an image's children are presentational, the keyboard alternative is a **sibling** `role="group"` (`navLabel`) of real `<button>`s laid over the buckets: one per non-empty bucket, `aria-label` = `viewer.density.jump` (+ ". Resultado ativo" and `aria-current` on the active bucket), `aria-description` = the tooltip text (pages, count, chapter). One tab stop (roving tabindex, starts on the active hit's bucket), ArrowUp/Down/Left/Right, Home, End, Enter/Space. Focus shows the tooltip and a focus ring. Nothing depends on colour: the label, the triangle and the count are textual/shape cues.
- Outline: flat ARIA tree (`role=tree`, `treeitem` with `aria-level/posinset/setsize/expanded/selected`), one tab stop, Up/Down/Home/End, Right (expand, then first child), Left (collapse, then parent), Enter/Space (navigate). The row's name is the title (`aria-labelledby`); page, hit count and "Secção atual" are its description (otherwise the chevron button's label would leak into the name). Counts and page numbers have visible `aria-hidden` text plus an sr-only spelled-out version.
- Side panel: `tablist`/`tab`/`tabpanel` with `aria-controls`/`aria-labelledby`, roving tabindex, Left/Right (wrapping), Home/End.

## Behaviour notes
- Outline "current entry" = `deepestItemForPage(items, currentPage)` (not the top-level "capítulo atual" of the search scope). The marker follows `tab.currentPage`. Until the user toggles something, the open entries follow the visible page (path to the current entry open); after the first manual toggle the user's choice sticks and, if the current entry is hidden inside a collapsed entry, the marker (at half strength, `data-current="contains"`) moves to the outermost collapsed ancestor. The marked row scrolls into view (`block: nearest`).
- Counts: `aggregateHitCounts` sums `useHitCountsByOutlineItem` over each entry and its descendants; shown only while `useHasResults`; entries with 0 hits show no pill.
- Entries without a page are shown ("sem página"), `aria-disabled`, not clickable.
- Both side-panel panels stay mounted; the inactive one is `hidden` (the thumbnail rail keeps its scroll position and its tool selection state). The panel is `w-36` (the rail's own width) on Miniaturas and `w-60` on Indice.

## Deviations (with reasons)
1. **Panel width differs per tab** (144px vs 240px); the mockup has one 230px sidebar for both. `ThumbnailRail` is frozen at `w-36`, and a 230px panel would leave an empty 86px beside the rail. Consequence: switching tabs re-fits the width (92 % -> 76 % at 800px in my check).
2. **Fix in `ViewerSurface.tsx` beyond mounting the map** (`topVisibleIndex` now uses `rowVirtualizer.range?.startIndex` instead of `getVirtualItems()[0]`). `getVirtualItems()` includes the 2-row overscan, so `currentPage` lagged up to two pages behind what was on screen, and after `scrollToPage(4)` the store was overwritten with page 2. That made the outline highlight the wrong entry (seen in the browser: clicking "2 Cessação" highlighted "1.1 Âmbito"). This also corrects the page indicator and the rail highlight. Regression test in `ViewerSurface.test.tsx` (fails with the old line: got 3, expected 5). Orchestrator: please keep this when merging.
3. **`DensityMapModel.tsx` is a `.tsx` file with no JSX** only because the brief restricts new files in `src/viewer/search/` to `DensityMap*.tsx`.
4. The tooltip is `aria-hidden`; its content reaches assistive technology through `aria-description` on the bucket buttons.
5. Pointer hover is on the whole track (not per bucket element), so the tooltip also works for 1-2px buckets in long documents.

## Missing i18n keys
None. All strings come from the existing `viewer.density.*` / `viewer.outline.*` keys (pt-PT and en parity check passes). Keys used: density `summary`, `summaryEmpty` (map is hidden then, so unused in practice), `unit*`, `pageSingle`, `pageRange`, `tooltip`, `tooltipChapter`, `jump`, `navLabel`, `activeResult`; outline `tabsLabel`, `tabThumbnails`, `tabOutline`, `treeLabel`, `empty`, `loading`, `error`, `expand`, `collapse`, `page`, `noPage`, `goTo` (row `title` tooltip), `current`, `hitCount`.

## Contract / orchestration notes
- `ui.sidePanelTab` (`"thumbnails" | "outline"`) is a new `prefs_*` key, not listed in CONTRACTS; the orchestrator may want to add it to the persistence section.
- `selectResultKind` is still a stub returning `"phrase"` in `selectors.ts` (documented as such), so until S6 stores the mode the tooltip says "resultados" even in proximity mode. My tests mock the selector for the "zonas" wording.
- Integration tests drive the real UI (Ctrl+F, the "Localizar no documento" placeholder, `search-count`/`search-close` test ids), not `searchStore`; if S6 renames those test ids or the placeholder, `DensityMap.integration.test.tsx` needs the same rename.
- Mock book outline quirk (not a bug): `BOOK_OUTLINE` starts at 0-based page 1, so the cover page belongs to no entry (top-level counts sum to total minus cover hits).

## Tests (Vitest, all pass; 289 in the repo)
- `DensityMapModel.test.tsx` (27): pages per bucket, log opacity, grouping/clipping/ignored pages, ticks, summary, page offsets, viewport rectangle (scroll, clamp, mixed page sizes), marker, hit-testing.
- `DensityMap.test.tsx` (28, selectors mocked): hidden without results/reserved gutter, buckets, ticks (outline/none/loading/error), active marker, viewport follows scroll, `role=img` summary (phrase/proximity/singular), tooltips (phrase/proximity x outline/none, uncovered page, grouped range, leave), click -> `activateFirstHitFrom` with the right page (bucket, grouped, empty space, no double fire), keyboard (group of buttons, arrows/Home/End/Enter, one tab stop, active bucket, tooltip on focus).
- `DensityMap.integration.test.tsx` (4, nothing mocked): full `AppShell` on the mock book, real search -> map appears with buckets summing to the result total, ticks, summary, active marker; click a bucket moves the marker; close removes the map; Indice tab shows per-chapter counts.
- `outline/OutlinePanel.test.tsx` (19): tree semantics, expand/collapse, navigation (click, Enter, Space), no-page entry, current entry follows `currentPage` (deepest, not top-level; auto-open; sticks after a manual toggle; collapsed ancestor marker), aggregated counts + sr text + none without results, keyboard model, empty/loading/error/no-bookmarks document.
- `outline/outlineModel.test.ts` (7), `chrome/SidePanel.test.tsx` (8: tablist semantics, switching, rail kept mounted, width, arrow keys, remembered tab via `ui.sidePanelTab`, unknown value, user pick beats a late read), `viewer/ViewerSurface.test.tsx` (3: gutter outside the scroller, fit-width from the scroller, current page not lagging).

## Verification output
- `pnpm lint`: 0 errors, 4 warnings (all pre-existing `react-refresh` warnings in `chrome/errors.tsx` and `tokens/components/*`; `.claude/` was not picked up).
- `pnpm typecheck`: clean.
- `pnpm test`: 37 files, 289 tests passed.
- `pnpm i18n:check`: parity OK (9 namespaces).
- `pnpm build`: built (chunk-size warning is pre-existing).
- Manual: `pnpm vite --port 1457` (1420 was taken by other agents), mock book document, see "Against the mockup".
