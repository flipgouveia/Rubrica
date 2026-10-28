# S6 report — search panel UI (React), search v2 phase 2

Branch: `worktree-agent-ad57c0508fa3d60f6` (cut from `search/phase-2` @ `6b20ac3`; the worktree was
first created from `main`, so I reset it to `search/phase-2` before writing anything). Not pushed.

## What was built, per mockup state

| State | Where | Notes |
|---|---|---|
| **0 Barra compacta** | `SearchBar.tsx` | Unchanged layout (field, count, ↑↓, expand, close). It now builds the same `SearchQuery` as the panel (mode, window, accents, scope come from the app prefs / per-document state), so Alt+P and every option apply to it too. Shows the textless / invalid / failed notices under the bar. "Sem resultados" stays in its counter. |
| **1 Vista principal (proximidade)** | `SearchDock.tsx` + `SearchOptions.tsx` | Order exactly as in the mockup: field + Aa + whole word → Frase/Proximidade + Janela + car. → presets → term chips → syntax hint → Âmbito → toggles → progress → status ("1 de 6 zonas · 7 páginas", sort select, ↑↓) → list → key hints. |
| **A Frase** | same | "X de N resultados", grouped by chapter, per-hit rows with context. |
| **B A pesquisar** | `SearchParts.tsx` (`SearchProgress`), `searchLabels.ts` | "A pesquisar… página X de N · M resultados/zonas" + thin bar. In proximity the list is by position until the `ranked` done batch. |
| **C Âmbito aberto** | `ScopeSelector.tsx` | Documento inteiro · Capítulo atual — *title* · "Escolher capítulo…" tree with page ranges (expandable, selected entry shown, ancestors opened) · "Páginas [x] a [y]" + "De 1 a N". Each option shows its page count (`N p.`). |
| **D Janela** | `SearchOptions.tsx` | Number field 20–5000 (invalid value: red field + "Valor entre 20 e 5000 caracteres", reverts on blur) + presets 100/250/500/1000 with the active one marked. |
| **E Sem índice** | `ScopeSelector.tsx` | Chapter options disabled (wrapped in a `title` tooltip), a visible note "Este PDF não tem índice (marcadores).", pages range still works. |
| **F Sem resultados / sem texto** | `SearchNotices.tsx` | "Sem resultados" (+ proximity: "Nenhuma zona com os N termos em W caracteres.", "Aumentar janela para min(2W, 5000)" only when it would change the window, "Pesquisar no documento inteiro" only when the scope is narrower), `textless`, invalid query (`INVALID_ARG` or a proximity query with only exclusions — not sent), invalid page range, failed search with the engine message. |
| **G Editar cores** | `ColorPalette.tsx`, `TermChips.tsx` | Swatch of a chip opens the dialog "Cor 2 — prazo": 8 presets, "Personalizada" hex field with validation (`#RRGGBB`, saved upper-case, `aria-invalid` + "Use o formato #RRGGBB."), live example at ~50 % alpha, "Repor originais". Esc / outside click close only the popover. Same editor inline in Settings → Pesquisa (4 fieldsets "Cor n" + "Repor cores originais"). |

Highlights (`SearchHighlights.tsx`): colour per term position from `search.highlightColors` (token
`--search-tN` while a colour is the original, `rgba(hex, .5)` otherwise; terms ≥ 5 cycle), active hit
outlined with `--search-active` on all its rects, proximity window as one soft box
(`--search-window`, outlined with `--search-window-line` when active) around the per-page bounds of
`windowRects`, `furniture` rects dimmed + struck through with a title, and **rects drawn on their own
`rect.page`** (page p also draws the tail of hits that started on p-1).

## Store shape changes (`searchStore.ts`)

`DocSearch` gained: `scope: ScopeChoice` (all / currentChapter / chapter{itemId} / pages{from,to} 1-based),
`searchQuery` (the query that was sent) and `resultMode` (mode of the results), `ranked`, `furniture:
Record<page, Rect[]>`, `error: {kind:'invalid'|'failed', message}`, `groups: HitGroup[]`, `grouped`,
`collapsed`. `flat` is now the **visible order** of the list (it used to be document order);
`HitRef {page, hitIndex}` identity is unchanged (`HitRef` now lives in `searchOrder.ts`, re-exported
from the store). New actions: `setScope`, `toggleGroup`, `activateHit`, `reorderAll`; `startNewSearch`
takes the sent query, `finishWithError` an error. Everything phase-1 (B1–B12) keeps working; `indexOfHit`
is now linear (the list is no longer sorted by identity).

