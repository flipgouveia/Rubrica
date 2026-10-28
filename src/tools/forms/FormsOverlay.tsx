// TOOL-API.md `overlayLayer` adapter around `FieldOverlay` (R4's prop-driven component, built
// before TOOL-API.md existed — see that file's own header comment). Translates
// `src/chrome/tool-api.tsx`'s `PageViewport` (`widthPt`/`heightPt`/`zoom`, plus `docId`/`page`/
// `toScreen`/`toDoc`) into `src/tools/shared/coords.ts`'s differently-shaped same-named
// `PageViewport` (`pageWidthPt`/`pageHeightPt`/`scale`) `FieldOverlay` actually uses — a plain
// field rename, not a coordinate-system change (see `tools/annotate/AnnotateOverlay.tsx` for the
// identical translation). No `isActive` gating needed here: unlike `annotate`/`redact`, the forms
// tool doesn't register `overlayAlwaysOn`, so `useOverlayTools()` only ever mounts this while
// forms IS the active tool (`src/chrome/tool-api.tsx`'s `useOverlayTools`) — `isActive` is
// therefore always `true` whenever this renders at all.
import type { ToolOverlayProps } from "../../chrome/tool-api";
import { FieldOverlay } from "./FieldOverlay";

export function FormsOverlay({ viewport }: ToolOverlayProps) {
  return (
    <FieldOverlay
      docId={viewport.docId}
      page={viewport.page}
      viewport={{ pageWidthPt: viewport.widthPt, pageHeightPt: viewport.heightPt, scale: viewport.zoom }}
    />
  );
}
