// Derives markup quadpoints from a text selection's line-by-line bounding
// boxes.
//
// R3's real text-selection API/UI (per CONTRACTS §3's `text_page_layout`)
// doesn't exist yet — this models what it would hand a markup tool: a list
// of screen-space rectangles, one per visual line the selection spans (a
// selection wrapping two lines yields two rects, not one bbox spanning both,
// so a highlight correctly follows line breaks instead of covering the gap
// between them). `deriveQuadpointsFromSelectionRects` is the pure seam
// between "however a selection got made" and "what `annot_add`'s
// `highlight`/`underline`/`strikeout` variants need" — wired to a hardcoded
// stand-in trigger in `dev/AnnotateHarness.tsx` until R3 ships the real
// thing.
import type { QuadPoint } from "../../ipc/bindings";
import type { PageViewport, ScreenRect } from "../shared/coords";
import { screenRectToQuad } from "../shared/coords";

/** One `QuadPoint` per input rect, via `screenRectToQuad` (see that function's own comment for the PDF-space y-flip). */
export function deriveQuadpointsFromSelectionRects(rects: readonly ScreenRect[], viewport: PageViewport): QuadPoint[] {
  return rects.map((rect) => screenRectToQuad(rect, viewport));
}