App-wide options (mode, window, accents, headers/footers, sort, colours) are in the new
`searchPrefs.ts` (zustand, same pattern as `prefsStore.ts`, keys/format per CONTRACTS §8; a setter called
before `load()` finishes wins over the stored value). `search.lastMode`/`search.panelWidth` stay in
`searchController.ts`. Settings loads the prefs itself (the panel may never have been mounted).

New helper modules: `searchQuery.ts` (pure `buildSearchQuery` + `useSearchQuery` hook + `currentQueryBuild`
for the controller — the effect and the controller share one function so the search key cannot drift),
`searchScope.ts` (resolve/convert scopes, 1→0-based), `searchOrder.ts` (grouping/sorting), `searchColors.ts`,
`queryTerms.ts` (proximity syntax, mirrors the engine), `useDismissable.ts` (popover Esc/outside click).

## Ordering and grouping

`buildHitOrder(hitsByPage, compact)`: groups by `outlineItemId` in order of their first hit (document
order). If no hit has an id → one headerless group = flat list (also the no-outline case); if some do,
the `null` ones form "Antes do primeiro capítulo". *Por posição*: groups and hits in document order.
*Mais compactas*: hits by `score` inside each group, groups by their lowest score, ties → document
order. It applies only when `resultMode === 'proximity' && ranked && sort === 'compact'`; before `ranked`
(and in phrase mode, whatever the preference) the list is by position. The store recomputes the order
on every batch that changes hits/ranking and on a sort change (the prefs subscription calls
`reorderAll`), keeping the **same hit active**. `X de N`, ↑/↓, Enter, F3 all walk `flat`. A collapsed
group keeps its hits in `flat` (counts/navigation unchanged) and is re-opened when navigation lands in
it. When `ranked` arrives and the user has not moved yet (`activateNonce === 0`), the active hit jumps
to the first of the compact order; a hit the user chose is never moved. Titles come from
`useOutline` + `flattenOutline`.

`selectors.ts`: signatures untouched; `selectResultKind` reads `resultMode`; `activateFirstHitFrom`
works on `hitsByPage` in document order (first page ≥ `page`, hit 0; falls back to the very last hit)
and goes through `activateHit`. Hooks stay memoised on `hitsByPage` (sorting/navigation do not change
their references).

## Preferences

Loaded at panel start (`startSearchEngine`) and when Settings opens; saved on change:
`search.mode`, `search.proximityWindow`, `search.ignoreDiacritics` (default true),
`search.excludeHeadersFooters` (false), `search.sort` (compact), `search.highlightColors` (JSON of 4
upper-case `#RRGGBB`). Malformed/out-of-range stored values are ignored. They are app-wide, so another
tab's next search uses the same options.

## Behaviour decisions worth knowing

- **"Capítulo atual" is live**: it resolves against the visible page on every render, so scrolling into
  another top-level chapter re-targets it (and re-runs the search) and the label follows. If no
  top-level entry holds the page (e.g. page 0 of the mock book) it falls back to the whole document
  and the label reads "Capítulo atual" without a title.
- A chapter that cannot be resolved (no outline, entry vanished after an edit, no destination) falls
  back to `{kind:'all'}`; while the outline is still loading the effect waits instead of searching.
- An invalid page range (empty field, from > to, beyond the last page) is never sent; the search
  key changes, stale results are dropped, "Intervalo de páginas inválido." is shown.
