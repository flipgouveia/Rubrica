# R4 — Editing tools UI: report (wave 1)

Status: **done**. All three deliverables (annotations, pages, forms) built against the mock
engine, per `agents/R4-editing-tools-ui.md`. `pnpm typecheck`, `pnpm lint`, `pnpm test` (13 files,
71 tests), `pnpm i18n:check` (9 namespaces, pt-PT/en parity), and `pnpm build` are all green on
the final tree. Manually verified in a real browser (Chromium via the harness pages described
below), not just via automated tests — see "Manual verification" below.

## How this wave was executed

Three subagents each built one tool end-to-end in an isolated git worktree (annotations, pages,
forms), against a shared foundation (`src/tools/shared/{coords,useDocRevision}.ts`,
`src/tools/annotate/geometry.ts`, and a small `src/ipc/mock/annotations.ts` patch-semantics
change) written first so the three tools would agree on coordinate conventions and move/resize
behavior without needing to coordinate live. All three branches merged back with **zero file
conflicts** (fully disjoint ownership held up in practice) and the combined tree passed full
verification on the first try, then again after an integration/cleanup pass (below).

**Worktree-base inconsistency, worth flagging for whoever runs the next parallel wave**: two of
the three isolated worktrees (pages, forms) were created from the wave-0 tip rather than from
this branch's later commit that added the shared foundation files, even though they were spawned
*after* that commit landed. The annotate worktree got the correct, later base. Net effect: pages
and forms each built local, well-documented stand-ins for `coords.ts`/`useDocRevision.ts` (their
own summaries flag this explicitly), which the parent then consolidated into the real shared
modules post-merge (commit `66f3fd2`) — pure dedup, verified with the full suite before and
after. No functional harm resulted, but it cost an integration pass that wouldn't have been
needed if worktree isolation reliably branched from the spawning session's current tip. Orchestrators
relying on `isolation: "worktree"` for tightly-coupled parallel work should verify each spawned
worktree's base commit before assuming a just-landed shared file is visible to it.

## Deliverables

