// Public entry point for the annotate tool (CONTRACTS §3 `annotations` domain +
// `src/chrome/TOOL-API.md`): registers itself into the real chrome via `registerTool` on import,
// mirroring `tools/text-edit/index.ts`/`tools/redact/index.ts`'s own pattern — this tool and
// `tools/pages` predate TOOL-API.md (R4's wave) and were built prop-driven, expecting exactly
// this kind of wrapper wiring later (see this tool's own wave-1 report). `AnnotateOverlay.tsx`/
// `AnnotatePanel.tsx` are the adapters; `store.ts` is the cross-page lifted state they share.
import { Highlighter } from "lucide-react";
import { registerTool, setActiveTool } from "../../chrome/tool-api";
import { AnnotateOverlay } from "./AnnotateOverlay";
import { AnnotatePanel } from "./AnnotatePanel";

registerTool({
  id: "annotate",
  group: "annotate",
  icon: Highlighter,
  labelKey: "tools-annotate:tools-annotate.toolbar.label",
  toolbarEntry: { order: 20 },
  panel: AnnotatePanel,
  overlayLayer: AnnotateOverlay,
  // Committed annotations (highlights, notes, shapes, ...) are standard PDF content — they stay
  // visible while another tool is active, matching how a real PDF viewer layers markup over the
  // page regardless of which editing mode is selected. `AnnotateOverlay`'s own `isActive` gates
  // the interactive parts (drawing, selecting, keyboard delete) accordingly.
  overlayAlwaysOn: true,
  shortcuts: [
    {
      id: "annotate.activate",
      keys: "mod+h",
      labelKey: "tools-annotate:tools-annotate.shortcuts.activate",
      when: "always",
      handler: () => setActiveTool("annotate"),
    },
  ],
});

// Public API of the annotation tool. Whoever eventually mounts this into
// the real app shell (R3's TOOL-API, wave 2) should only need these exports
// — internal helpers (interaction.ts, useRafBatch.ts, etc.) stay unexported
// from here on purpose.
export { AnnotateOverlay } from "./AnnotateOverlay";
export { AnnotatePanel } from "./AnnotatePanel";
export { AnnotationLayer } from "./AnnotationLayer";
export type { AnnotationLayerProps } from "./AnnotationLayer";
export { AnnotationToolbar } from "./AnnotationToolbar";
export type { AnnotationToolbarProps } from "./AnnotationToolbar";
export { DEFAULT_ANNOTATION_STYLE, isMarkupMode } from "./model";
export type { AnnotationMode, AnnotationStyle } from "./model";
export { deriveQuadpointsFromSelectionRects } from "./selection";
export { smoothStrokePoints } from "./smoothing";
export { applyBBoxToAnnot, getAnnotBBox, isAnnotResizable, NOTE_ICON_SIZE_PT } from "./geometry";
export type { AnnotGeometryPatch } from "./geometry";
