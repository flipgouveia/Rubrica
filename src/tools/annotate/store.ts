// Cross-instance state for the annotate tool (CONTRACTS §3 `annotations` domain), needed only
// once this tool is actually mounted through TOOL-API.md instead of `dev/AnnotateHarness.tsx`.
//
// `AnnotationLayer`/`AnnotationToolbar` were built (R4) as prop-driven siblings expecting a host
// to lift `{ mode, style, selectedId }` above both — see `model.ts`'s header comment. Under the
// real chrome, `overlayLayer` mounts one `AnnotationLayer` PER VISIBLE PAGE with no common parent
// this tool controls (see `TextEditOverlay`'s `model.ts` for the identical problem R6 solved the
// same way), so that lifted state has to live in a store all instances share, not local state in
// any one of them.
import { create } from "zustand";
import { DEFAULT_ANNOTATION_STYLE, type AnnotationMode, type AnnotationStyle } from "./model";

export interface AnnotateSelection {
  docId: string;
  page: number;
  id: string;
}

interface AnnotateState {
  mode: AnnotationMode;
  style: AnnotationStyle;
  selection: AnnotateSelection | null;
  setMode: (mode: AnnotationMode) => void;
  setStyle: (patch: Partial<AnnotationStyle>) => void;
  setSelection: (selection: AnnotateSelection | null) => void;
}

export const useAnnotateStore = create<AnnotateState>((set) => ({
  mode: "select",
  style: DEFAULT_ANNOTATION_STYLE,
  selection: null,
  setMode: (mode) => set({ mode }),
  setStyle: (patch) => set((state) => ({ style: { ...state.style, ...patch } })),
  setSelection: (selection) => set({ selection }),
}));
