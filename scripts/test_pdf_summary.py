"""The PDF export tells the model its page count, size and text per page, so it never needs a shell to check."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import design_export


def pdf(pages):
    """A minimal US Letter PDF; each page shows the given text in Helvetica (empty string: a blank page)."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text in pages:
        stream = f"BT /F1 12 Tf 72 700 Td ({text}) Tj ET".encode() if text else b""
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode().decode() + stream.decode() + "\nendstream")
        content = len(objects)
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content} 0 R "
                       "/Resources << /Font << /F1 3 0 R >> >> >>")
        kids.append(f"{len(objects)} 0 R")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    out, offsets = b"%PDF-1.4\n", []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


class PdfSummaryTests(unittest.TestCase):
    def test_counts_pages_size_and_text(self):
        body = "The defense theory of the case in one clear and readable line of text for the page."
        summary = design_export.pdf_summary(pdf([body, body, body]))
        self.assertIn("The PDF has 3 pages (US Letter)", summary)
        self.assertIn(f"1: {len(body)}", summary)
        self.assertNotIn("almost no text", summary)

    def test_flags_a_spill_over_page(self):
        body = "A full page of the guide with plenty of words on it so it counts as a real page."
        summary = design_export.pdf_summary(pdf([body, body, "End."]))
        self.assertIn("Page 3 has almost no text", summary)
        self.assertIn("The PDF has 3 pages", summary)

    def test_a_short_cover_is_fine(self):
        body = "A full page of the guide with plenty of words on it so it counts as a real page."
        self.assertNotIn("almost no text", design_export.pdf_summary(pdf(["Cover", body])))


if __name__ == "__main__":
    unittest.main()
