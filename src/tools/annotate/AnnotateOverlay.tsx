// TOOL-API.md `overlayLayer` adapter around `AnnotationLayer` (R4's prop-driven component, built
// before TOOL-API.md existed — see that file's own header comment). Two jobs this file does that
// `AnnotationLayer` itself can't:
//
// 1. Translate `src/chrome/tool-api.tsx`'s `PageViewport` (`widthPt`/`heightPt`/`zoom`, plus
//    `docId`/`page`/`toScreen`/`toDoc`) into `src/tools/shared/coords.ts`'s DIFFERENTLY-SHAPED
//    same-named `PageViewport` (`pageWidthPt`/`pageHeightPt`/`scale`) that every annotate/forms
//    geometry helper actually uses. A plain field rename, not a coordinate-system change.
// 2. Gate pointer events while this tool isn't the active one. `annotate` registers
//    `overlayAlwaysOn: true` (committed markup stays visible while e.g. the pages tool is active)
//    — R6's own report flagged exactly this pitfall for whoever wired annotate in next: an
//    "always on" overlay's wrapper element needs `pointer-events: none` while inactive, or it
//    silently eats clicks meant for the tool that IS active (see `RedactOverlay.tsx`'s identical
//    fix). `AnnotationLayer`'s own root div has no such prop, so this wraps it in one that does.
import type { ToolOverlayProps } from "../../chrome/tool-api";
import { AnnotationLayer } from "./AnnotationLayer";
import { useAnnotateStore } from "./store";

export function AnnotateOverlay({ viewport, isActive }: ToolOverlayProps) {
  const mode = useAnnotateStore((s) => s.mode);
  const style = useAnnotateStore((s) => s.style);
  const selection = useAnnotateStore((s) => s.selection);
  const setSelection = useAnnotateStore((s) => s.setSelection);

  // Only the page that actually owns the current selection sees a non-null `selectedId` — every
  // other mounted instance (other visible pages) must see `null`, otherwise `AnnotationLayer`'s
  // own window-level Delete/Escape/nudge keyboard handler (one per mounted instance) would act on
  // an id it doesn't recognize as belonging to its page. Same pattern as `TextEditOverlay`'s
  // `selectedHere`.
  //
  // `isActive` gates this too, not just `mode` — a real bug a review caught: `mode` alone being
  // forced to "select" while another tool is active still leaves that same keyboard handler
  // reacting to Delete/Backspace/arrow keys for whatever was selected before the user switched
  // tools (this component keeps rendering — `overlayAlwaysOn: true` — the handler has no idea
  // "select" here means "not actually the active tool"). Pressing Delete meaning to delete a page
  // (say) could silently also delete a previously-selected annotation. Forcing `selectedIdHere` to
  // null while inactive means there's nothing for that handler to touch.
  const selectedIdHere = isActive && selection && selection.docId === viewport.docId && selection.page === viewport.page ? selection.id : null;

  return (
    <div className="absolute left-0 top-0" style={{ pointerEvents: isActive ? "auto" : "none" }}>
      <AnnotationLayer
        docId={viewport.docId}
        page={viewport.page}
        viewport={{ pageWidthPt: viewport.widthPt, pageHeightPt: viewport.heightPt, scale: viewport.zoom }}
        mode={isActive ? mode : "select"}
        style={style}
        selectedId={selectedIdHere}
        onSelectedIdChange={(id) => setSelection(id ? { docId: viewport.docId, page: viewport.page, id } : null)}
      />
    </div>
  );
}
