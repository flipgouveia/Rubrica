"""Generate fixtures/encrypted.pdf: a password-protected copy of text.pdf.

pdf-lib cannot write PDF encryption, so this one-off step uses pypdf (MIT
licensed, pure Python) instead. Run once (or whenever text.pdf's content
changes):

    pip install pypdf cryptography   # one-time (cryptography backs AES-256)
    python fixtures/gen-encrypted.py

The result (fixtures/encrypted.pdf) is committed to the repo like any other
binary fixture (see fixtures/pdfium.dll-style precedent) — it does not need
to regenerate on every install, only when deliberately refreshed.

Password: both the user password (required to OPEN the file) and the owner
password (required to change permissions) are set to the same value,
"rubrica-test", using AES-256 (PDF 2.0 / R6) encryption. A non-empty user
password is what actually exercises Rubrica's ENCRYPTED error path — a
document with only an owner password set still opens without a prompt in
essentially every reader, which would defeat the point of this fixture.
"""

import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter

PASSWORD = "rubrica-test"


def main() -> None:
    fixtures_dir = Path(__file__).parent
    source = fixtures_dir / "text.pdf"
    dest = fixtures_dir / "encrypted.pdf"

    if not source.exists():
        print(f"error: {source} does not exist yet — run `pnpm fixtures:generate` first", file=sys.stderr)
        sys.exit(1)

    reader = PdfReader(str(source))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)

    writer.encrypt(user_password=PASSWORD, owner_password=PASSWORD, algorithm="AES-256")

    with open(dest, "wb") as f:
        writer.write(f)

    print(f"wrote {dest} (password: {PASSWORD!r}, {len(reader.pages)} page(s))")


if __name__ == "__main__":
    main()
