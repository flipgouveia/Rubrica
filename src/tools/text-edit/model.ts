// Cross-instance state for the text-edit tool (CONTRACTS §3 `textedit` domain).
//
// `ToolPanelProps`/`ToolOverlayProps` (TOOL-API.md) mount the panel and one
// overlay instance PER VISIBLE PAGE as siblings with no common parent this
// tool controls — R3's chrome owns the layout around them (see
// `AppShell.tsx`: the panel sits in the right rail, overlays sit inside each
// page's `PageCanvas`). So "which mode is the tool in", "what style should a
// newly-placed text box use", "what path should a newly-placed image use",
// and "which object is currently selected" can't live as local component
// state in any one of them — they need a store all of them can read and
// write. A small zustand store (already a dependency, see
// `src/chrome/tool-api.tsx`) does that job without inventing a second
// mechanism.
import { create } from "zustand";
import type { DocId } from "../../viewer/types";

export type TextEditMode = "select" | "addText" | "addImage";

export interface NewTextStyle {
  fontSize: number;
  color: string;
}

/** Reasonable, boring defaults — this is deliberately not a rich text editor (see panel copy). */
export const DEFAULT_NEW_TEXT_STYLE: NewTextStyle = { fontSize: 12, color: "#000000" };

/** Anchor size (PDF points) used when a user clicks once instead of dragging to size a new object. */
export const DEFAULT_TEXT_RECT_SIZE_PT = { width: 160, height: 20 };
export const DEFAULT_IMAGE_RECT_SIZE_PT = { width: 120, height: 120 };

export interface TextEditSelection {
  docId: DocId;
  page: number;
  objectId: string;
}

interface TextEditState {
  mode: TextEditMode;
  newTextStyle: NewTextStyle;
  /** Typed destination path for the next `imageobj_add` — see `SaveAsDialog.tsx`'s header comment for why this is a plain text input rather than a native file picker. */
  imagePath: string;
  selection: TextEditSelection | null;
  setMode: (mode: TextEditMode) => void;
  setNewTextStyle: (patch: Partial<NewTextStyle>) => void;
  setImagePath: (path: string) => void;
  setSelection: (selection: TextEditSelection | null) => void;
}

export const useTextEditStore = create<TextEditState>((set) => ({
  mode: "select",
  newTextStyle: DEFAULT_NEW_TEXT_STYLE,
  imagePath: "",
  selection: null,
  setMode: (mode) => set({ mode }),
  setNewTextStyle: (patch) => set((state) => ({ newTextStyle: { ...state.newTextStyle, ...patch } })),
  setImagePath: (imagePath) => set({ imagePath }),
  setSelection: (selection) => set({ selection }),
}));
