// Public entry point for the pages tool (CONTRACTS §3 `pages` domain + `src/chrome/TOOL-API.md`):
// registers itself into the real chrome via `registerTool` on import, mirroring
// `tools/text-edit/index.ts`/`tools/redact/index.ts`'s own pattern — this tool predates
// TOOL-API.md (R4's wave) and was built as a standalone, self-contained `<PagesPanel docId>`
// expecting exactly this kind of wrapper wiring later (see this tool's own wave-1 report:
// "re-hosting it inside chrome later should be a wrapper, not a rewrite"). `PagesPanelProps`
// (`{ docId }`) is a strict subset of `ToolPanelProps` (`{ docId, activeTool }`), so no adapter
// component is needed — `panel: PagesPanel` below just ignores the extra `activeTool` prop.
import { FileStack } from "lucide-react";
import { registerTool, setActiveTool } from "../../chrome/tool-api";
import { PagesPanel } from "./PagesPanel";

registerTool({
  id: "pages",
  group: "pages",
  icon: FileStack,
  labelKey: "tools-pages:tools-pages.toolbar.label",
  toolbarEntry: { order: 10 },
  panel: PagesPanel,
  // No overlay/rail extension: `PagesPanel` is a full standalone thumbnail-grid editor (its own
  // thumbnails, its own drag reorder) rather than a decoration over R3's view-only rail — see its
  // own header comment.
  shortcuts: [
    {
      id: "pages.activate",
      keys: "mod+shift+p",
      labelKey: "tools-pages:tools-pages.shortcuts.activate",
      when: "always",
      handler: () => setActiveTool("pages"),
    },
  ],
});

export { PagesPanel } from "./PagesPanel";
export type { PagesPanelProps } from "./PagesPanel";
export { buildReorderedIndices, computeDropIndex } from "./dnd";
export type { PointLike, RectLike } from "./dnd";
