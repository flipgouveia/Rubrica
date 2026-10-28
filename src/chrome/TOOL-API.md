# Tool registration API (R3 → R4/R6)

How a tool (`src/tools/{annotate,pages,forms,text-edit,redact}`) plugs into the chrome and
viewer without R3 needing to know it exists. One call, `registerTool(...)`, wires all of it.
Everything here is real, working code in `src/chrome/tool-api.tsx` and
`src/chrome/shortcuts.ts` — this file documents the shape, not a proposal.

## The five extension points

A `ToolDefinition` (see `src/chrome/tool-api.tsx`) is a plain object with an id and up to five
optional slots. Register it once, anywhere, before the app mounts (or lazily via a dynamic
import) by calling `registerTool(def)` — a `useSyncExternalStore`-backed registry re-renders
every mounted extension point automatically.

```ts
export interface ToolDefinition {
  id: string;                       // stable, e.g. "annotate", "pages", "redact"
  group: ToolGroup;                 // "annotate" | "pages" | "forms" | "textedit" | "redact"
  icon: ComponentType<{ className?: string }>;   // lucide-react icon component
  labelKey: string;                 // i18n key, "namespace:namespace.section.key" — used as the
                                     // toolbar tooltip AND the command-palette entry label
  toolbarEntry?: { order: number }; // presence = show a toggle button in the main toolbar's
                                     // tool cluster; clicking sets this tool "active"
                                     // (see activeTool below). `order` sorts left→right.
  panel?: ComponentType<ToolPanelProps>;        // rendered in the right-hand side panel
                                                 // while this tool is active
  overlayLayer?: ComponentType<ToolOverlayProps>; // rendered once per visible page, absolutely
                                                   // positioned over that page's tiles, while
                                                   // this tool is active (or always, if
                                                   // `overlayAlwaysOn` is set — used by
                                                   // annotate so existing markup shows even
                                                   // when the tool isn't the active one)
  overlayAlwaysOn?: boolean;
  railExtension?: ComponentType<RailExtensionProps>; // rendered inside each thumbnail rail
                                                      // row (see below)
  shortcuts?: ToolShortcut[];       // registered into the global shortcut map on mount
  paletteCommands?: (ctx: PaletteCommandContext) => PaletteCommand[]; // extra command-palette
                                                                       // entries beyond the
                                                                       // implicit "activate
                                                                       // this tool" one
}
```

