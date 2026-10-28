// Public entry point for the redact tool (CONTRACTS §3's `redact` domain + `src/chrome/TOOL-API.md`):
// registers itself into the chrome via `registerTool` on import. Importing this module once from
// `src/App.tsx` (`import "./tools/redact";`) is the only integration point the real chrome needs —
// see this tool's own report for that exact line, since App.tsx belongs to the orchestrator/R3,
// not this tool (mirrors how `tools/annotate/index.ts` and `tools/pages/index.ts` are meant to be
// wired in, per TOOL-API.md's own minimal example).
import { Scissors } from "lucide-react";
import { registerTool, setActiveTool } from "../../chrome/tool-api";
import { useViewerStore } from "../../viewer/store";
import { markSelectionAsPendingMarks } from "./actions";
import { RedactOverlay } from "./RedactOverlay";
import { RedactPanel } from "./RedactPanel";

registerTool({
  id: "redact",
  group: "redact",
  icon: Scissors,
  labelKey: "tools-redact:tools-redact.toolbar.label",
  // No tool currently registers a toolbar entry yet (annotate/pages/forms aren't wired into the
  // real chrome as of this wave) — 50 leaves plenty of room on either side for whoever's next.
  toolbarEntry: { order: 50 },
  panel: RedactPanel,
  overlayLayer: RedactOverlay,
  // Pending (not-yet-applied) marks stay visible even while another tool is briefly active, so a
  // user never loses track of an unapplied redaction just by clicking over to another tool —
  // `RedactOverlay`'s own `isActive` gates the interactive parts (drawing, removing) accordingly.
  overlayAlwaysOn: true,
  shortcuts: [
    {
      id: "redact.activate",
      keys: "mod+shift+r",
      labelKey: "tools-redact:tools-redact.shortcuts.activate",
      when: "always",
      handler: () => setActiveTool("redact"),
    },
    {
      id: "redact.markSelection",
      keys: "mod+shift+m",
      labelKey: "tools-redact:tools-redact.shortcuts.markSelection",
      when: "tool-active",
      handler: () => {
        const docId = useViewerStore.getState().activeTabId;
        if (docId) void markSelectionAsPendingMarks(docId);
      },
    },
  ],
});

export { RedactOverlay } from "./RedactOverlay";
export { RedactPanel } from "./RedactPanel";
export { ConfirmRedactDialog } from "./ConfirmRedactDialog";
export { applyPendingMarks } from "./apply";
export type { ApplyResult } from "./apply";
export { groupMarksByPage, groupMarksForDisplay } from "./grouping";
export type { MarkDisplayGroup, MarkGroup } from "./grouping";
export { useMarksForDoc, useMarksForPage, useRedactStore } from "./model";
export type { PendingMark } from "./model";
export { markSelectionAsPendingMarks, useHasMarkableSelection } from "./actions";
export { computeMarkRectsForPage, computeMarksFromSelection, pagesSpannedBySelection } from "./selectionToMarks";
export type { SelectionMark } from "./selectionToMarks";
