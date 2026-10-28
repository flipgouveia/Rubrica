"""Hand-build a minimal, valid 2-page PDF with no external dependencies.

Used only by the R1 pdfium smoke test (src-tauri/tests/pdfium_smoke.rs), which must
exist before the richer fixtures corpus (fixtures/generate.mjs, pdf-lib-based) does.
Deliberately tiny and dependency-free so the "hardest build problem" smoke test has
zero prerequisites of its own.
"""

import sys


def build_pdf(page_count: int) -> bytes:
    objects: list[bytes] = []

    def obj(n: int, body: bytes) -> bytes:
        return f"{n} 0 obj\n".encode() + body + b"\nendobj\n"

    page_ids = list(range(3, 3 + page_count))
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)

    objects.append(obj(1, b"<< /Type /Catalog /Pages 2 0 R >>"))
    objects.append(
        obj(
            2,
            f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>".encode(),
        )
    )

    content_id = 3 + page_count
    font_id = content_id + 1

    for i, pid in enumerate(page_ids, start=1):
        objects.append(
            obj(
                pid,
                (
                    "<< /Type /Page /Parent 2 0 R "
                    "/MediaBox [0 0 612 792] "
                    f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
                    f"/Contents {content_id} 0 R >>"
                ).encode(),
            )
        )

    stream = (
        f"BT /F1 24 Tf 72 700 Td (Rubrica smoke fixture - page {{}} of {page_count}) Tj ET"
    ).encode()
    # One shared content stream reused by every page (fine for a synthetic fixture;
    # the page number in the text is literal, not per-page, to keep this simple).
    content_body = stream.replace(b"{}", b"1")
    content_stream = (
        f"<< /Length {len(content_body)} >>\nstream\n".encode()
        + content_body
        + b"\nendstream"
    )
    objects.append(obj(content_id, content_stream))

    objects.append(
        obj(
            font_id,
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        )
    )

    header = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"

    body = bytearray()
    offsets = [0]  # object 0 is the free-list head
    pos = len(header)
    body += header

    # Objects must be emitted in ascending id order for a simple xref table.
    ordered = sorted(
        objects,
        key=lambda o: int(o.split(b" ", 1)[0]),
    )
    for o in ordered:
        offsets.append(pos)
        body += o
        pos += len(o)

    xref_offset = pos
    total_objs = len(offsets)
    xref = f"xref\n0 {total_objs}\n".encode()
    xref += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        xref += f"{off:010d} 00000 n \n".encode()

    trailer = (
        f"trailer\n<< /Size {total_objs} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode()

    return bytes(body) + xref + trailer


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "tiny.pdf"
    pages = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    with open(out, "wb") as f:
        f.write(build_pdf(pages))
    print(f"wrote {out} ({pages} pages)")
