// Groups per-char boxes within [start, end) into one rect per visual text line, rather than one
// rect per character — matches how real text selection renders. PDFium reports each glyph's own
// tight bounds, so `y`/`height` differ from glyph to glyph on the same line (x-height vs
// ascender vs descender); lines are therefore recognised by vertical OVERLAP between consecutive
// boxes in reading order, never by comparing `y` for equality, and every line rect spans the
// union of its glyphs (uniform top/bottom). No dependency on the mock's layout constants.
import type { CharBox, Rect } from "../../ipc/bindings";

/** Share of the smaller of two heights that must overlap vertically for a box to join the current line. */
const SAME_LINE_OVERLAP = 0.5;

interface Line {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function sameLine(line: Line, minY: number, maxY: number): boolean {
  const overlap = Math.min(line.maxY, maxY) - Math.max(line.minY, minY);
  return overlap > SAME_LINE_OVERLAP * Math.min(line.maxY - line.minY, maxY - minY);
}

/**
 * One rect (the union of its glyph boxes) per visual line of `[start, end)`, in reading order.
 * Lines are NOT clipped against each other (descenders may poke into the next line's ascenders),
 * so this is the right input for annotation quads and redaction marks, which must cover all the
 * ink; use `toDisplayBands` before painting.
 */
export function buildHighlightRects(boxes: CharBox[], start: number, end: number): Rect[] {
  const relevant = boxes.filter((box) => box.charIndex >= start && box.charIndex < end).sort((a, b) => a.charIndex - b.charIndex);

  const lines: Line[] = [];
  for (const { rect } of relevant) {
    const width = rect.width ?? 0;
    const height = rect.height ?? 0;
    if (!(width > 0) || !(height > 0)) continue; // zero-sized glyphs (generated spaces, newlines) would only skew the line's extent
    const x = rect.x ?? 0;
    const y = rect.y ?? 0;
    const current = lines[lines.length - 1];
    if (current && sameLine(current, y, y + height)) {
      current.minX = Math.min(current.minX, x);
      current.maxX = Math.max(current.maxX, x + width);
      current.minY = Math.min(current.minY, y);
      current.maxY = Math.max(current.maxY, y + height);
    } else {
      lines.push({ minX: x, maxX: x + width, minY: y, maxY: y + height });
    }
  }

  return lines.map((line) => ({ x: line.minX, y: line.minY, width: line.maxX - line.minX, height: line.maxY - line.minY }));
}

/**
 * Display-only pass over `buildHighlightRects` output: where two lines overlap both horizontally
 * and vertically (tall ascenders / deep descenders on tightly leaded text), the shared vertical
 * strip is split at its middle, so the painted bands abut instead of overlapping. Input rects are
 * not mutated.
 */
export function toDisplayBands(rects: Rect[]): Rect[] {
  const bands = rects.map((rect) => ({ left: rect.x ?? 0, right: (rect.x ?? 0) + (rect.width ?? 0), bottom: rect.y ?? 0, top: (rect.y ?? 0) + (rect.height ?? 0) }));
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i];
      const b = bands[j];
      if (Math.min(a.right, b.right) <= Math.max(a.left, b.left)) continue;
      const [upper, lower] = a.bottom + a.top >= b.bottom + b.top ? [a, b] : [b, a];
      // Only a partial overlap is a seam; one band swallowing the other is left alone.
      if (lower.top <= upper.bottom || upper.bottom <= lower.bottom || lower.top >= upper.top) continue;
      const middle = (upper.bottom + lower.top) / 2;
      upper.bottom = middle;
      lower.top = middle;
    }
  }
  return bands.map((band) => ({ x: band.left, y: band.bottom, width: band.right - band.left, height: band.top - band.bottom }));
}