1. **Annotation tools** (`src/tools/annotate/**`) — highlight/underline/strikeout (from
   selection-rect quadpoints), ink (freehand, rAF-batched preview, moving-average smoothing on
   commit), sticky notes (place/reopen-on-double-click/edit popover), shapes
   (rect/ellipse/line/arrow with resize handles), free text boxes. Common machinery: SVG overlay
   while drawing, select/move/resize/delete, color/opacity/width controls (kind-aware — see
   Contract gap #1), keyboard delete/Escape/arrow-nudge (1pt, 10pt with Shift).
2. **Pages tool** (`src/tools/pages/**`) — thumbnail grid as a standalone editor: native
   pointer-based drag reorder with a live drop indicator, click/Ctrl/Shift multi-select, rotate
   ±90°, delete with a count-worded confirm dialog (and the mock's "can't delete every page"
   guard surfaced as a dismissible banner, not a crash), insert blank, insert from a picked file
   with an optional page-range control. No new dependency — pointer events implemented natively.
3. **Forms tool** (`src/tools/forms/**`) — field overlay positioned from `form_fields` via the
   shared PDF→screen transform, explicit global `tabIndex` per field (so Tab/Shift+Tab honor
   document order across separately-mounted per-page overlays), per-kind editors (text inline,
   checkbox/radio toggle matching the fixture's own "On"/"Off" convention, combo/listbox
   constrained to `options`), required/read-only states, an unsaved-changes indicator (`DocInfo.
   dirty`), and an Enter-driven "commit and advance, wrapping" next-field flow.
4. **Mock upkeep** — `src/ipc/mock/{annotations,pages,forms}.ts`. `pages.ts` and `forms.ts`
   needed no changes (already correct for these UIs). `annotations.ts` gained the bbox-transform
   patch semantics described below.
5. **Tests** — 71 tests across 13 files: pure-function tests (quadpoint derivation, ink
   smoothing, bbox move/resize math, drag drop-index math, document-order field sort) plus one
   real-mock-IPC integration test per tool (not stubbed out — each opens an actual mock document
   and exercises `commands`/`events` from `src/ipc`, including undo/redo round-trips).
6. **i18n** — `tools-{annotate,pages,forms}` populated in both `pt-PT` (real European Portuguese
   — "ficheiro" not "arquivo", "só de leitura" not "somente leitura", correct diacritics
   throughout, not machine-translated-sounding) and `en`. Parity holds across all 9 namespaces.

## A contract interpretation this wave had to invent (flagged for R5 and the human orchestrator)

`AnnotPatch` (CONTRACTS §3) is `{ color, opacity, contents, rect }` — identical shape for every
`AnnotSpec` kind. But structurally, only `shape`/`freeText` actually *have* a `rect` field;
`highlight`/`underline`/`strikeout` have `quadpoints`, `ink` has `strokes`, `note` has `point`.
The brief calls select/move/resize "common machinery" across every annotation type, which is only
possible if `rect` in a patch means "the annotation's new bounding box" generically, not a literal
field write. **This wave settled on that interpretation** and implemented it once, in
`src/tools/annotate/geometry.ts`'s `getAnnotBBox`/`applyBBoxToAnnot`: a patch's `rect` is mapped
onto whichever geometry the target kind actually carries via a uniform translate+scale from the
annotation's current bbox. `src/ipc/mock/annotations.ts`'s `annot_update` applies this. **R5's
real Rust engine needs to implement the identical semantics** (bbox-transform quadpoints/strokes/
point from a `rect` patch, not just a literal-rect special case for shape/freeText) or move/resize
will silently stop working for four of the seven annotation kinds the moment the real engine
replaces the mock. This is the single most load-bearing undocumented decision in this wave's work —
worth a CONTRACTS amendment (an explicit note next to `AnnotPatch`) rather than staying tribal
knowledge in a code comment.

## Other CONTRACTS gaps / ambiguities found (documented in code where relevant, not worked around silently)

- **`freeText`'s `text`/`fontSize` are not patchable at all.** `AnnotPatch` has no field for
  either, so a free-text box's body can only be set at creation (`annot_add`); there is no
  contracted way to edit it afterward short of delete+recreate. The toolbar disables text editing
  for a selected `freeText` rather than silently no-op-ing.
- **`annot_add` returns only `MutationResult`, never the new annotation's id.** Placing a `note`
  needs that id immediately to open its contents popover. Worked around by diffing `annot_list`
  before/after the add (`addAndFindNew` in `AnnotationLayer.tsx`) rather than assuming anything
  about id-minting order — but a real `annot_add` returning the created `Annot` (or at least its
  id) would remove this fragility. Worth considering for a future CONTRACTS bump.
- **`shape`'s `line`/`arrow` variants carry only a `rect`, no explicit endpoints.** This wave's
  documented convention (in `AnnotationLayer.tsx`'s header comment): the line/arrow renders from
  the rect's PDF-space bottom-left corner to its top-right corner. R5 must render/hit-test with
  the exact same convention or line/arrow annotations created in wave 1 will render wrong once
  the real engine takes over.
- **`DocInfo.pages: PageSize[]` exposes only post-rotation width/height, never the rotation
  angle itself.** A 180° rotation is architecturally invisible to any UI reading only `DocInfo`
  (width and height don't swap). The pages tool makes 90°/270° visible via the thumbnail's aspect
  ratio; 180° has no visual UI feedback at all under the current contract. Not a blocker for v1,
  but worth a note if rotation feedback ever needs to be authoritative from `DocInfo` alone.
- **No mock form field is `readOnly: true`.** The forms tool's read-only handling (non-interactive
  editor, no `form_set_value` call attempted) is therefore covered by component-level unit tests
  with fabricated `FormField`s rather than the real-IPC integration test — `mock/state.ts`'s
  fixture is R3-owned and out of this wave's reach to change.

## A real bug found and fixed during the parent's post-merge manual verification

`AnnotationLayer.tsx`'s pointer-up handler committed an `annot_update` rect patch on **every**
click that selected an existing annotation, even with zero pointer movement — a plain
click-to-select was indistinguishable from a zero-distance drag. Effect: every selection click
bumped the revision and pushed a no-op entry onto the undo stack, so undoing a real edit
sometimes required an extra "undo" to get past a spurious selection entry first. Fixed (commit
`66f3fd2`) by requiring movement past the same small pixel threshold already used to distinguish
a shape-draw click from a drag, for both the `move` and `resize` interaction cases. Re-verified
manually in-browser (see below): selecting no longer bumps revision; a real drag still does;
undo/redo through add → move → delete now takes exactly one undo per user action.

## Manual verification (this wave's Definition of Done, run by the parent post-merge)

Each subagent verified its own tool during development; the parent additionally drove all three
tools' `dev/*Harness.tsx` pages through `src/App.tsx` (temporarily, reverted before every commit —
confirmed via `git diff` showing zero change to `App.tsx` in the final tree) in a real Chromium
browser against the live mock engine:

- **Annotate**: added a highlight, selected it (confirmed no spurious mutation post-fix), dragged
  it to a new position, deleted it, then undid twice back to the original position and redid —
  each step's revision/undo-stack behavior matched a single logical action.
- **Pages**: selected a page, rotated it (confirmed the thumbnail's aspect ratio flipped), deleted
  it through the count-worded confirm dialog, undid the delete and got the page back.
- **Forms**: filled the text field (commits on blur/Tab, not just Enter), toggled the checkbox,
  picked a radio option — all via real pointer/keyboard events against the actual mock IPC, with
  the field-values panel and dirty indicator updating live.

Note: synthetic `Space` keydown against a focused native checkbox did not trigger the browser's
default toggle behavior in this automation environment (a tooling limitation, not a code bug —
confirmed by toggling the exact same checkbox with a mouse click immediately after, which worked).

## Dependencies

No dependencies added beyond what wave 0 already installed. The pages tool's drag reorder is
implemented with native pointer events, not a new drag-and-drop library.

## What R5 (wave 2, real engine + wiring) needs to know

1. Implement `annot_update`'s bbox-transform semantics for `rect` patches on
   quadpoint/stroke/point-geometry kinds (see the contract-interpretation section above) — this
   is not optional polish, it's how 4 of 7 annotation kinds' move/resize works today.
2. Match the line/arrow bottom-left→top-right rendering convention documented in
   `AnnotationLayer.tsx`.
3. Every tool talks to `src/ipc/index.ts`'s `commands`/`events` only — nothing in `src/tools/**`
   imports `./bindings` or `./mock` directly, so swapping the mock for the real engine should be a
   zero-UI-change operation, exactly as the brief intends.
4. `src/tools/{annotate,pages,forms}/index.ts` are each tool's public surface (barrel exports) —
   start there when wiring into R3's TOOL-API rather than reaching into internal files.
5. `src/tools/{annotate,pages,forms}/dev/*Harness.tsx` are throwaway manual-QA pages, never
   imported by product code — safe to delete once real chrome mounting exists, or keep them as
   living component-development sandboxes; either is fine.

## TOOL-API note (for R3/R8)

`src/chrome/TOOL-API.md` did not exist at any point during this wave (confirmed: this worktree's
sibling R3 session was still in progress concurrently). Per the brief, all three tools were built
as self-contained, prop-driven components (`{docId, page, viewport}` for annotate/forms;
`{docId}` for pages) that assume nothing about a host — mounting them into the real chrome should
be a wrapper/wiring change, not a rewrite. Nothing about the tools' internals required a chrome
capability that doesn't obviously map onto "an overlay layer on top of a rendered page" plus "a
panel/rail slot" — no TOOL-API gaps to flag beyond what's already noted above.