- `useOutlineStore.byKey` is read as `${docId}@${revision}` by the controller (key format taken from
  the frozen file's comment).

## Deviations from the mockup (all deliberate)

1. Active hit: **every rect of the active zone** gets the amber outline and keeps its term colour
   (mockup outlines one term). Reason: B2/B7 semantics (one hit, several rects) and a zone's terms are
   all part of it.
2. Non-active proximity windows are drawn as a very soft fill only (no outline); only the active one
   gets the outline. The mockup shows just the active zone on the page.
3. The window is the per-page **bounding box** of `windowRects` (+3 px), not a polygon; a window that
   starts/ends mid-line covers the full width of those lines.
4. Scope selector is a small custom popover (not Radix) because it holds a tree and number inputs. The
   "tooltip" of state E is a visible note in the popover plus a `title` on the disabled options
   (the mockup also renders it as a static element).
5. The panel status row hides the count when there are no results (the empty-state block carries
   "Sem resultados" as in state F) — otherwise the text would appear twice. The compact bar keeps
   "Sem resultados" in its counter (existing test).
6. The syntax hint sits under the term chips (mockup D has it last in the card); the presets row is
   shown whenever the mode is proximity.
7. The sort control is a native `<select>`.
8. The compact bar has no mode/window controls (as in the mockup); Alt+P still toggles the mode there.

## Missing i18n keys

None required. (A literal in the Settings preview and the palette example uses the hex / the term itself
as text, no new string.)

## Contract notes

No blocking problem. Observations: (1) the mock's `doc_open` error message still says "pass a path
containing \"form\" or \"text\"" although "book"/"perf" work; (2) the UI assumes the hits inside one
`SearchMatch.hits` are in document order (needed for `activateFirstHitFrom` and position order);
(3) `search_batch.furniture` is applied per page as a replacement, an empty `rects` clears the page.

## Tests

New/changed (all Vitest + Testing Library, mock engine, "book" doc):

- `SearchPanelV2.test.tsx` (49): query building per option and scope (1-based → 0-based pages, current
  chapter = top-level entry, chapter by id, falls back / waits on outline), debounce, every option
  re-runs the search; proximity query; window presets and 20–5000 limits; term chips (colour slots,
  exclusions struck through); scope selector (options + page counts, current chapter follows the page,
  tree with ranges and sub-chapters, page range, invalid range, no outline → disabled + tooltip, Esc /
  outside click); grouping (titles, counts, p. N–M + spans meta, window length, "Antes do primeiro
  capítulo", flat without outline); snippet term colours; collapse/expand; ordering by position vs
  compactness before/after `ranked`, "X de N" and next/previous following the visible order, sort
  select, phrase never ranked; empty states (no zones + widen window, search whole document, max
  window, no results, textless, INVALID_ARG, only-exclusions not sent, failure, compact bar); colour
  palette (8 presets, hex validation + upper-casing, reset, persistence, Esc, ≥5th term); Alt+P (also
  in the field, persists, re-runs, closed = no-op); prefs restore/save/app-wide.
- `SearchHighlights.test.tsx` (10): colour per term + cycling + user colours, active outline, window box,
  spanning hit drawn on both pages (and not leaked), furniture dimming, zoom.
- `searchStore.test.ts` (+12): result mode, position→compact on `ranked`, sort change keeps the active hit,
  ranking before the user moved, next/prev in visible order, groups/collapse/`activateHit`, furniture,
  errors, scope per document. `searchOrder.test.ts` (6), `searchQuery.test.ts` (13), `searchPrefs.test.ts`
  (9), `searchColors.test.ts` (5), `queryTerms.test.ts` (3), `selectors.test.tsx` (11: contract tests —
  counts by page / by outline item, active hit, has-results, result kind, referentially stable hooks,
  `activateFirstHitFrom` in document order).
- `src/screens/SettingsScreen.test.tsx` (6): section, presets, hex, reset, load of saved colours, English.
- `src/chrome/shortcuts.collisions.test.tsx`: Alt+P registered, `always` scope, no other owner; minimum
  of distinct "always" combos raised 19 → 20.
- Phase-1 tests (`SearchPanel.test.tsx`, `searchStore.test.ts` existing cases, `dockedFitWidth`): **no
  assertion changed**; `searchStore.test.ts` only resets the search prefs in `beforeEach`.

## Verification

```
pnpm lint --ignore-pattern ".claude/**"   0 errors, 4 warnings (pre-existing: errors.tsx, Dialog, Menu, Tooltip react-refresh)
pnpm typecheck                            clean
pnpm test                                 39 files, 317 tests passed
pnpm i18n:check                           OK (9 namespaces match)
pnpm build                                OK (only the pre-existing 500 kB chunk warning)
```

Visual check against the mock "book" document in a browser (Vite dev server started from this
worktree — the `preview_start` dev server serves the main checkout, so I ran `pnpm dev` myself): proximity
panel (state 1: chips with swatches, strike-through exclusion, presets, window, "1 de 2 zonas · 12 páginas",
grouped list with "p. 11–12 / 469 car. / Atravessa a mudança de página"), highlights on the page (term
colours, active outline, soft window box), scope popover (state C, page counts, tree, page range) and the
colour palette popover (state G) all render like the mockup; Esc closes a popover without closing the
search. Not visually checked: dark theme, compact bar in the browser (covered by tests), Settings screen
(covered by tests), and the real Rust engine (only phrase/whole-document until the orchestrator wires the
pipeline).
