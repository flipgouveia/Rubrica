// Public entry point for the forms tool (CONTRACTS §3 `forms` domain + `src/chrome/TOOL-API.md`):
// registers itself into the real chrome via `registerTool` on import, mirroring
// `tools/text-edit/index.ts`/`tools/redact/index.ts`'s own pattern — this tool predates
// TOOL-API.md (R4's wave) and was built prop-driven, expecting exactly this kind of wrapper
// wiring later (see this tool's own wave-1 report). `FormsOverlay.tsx` is the viewport-shape
// adapter; `FieldsPanelProps` (`{ docId }`) is already a strict subset of `ToolPanelProps`
// (`{ docId, activeTool }`), so `panel: FieldsPanel` below needs no adapter of its own.
import { ClipboardList } from "lucide-react";
import { registerTool, setActiveTool } from "../../chrome/tool-api";
import { FieldsPanel } from "./FieldsPanel";
import { FormsOverlay } from "./FormsOverlay";

registerTool({
  id: "forms",
  group: "forms",
  icon: ClipboardList,
  labelKey: "tools-forms:tools-forms.toolbar.label",
  toolbarEntry: { order: 30 },
  panel: FieldsPanel,
  overlayLayer: FormsOverlay,
  shortcuts: [
    {
      id: "forms.activate",
      // Was mod+shift+f; that combo now opens the docked search panel (search v2, B8/B12).
      keys: "mod+alt+f",
      labelKey: "tools-forms:tools-forms.shortcuts.activate",
      when: "always",
      handler: () => setActiveTool("forms"),
    },
  ],
});

// Public API of the forms tool. Whoever eventually mounts this into the
// real app shell (R3's TOOL-API, wave 2) should only need these exports —
// internal helpers (fieldFocusRegistry.ts, per-kind editors, etc.) stay
// unexported from here on purpose.
export { FormsOverlay } from "./FormsOverlay";
export { FieldOverlay } from "./FieldOverlay";
export type { FieldOverlayProps, PageViewport } from "./FieldOverlay";
export { FieldsPanel } from "./FieldsPanel";
export type { FieldsPanelProps } from "./FieldsPanel";
export { useFormFields } from "./useFormFields";
export type { SetValueOutcome, UseFormFieldsResult } from "./useFormFields";
export { sortFieldsInDocumentOrder } from "./sortFieldsInDocumentOrder";
