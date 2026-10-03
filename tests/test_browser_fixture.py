"""Keep the browser fixture readable by the application's actual PDF engines."""
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader
from pypdf.generic import IndirectObject

from browser_support import TITLE, fixture
from easyread import pdfwork


class BrowserFixtureTest(unittest.TestCase):
    def test_generated_pdf_renders_and_extracts_both_pages(self):
        with tempfile.TemporaryDirectory(prefix="folio-fixture-test-") as directory:
            root = Path(directory)
            fixture(root / "source.pdf")
            document = PdfReader(root / "source.pdf")
            self.assertEqual(document.metadata.title, TITLE)
            self.assertEqual(len(document.pages), 2)
            for page in document.pages:
                self.assertIsInstance(page.raw_get("/Contents"), IndirectObject)

            # Uses PDFium for rendering/text and pdfplumber for character boxes,
            # exactly as the real import background job does.
            pages = pdfwork.prepare(root)
            self.assertEqual(len(pages), 2)
            for number in (1, 2):
                text = (root / "extract" / f"page-{number:03d}.txt").read_text(encoding="utf-8")
                self.assertIn(TITLE, text)
                self.assertIn(f"Synthetic page {number}", text)
                self.assertTrue((root / "pages" / f"page-{number:03d}.webp").is_file())


if __name__ == "__main__":
    unittest.main()