Call `registerTool(def)` from your tool package's top-level module (e.g.
`src/tools/annotate/index.ts`) and import that module once from `src/App.tsx` (a single
explicit list of active tool packages — R3 keeps that list, tools don't need to touch `App.tsx`
themselves; add your import there or ask in your report and it'll be added). Registration is
idempotent by `id` — re-registering replaces the previous definition, which is what HMR needs.

## `activeTool`

Exactly one tool (or none — the default "pan/select" mode) is active at a time, exposed via
`useActiveTool()` / `setActiveTool(id | null)` from `src/chrome/tool-api.tsx`. The toolbar's
tool cluster renders one toggle button per registered `toolbarEntry`, highlights the active
one, and clicking a button (or its shortcut) calls `setActiveTool`. A tool with no
`toolbarEntry` (unusual, but the type allows it) can still be activated programmatically, e.g.
from a command-palette entry.

## Page coordinate system — `PageViewport`

Every overlay-facing slot receives a `PageViewport` for the page it's drawing over:

```ts
export interface PageViewport {
  docId: DocId;
  page: number;              // 0-based
  widthPt: number;           // page width in PDF points (post-rotation, matches DocInfo.pages)
  heightPt: number;          // page height in PDF points (post-rotation)
  zoom: number;              // continuous zoom factor: 1 PDF point == `zoom` CSS pixels
  rotation: number;          // degrees, 0/90/180/270 — already baked into widthPt/heightPt,
                              // exposed separately because ink/shape geometry is authored in
                              // unrotated page space and needs it to convert
  toScreen(ptX: number, ptY: number): { x: number; y: number }; // PDF point → CSS px within
                                                                  // this page's overlay div
                                                                  // (origin top-left, y DOWN —
                                                                  // PDF space is y-UP from the
                                                                  // bottom, this flips it once
                                                                  // so overlay authors never
                                                                  // have to)
  toDoc(pxX: number, pxY: number): { x: number; y: number };     // inverse of toScreen
}
```

`overlayLayer` components are mounted inside a `position: relative` div sized exactly
`widthPt * zoom` × `heightPt * zoom` CSS pixels, stacked directly above that page's tile grid
(same stacking context, so `position: absolute; inset: 0` fills it). Draw quadpoints, ink
strokes, shape rects, form-field boxes, etc. by running their PDF-point coordinates through
`toScreen` — never hand-roll the flip or the zoom multiply, so a future change to how zoom
buckets vs. continuous zoom relate doesn't ripple into every tool.

```ts
export interface ToolOverlayProps {
  viewport: PageViewport;
  isActive: boolean; // this tool is the current activeTool (vs. rendering only because
                      // overlayAlwaysOn — e.g. annotate keeps showing committed marks, but
                      // should ignore pointer events for *new* marks, when not active)
}
```

## Side panel

```ts
export interface ToolPanelProps {
  docId: DocId;
  activeTool: string; // === your own tool id, passed for convenience
}
```

Rendered in the chrome's right rail while your tool is `activeTool`. One tool's panel replaces
another's — there is no stacking. Return `null` if your tool has nothing to show for the
current selection state (e.g. forms tool with no field focused).

## Thumbnail rail extension

The rail (`src/chrome/rail/ThumbnailRail.tsx`) is view-only in R3: it renders one thumbnail per
page (via `mockThumbUrl`/real `rubrica-thumb://`), scrolls the viewer to a page on click, and
highlights the page currently in view. R4's pages tool turns it into an editor by rendering
into this slot, once per row:

```ts
export interface RailExtensionProps {
  docId: DocId;
  page: number;          // 0-based
  index: number;         // position in the current page order (same as `page` pre-reorder;
                          // exists so drag-reorder math has a stable "visual slot" number
                          // distinct from the PDFium page index while a drag is in progress)
  selected: boolean;     // this row is part of the rail's current multi-select
  toggleSelected(): void;
}
```

`railExtension` is rendered absolutely positioned over the thumbnail (a transparent full-row
overlay) so it can add drag handles, a selection checkbox, per-row context menu, rotate/delete
buttons, etc. without the rail itself knowing any of that exists. Only one tool should register
a `railExtension` at a time in practice (pages); the slot doesn't enforce that, it just renders
whichever registered tools provide one, stacked.

## Shortcuts

`src/chrome/shortcuts.ts` is the single global registry — CONTRACTS §7 requires this ("every
tool reachable by keyboard; shortcuts registered through one central map"). A `ToolShortcut`:

```ts
export interface ToolShortcut {
  id: string;                 // unique across the whole app — prefix with your tool id
  keys: string;               // normalized combo string, e.g. "mod+shift+h" ("mod" = Cmd on
                               // macOS / Ctrl elsewhere — Rubrica is Windows-only today, but
                               // the normalizer accepts "mod" so this doesn't need revisiting)
  labelKey: string;           // i18n key shown in the shortcuts map / command palette
  when?: "always" | "tool-active"; // "tool-active" (default if the shortcut is declared on a
                                    // ToolDefinition) only fires while this tool is the
                                    // activeTool; "always" fires regardless
  handler(): void;
}
```

Register directly with `registerShortcut(shortcut)` for one-off bindings (e.g. `history_undo`
on Ctrl+Z, owned by R3 itself), or via `ToolDefinition.shortcuts` — `registerTool` forwards
those into the same registry with `when: "tool-active"` by default. The registry:

- Ignores every binding while focus is inside an `<input>`, `<textarea>`, or
  `[contenteditable]`, **except** bindings explicitly marked `allowInFormFields: true`
  (Escape and a handful of tool-specific single-key bindings need this — e.g. text-edit's
  in-place editor still wants Escape to cancel).
- Throws in dev (console.error, not a crash) on a duplicate `keys` string that's both
  `"always"` — two "always" shortcuts on the same combo is very likely a mistake; two
  different tools binding the same combo under `"tool-active"` is fine, since only one tool is
  ever active.
- Is introspectable: `listShortcuts()` returns every currently-registered binding, which is
  what both the Settings screen's shortcuts map and the command palette's fuzzy list read from
  — you never need your own separate "shortcuts help" UI.

## Command palette

`paletteCommands(ctx)` returns extra entries beyond the automatic "Activate {tool label}" entry
every registered tool gets for free. `ctx` gives you the currently open doc's `DocId` (or
`null`) and `commands`/`events` (the resolved IPC — same object `src/ipc/index.ts` exports) so
a command can, say, run `pages_delete` directly for a "Delete selected pages" entry without a
UI round-trip through your own panel.

```ts
export interface PaletteCommand {
  id: string;
  labelKey: string;
  run(): void | Promise<void>;
  shortcutId?: string; // if set, the palette shows that shortcut's key combo next to the label
}
```

## Errors, i18n, and dirty state — you don't touch these

- `RubricaError` → human message: call `useRubricaErrorMessage()` (from
  `src/chrome/errors.tsx`) with the error, get back an already-localized string for the current
  language. Don't hand-roll another error-code switch in your tool.
- Undo/redo/dirty: driven entirely by `doc_state_changed`/`save_state` events and the
  `history_*` commands per CONTRACTS — your mutations just need to go through the real IPC
  commands `src/ipc/index.ts` exports; the toolbar's undo/redo buttons and dirty dot update
  themselves, no registration needed.
- i18n: your own namespace file(s) are yours (`tools-annotate`, `tools-pages`, `tools-forms`,
  `tools-textedit`, `tools-redact`), both languages, same nesting convention R1 set (`t(
  "tools-annotate:tools-annotate.section.key")`). Everything under `chrome`/`viewer`/`common`
  (toolbar labels, generic dialog copy, etc.) already exists — reuse `common` keys (save,
  cancel, delete, undo, redo, ...) instead of duplicating them in your own namespace.

## Minimal example

```tsx
// src/tools/annotate/index.ts
import { Highlighter } from "lucide-react";
import { registerTool } from "../../chrome/tool-api";
import { AnnotatePanel } from "./AnnotatePanel";
import { AnnotateOverlay } from "./AnnotateOverlay";

registerTool({
  id: "annotate",
  group: "annotate",
  icon: Highlighter,
  labelKey: "tools-annotate:tools-annotate.toolbar.label",
  toolbarEntry: { order: 20 },
  panel: AnnotatePanel,
  overlayLayer: AnnotateOverlay,
  overlayAlwaysOn: true, // committed annotations stay visible when another tool is active
  shortcuts: [
    { id: "annotate.activate", keys: "mod+h", labelKey: "tools-annotate:tools-annotate.shortcuts.activate",
      when: "always", handler: () => setActiveTool("annotate") },
  ],
});
```

```tsx
// src/App.tsx (R3-owned; one line added per tool package)
import "./tools/annotate";
```
