# R3 — Viewer & shell UI (wave 1, builds on the mock engine)

## Mission

Build everything the user sees that isn't an editing tool: the tiled document viewer, the app
chrome, home/settings, and the tool-registration API that R4/R6's tools plug into. You develop
against the mock engine in a plain browser (`VITE_MOCK_ENGINE=1`); the real engine must slot in
with zero changes on your side — talk only to `src/ipc/bindings.ts`, never invent IPC.

## Read first

`docs/ARCHITECTURE.md`, `agents/CONTRACTS.md` (§2–§5, §7), R1's report, `src/tokens`.

## Owns / must not touch

Owns: `src/viewer`, `src/chrome`, `src/screens`, `src/ipc/mock/{document,render,text,history}.ts`,
locales `chrome`/`viewer`/`screens`/`common` (pt-PT + en). Must not touch: `src-tauri/**`,
`src/tools/**`, R4's mock modules. Publish `src/chrome/TOOL-API.md` (how a tool registers:
toolbar entry, panel, overlay layer, shortcuts) **in your first work session** — R4 builds
against it.

## Deliverables

1. **Viewer surface**: virtualized page canvas composing tiles from the protocol (mock or
   real transparently), scroll/zoom (buckets per contract, pinch/ctrl-wheel, fit-width/page),
   rotation-aware layout, selection overlay from `text_page_layout` (mouse + keyboard, copy),
   search UI (input, streamed hit list, highlight rects, next/prev), **night reading mode**
   (invert/sepia canvas filter over tiles — view-only, persisted in prefs), smooth 500-page
   behavior against the mock's synthetic latency.
2. **Chrome**: toolbar (file ops, zoom, tool slots via TOOL-API), **tabs** for multiple open
   documents, thumbnail rail (view-only here — R4 adds editing interactions on top via the
   TOOL-API's rail extension point), command palette, shortcuts map (`src/chrome/shortcuts.ts`),
   dirty-state indicator + save/save-as flows, undo/redo buttons bound to `history_*`.
3. **Screens**: Home (recents grid with page/zoom restore, open-file, drag-drop onto window),
   Settings (language pt-PT/en, theme, `.bak` toggle, night-mode defaults), recovery dialog on
   `recovery_available`.
4. **Print flow**: dialog (page range, per contract `print_render`) → hidden print window.
5. **Error surfaces**: typed `RubricaError` → human messages (i18n), incl. encrypted/corrupt.
6. **Mock upkeep**: extend your four mock modules as needed to exercise all of the above
   (synthetic latency, a fake 500-page doc for perf work).
7. **Tests**: component tests for selection math, search-hit navigation, tab lifecycle;
   a mock-driven integration test of open → scroll → search → copy → close.

## Dependencies you may add

`@tanstack/react-virtual`, `lucide-react`, testing-library + jsdom.

## Subagent plan

- SA-1: viewer canvas + tiles + zoom/scroll + night mode.
- SA-2: selection + search UI.
- SA-3: chrome (toolbar, tabs, rail, palette, shortcuts) — after you write TOOL-API.md.
- SA-4: screens + print + error/recovery dialogs + i18n sweep (both languages, real pt-PT).
- Keep for yourself: TOOL-API design FIRST, layout composition, review.

## Definition of done

- Full flow works in a plain browser on the mock: open both fake docs in tabs, scroll/zoom the
  500-page fake smoothly, select/copy, search with highlights, toggle night mode, print dialog
  renders, settings switch language live (pt-PT ↔ en, no hardcoded strings anywhere).
- `TOOL-API.md` committed early; shortcuts map documented.
- i18n parity check green; both themes reviewed.
- Write `agents/reports/r3-report.md`.
