// Pure hit-testing: which char (by center-point distance) is closest to a point in PDF-point
// space. Kept separate from the mouse-handling hook so it's directly unit-testable.
import type { CharBox } from "../../ipc/bindings";

export function nearestCharIndex(boxes: CharBox[], docX: number, docY: number): number {
  if (boxes.length === 0) return 0;
  let best = boxes[0].charIndex;
  let bestDist = Infinity;
  for (const box of boxes) {
    const cx = (box.rect.x ?? 0) + (box.rect.width ?? 0) / 2;
    const cy = (box.rect.y ?? 0) + (box.rect.height ?? 0) / 2;
    const dx = cx - docX;
    const dy = cy - docY;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = box.charIndex;
    }
  }
  return best;
}
