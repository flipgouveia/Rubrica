# R4 — Editing tools UI: annotations, pages, forms (wave 1, builds on the mock engine)

## Mission

Build the three v1 editing tool surfaces — annotations, page management, form filling — as UI
against the mock engine and R3's TOOL-API. Wave 2 (R5) wires them to the real engine; your job
is that the interaction design is complete and the IPC calls are exactly per contract, so that
wiring is a merge, not a redesign.

## Read first

`agents/CONTRACTS.md` (§3 annotations/pages/forms, §5, §7), `src/chrome/TOOL-API.md` (R3
publishes it early — until then, build tool internals and mock behavior, not chrome mounting),
`docs/ARCHITECTURE.md` (editing model).

## Owns / must not touch

Owns: `src/tools/{annotate,pages,forms}`, `src/ipc/mock/{annotations,pages,forms}.ts`, locales
`tools-annotate`/`tools-pages`/`tools-forms` (pt-PT + en). Must not touch: `src-tauri/**`,
`src/viewer`, `src/chrome`, `src/screens`, R3's mock modules, `src/tools/{text-edit,redact}`
(R6's, wave 2).

## Deliverables

1. **Annotation tools**: highlight/underline/strikeout from text selection (quadpoints from
   the selection API), ink (freehand, pressure-agnostic, smoothing), sticky notes (place, open,
   edit popover), shapes (rect/ellipse/line/arrow with handles), free text boxes. Common
   machinery: SVG overlay while drawing (60 fps, committed on release per the architecture),
   select/move/resize/delete existing annotations, color/opacity/width controls, keyboard
   delete/escape/nudge.
2. **Pages tool**: upgrade the thumbnail rail (via TOOL-API extension point) into an editor —
   drag reorder (with drop indicator), multi-select, rotate, delete (with count confirm),
   insert blank, insert from another PDF (file picker + range), all through the §3 `pages_*`
   commands; every operation reflects `MutationResult.invalidatedPages` immediately.
3. **Forms tool**: field overlay from `form_fields` (rects over the page), focus + tab
   navigation in document order, per-kind editors (text inline, checkbox/radio toggle, combo/
   listbox dropdowns), required/readOnly states, unsaved-value indicator, "next field" flow.
4. **Mock upkeep**: your three mock modules implement realistic behavior — annotations persist
   with ids and survive undo/redo; pages ops permute the fake doc; the fake form doc's fields
   accept values (mock revision bumps drive tile invalidation so the UI proves its refresh path).
5. **Tests**: quadpoint derivation from selections, ink smoothing, reorder drop-index math,
   form tab-order; a mock-driven integration test per tool.

## Dependencies you may add

testing-library + jsdom if R3 hasn't already added them (coordinate via lockfile rules).

## Subagent plan

- SA-1: annotation common machinery (overlay, select/move/resize, controls).
- SA-2: annotation types (markup-from-selection, ink, note, shapes, free text) — after SA-1.
- SA-3: pages tool.
- SA-4: forms tool.
- SA-5: mock modules + integration tests + i18n sweep (real pt-PT, not machine-translated en).
- Keep for yourself: interaction design consistency across the three tools, review.

## Definition of done

- On the mock, in a plain browser: annotate all types, edit/move/delete them, undo/redo through
  the whole history; reorder/rotate/delete/insert pages; fill the fake form end-to-end with
  keyboard only. All tool UI in pt-PT and en with parity green.
- Every IPC call matches CONTRACTS §3 exactly (no invented commands — that's the wave-2 weld).
- Write `agents/reports/r4-report.md` (flag anything TOOL-API couldn't express — R8 cares).
