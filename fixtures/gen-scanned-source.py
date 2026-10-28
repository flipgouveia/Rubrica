"""Generate a synthetic "scanned page" raster image with no external deps.

Writes fixtures/scanned-source.png: a faux 200dpi US-Letter scan (1700x2200)
made of an off-white background with dark-gray horizontal bands standing in
for lines of printed text. It is deliberately NOT real text — the resulting
image, once embedded into fixtures/scanned.pdf (by fixtures/generate.mjs),
gives that fixture no extractable text layer at all, which is the point:
PDFium has nothing to select or search on it.

Same hand-rolled PNG technique as scripts/gen-placeholder-icon.py (raw IHDR/
IDAT/IEND chunks via struct + zlib, no Pillow). Deterministic: re-running this
script always produces byte-identical output, so scanned-source.png is
committed but can be regenerated any time with `python fixtures/gen-scanned-source.py`.
"""

import struct
import sys
import zlib

WIDTH = 1700
HEIGHT = 2200

BG = (250, 248, 244)  # off-white page
LINE = (120, 118, 114)  # dark-gray "text line" band
RULE = (200, 197, 190)  # faint header rule

LEFT_MARGIN = 170
RIGHT_MARGIN = 170
LINE_HEIGHT = 34  # vertical pitch between simulated text lines
LINE_THICKNESS = 14  # thickness of each simulated text line band
BLOCK_GAP = 40  # blank rows between paragraph blocks
TOP_MARGIN = 220

# Ragged-right widths (as a fraction of the available text width), cycled
# deterministically to avoid every line looking identical.
WIDTH_RATIOS = [0.94, 0.82, 0.97, 0.68, 0.90, 0.76, 0.99, 0.58]


def build_row(is_line: bool, ratio: float) -> bytes:
    row = bytearray([0])  # PNG filter type 0 (none)
    bg = bytes(BG)
    line = bytes(LINE)
    if not is_line:
        row += bg * WIDTH
        return bytes(row)

    text_width = WIDTH - LEFT_MARGIN - RIGHT_MARGIN
    band_width = int(text_width * ratio)
    row += bg * LEFT_MARGIN
    row += line * band_width
    row += bg * (WIDTH - LEFT_MARGIN - band_width)
    return bytes(row)


def build_rule_row() -> bytes:
    row = bytearray([0])
    bg = bytes(BG)
    rule = bytes(RULE)
    row += bg * LEFT_MARGIN
    row += rule * (WIDTH - LEFT_MARGIN - RIGHT_MARGIN)
    row += bg * RIGHT_MARGIN
    return bytes(row)


def make_rows():
    blank_row = bytes(bytearray([0]) + bytes(BG) * WIDTH)
    line_index = 0

    y = 0
    while y < HEIGHT:
        if y < TOP_MARGIN - 30:
            yield blank_row
            y += 1
            continue

        # A faint horizontal rule marks a "header" band near the top.
        if TOP_MARGIN - 30 <= y < TOP_MARGIN - 24:
            yield build_rule_row()
            y += 1
            continue

        if y < TOP_MARGIN:
            yield blank_row
            y += 1
            continue

        # From here down: repeating simulated paragraphs until the bottom
        # margin, each a handful of "text line" bands separated by leading,
        # with a larger gap between paragraph blocks.
        remaining = HEIGHT - TOP_MARGIN
        cycle = (LINE_HEIGHT * 6) + BLOCK_GAP
        pos_in_cycle = (y - TOP_MARGIN) % cycle
        if pos_in_cycle >= LINE_HEIGHT * 6:
            yield blank_row  # paragraph gap
            y += 1
            continue

        pos_in_line = pos_in_cycle % LINE_HEIGHT
        if pos_in_line < LINE_THICKNESS and y < HEIGHT - 150:
            this_line_no = (y - TOP_MARGIN) // LINE_HEIGHT
            ratio = WIDTH_RATIOS[this_line_no % len(WIDTH_RATIOS)]
            yield build_row(True, ratio)
        else:
            yield blank_row
        y += 1


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str) -> None:
    sig = b"\x89PNG\r\n\x1a\n"
    # Color type 2 = truecolor (RGB, no alpha), 8 bits/sample.
    ihdr = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0)
    raw = b"".join(make_rows())
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "scanned-source.png"
    write_png(out)
    print(f"wrote {out} ({WIDTH}x{HEIGHT})")
