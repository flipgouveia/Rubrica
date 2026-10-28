// Public entry point for the text-edit tool (CONTRACTS §3 `textedit`
// domain / R6 brief). Registers with the real chrome via TOOL-API.md's
// `registerTool` as a side effect of importing this module — add
// `import "./tools/text-edit";` once to `src/App.tsx` (R3-owned, see
// TOOL-API.md) to wire it in; this package never touches App.tsx itself.
//
// `order: 40`: none of annotate/pages/forms register a `toolbarEntry` yet
// (they predate TOOL-API.md — see their own index.ts files), so there is no
// existing order to slot in next to. 40 leaves headroom below and above for
// whatever those three eventually pick, and for the sibling `redact` tool
// being built in parallel right now.
import { PenLine } from "lucide-react";
import { registerTool, setActiveTool } from "../../chrome/tool-api";
import { TextEditOverlay } from "./TextEditOverlay";
import { TextEditPanel } from "./TextEditPanel";

registerTool({
  id: "text-edit",
  group: "textedit",
  icon: PenLine,
  labelKey: "tools-textedit:tools-textedit.toolbar.label",
  toolbarEntry: { order: 40 },
  panel: TextEditPanel,
  overlayLayer: TextEditOverlay,
  shortcuts: [
    {
      id: "text-edit.activate",
      keys: "mod+e",
      labelKey: "tools-textedit:tools-textedit.shortcuts.activate",
      when: "always",
      handler: () => setActiveTool("text-edit"),
    },
  ],
});

export { TextEditOverlay } from "./TextEditOverlay";
export { TextEditPanel } from "./TextEditPanel";
export { deleteSelectedTextObject } from "./actions";
export { DEFAULT_IMAGE_RECT_SIZE_PT, DEFAULT_NEW_TEXT_STYLE, DEFAULT_TEXT_RECT_SIZE_PT, useTextEditStore } from "./model";
export type { NewTextStyle, TextEditMode, TextEditSelection } from "./model";
export { substitutionKey, useSubstitutionStore } from "./substitutionStore";
