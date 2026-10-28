"""Generate a flat-color placeholder app icon (no external deps).

Wave-0 placeholder only: a solid markup-red square with a lighter inset
square (a crude "R" mark stand-in). Real branding replaces this later.
"""

import struct
import zlib
import sys

SIZE = 1024
BG = (0xA3, 0x24, 0x3A, 255)  # markup-red
FG = (0xF4, 0xE7, 0xE9, 255)  # light inset


def make_rows(size: int):
    inset = size // 4
    for y in range(size):
        row = bytearray([0])  # filter type 0 (none)
        for x in range(size):
            if inset <= x < size - inset and inset <= y < size - inset:
                r, g, b, a = FG
            else:
                r, g, b, a = BG
            row += bytes([r, g, b, a])
        yield bytes(row)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, size: int) -> None:
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = b"".join(make_rows(size))
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "icon-source.png"
    write_png(out, SIZE)
    print(f"wrote {out}")
