"""配图的真实 PDF 裁剪、持久化、页图回退与离线导出。"""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, NumberObject, DecodedStreamObject

from easyread import figures, pdfwork, paperdata
from easyread.build import build
from easyread.store import Workspace, file_version, write_json_atomic


def sample_pdf(path):
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=800)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    image = DecodedStreamObject()
    image.set_data(bytes([40, 100, 200]) * 80 * 40)
    image.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
                  NameObject('/Width'): NumberObject(80), NameObject('/Height'): NumberObject(40),
                  NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8)})
    page[NameObject('/Resources')] = DictionaryObject({
        NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)}),
        NameObject('/XObject'): DictionaryObject({NameObject('/Im1'): writer._add_object(image)})})
    content = DecodedStreamObject()
    content.set_data(b'BT /F1 12 Tf 75 650 Td (Table 1. Unrelated table.) Tj ET\n'
                     b'q 450 0 0 180 75 340 cm /Im1 Do Q\n'
                     b'BT /F1 12 Tf 75 320 Td (Figure 1. Research framework.) Tj ET\n'
                     b'q 450 0 0 140 75 100 cm /Im1 Do Q\n'
                     b'BT /F1 12 Tf 75 80 Td (Figure 2. Validation results.) Tj ET\n')
    page[NameObject('/Contents')] = writer._add_object(content)
    with path.open('wb') as stream:
        writer.write(stream)


class FiguresTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Workspace(Path(self.tmp.name))
        self.blocks = [
            {'id': 'fig1', 'type': 'figure', 'num': '1', 'page': 1, 'src': '',
             'caption_en': 'Figure 1. Research framework.', 'caption_zh': '图 1：研究框架'},
            {'id': 'fig2', 'type': 'figure', 'num': '2', 'page': 1, 'src': '',
             'caption_en': 'Figure 2. Validation results.', 'caption_zh': '图 2：验证结果'}]
        sample_pdf(self.ws.root / 'source.pdf')
        pages = pdfwork.prepare(self.ws.root)
        write_json_atomic(self.ws.paper_path, {'meta': {'pages': pages, 'custom': 'keep'}, 'blocks': self.blocks})
        write_json_atomic(self.ws.reader_path, {'notes': {'n1': {'body': '读者笔记'}}, 'edits': {'fig1#caption': {'zh': '我的图注'}}})
        self.reader_before = self.ws.reader_path.read_bytes()

    def tearDown(self):
        self.tmp.cleanup()

    def test_pdf_geometry_excludes_table_and_separates_figures(self):
        pdfwork.locate(self.ws.root)
        self.assertEqual(figures.ensure(self.ws), 2)
        p = self.ws.load('paper')
        first, second = p['blocks']
        self.assertAlmostEqual(first['image_box'][1], .348, places=3)
        self.assertAlmostEqual(first['image_box'][3], .577, places=3)
        self.assertAlmostEqual(second['image_box'][1], .698, places=3)
        self.assertAlmostEqual(second['image_box'][3], .877, places=3)
        for b in p['blocks']:
            with Image.open(self.ws.root / b['src']) as im:
                self.assertEqual(im.size, (b['image_width'], b['image_height']))
                blue = im.getpixel((im.width // 2, im.height // 2))
                self.assertGreater(blue[2], blue[0] + 100)
        self.assertEqual(self.ws.load('layout')['fig1']['src'], 'figure')
        self.assertEqual(p['meta']['custom'], 'keep')
        self.assertEqual(self.ws.reader_path.read_bytes(), self.reader_before)

    def test_reopen_is_idempotent_and_missing_asset_can_be_repaired(self):
        figures.ensure(self.ws)
        version = file_version(self.ws.paper_path)
        self.assertFalse(figures.pending(self.ws))
        self.assertEqual(figures.ensure(self.ws), 0)
        self.assertEqual(file_version(self.ws.paper_path), version)
        (self.ws.root / self.ws.load('paper')['blocks'][0]['src']).unlink()
        self.assertTrue(figures.pending(self.ws))
        self.assertEqual(figures.ensure(self.ws), 1)

    def test_model_region_and_page_image_fallback(self):
        (self.ws.root / 'source.pdf').unlink()
        self.ws.update('paper', lambda p: p['blocks'][0].update(image_box=[.1, .3, .9, .6], image_page=1))
        self.assertEqual(figures.ensure(self.ws), 1)
        self.assertEqual(self.ws.load('paper')['blocks'][0]['image_method'], 'visual')
        self.assertFalse(figures.pending(self.ws))
        crop = figures.set_crop(self.ws, 'fig2', 1, [.12, .69, .88, .88])
        self.assertTrue((self.ws.root / crop['src']).is_file())
        self.assertEqual(self.ws.load('paper')['blocks'][1]['image_method'], 'manual')
        self.assertEqual(self.ws.reader_path.read_bytes(), self.reader_before)

    def test_recrop_changes_url_and_survives_retranslation(self):
        before = figures.set_crop(self.ws, 'fig1', 1, [.12, .34, .88, .58])
        after = figures.set_crop(self.ws, 'fig1', 1, [.125, .348, .875, .577])
        self.assertNotEqual(before['src'], after['src'])
        new = {**self.blocks[0], 'caption_zh': '新图注'}
        paperdata.merge_blocks(self.ws, {'blocks': [new]}, replace_pages=[1])
        b = self.ws.load('paper')['blocks'][0]
        self.assertEqual(b['src'], after['src'])
        self.assertEqual(b['image_box'], after['image_box'])
        self.assertEqual(b['caption_zh'], '新图注')
        self.assertEqual(self.ws.reader_path.read_bytes(), self.reader_before)

    def test_invalid_crop_never_writes_image_or_metadata(self):
        paper = self.ws.paper_path.read_bytes()
        for box in (None, [0, 0, 1], [-.1, 0, 1, 1], [0, 0, 2, 1], [1, 0, 0, 1],
                    [0, 0, 0, 1], [0, float('nan'), 1, 1], [0, 0, True, 1]):
            with self.subTest(box=box), self.assertRaises(ValueError):
                figures.set_crop(self.ws, 'fig1', 1, box)
        for page in (0, 2, True, '1'):
            with self.subTest(page=page), self.assertRaises(ValueError):
                figures.set_crop(self.ws, 'fig1', page, [0, 0, 1, 1])
        with self.assertRaises(ValueError):
            pdfwork.crop(self.ws.root, 1, [0, 0, 1, 1], '../escape')
        self.assertEqual(self.ws.paper_path.read_bytes(), paper)
        self.assertFalse((self.ws.root / 'figures').exists())

    def test_export_contains_images_and_zoom_script(self):
        out = build(self.ws, self.ws.root / 'export.html')
        text = out.read_text(encoding='utf-8')
        self.assertIn('data:image/webp;base64,', text)
        self.assertIn('figureDialogTitle', text)
        self.assertIn('image_width', text)
        self.assertNotIn('/web/js/reader/figures.js', text)

    def test_scan_background_is_not_used_and_split_panels_are_joined(self):
        def image(box):
            return dict(zip(('x0', 'top', 'x1', 'bottom'), [v * 1000 for v in box]))
        page = SimpleNamespace(width=1000, height=1000, images=[image([0, 0, 1, 1])])
        self.assertIsNone(figures._embedded(page, [.1, .61, .9, .64], False))
        page.images = [image([.1, .3, .49, .59]), image([.51, .3, .9, .59]), image([.1, .08, .9, .2])]
        box = figures._embedded(page, [.1, .61, .9, .64], False)
        self.assertAlmostEqual(box[0], .098)
        self.assertAlmostEqual(box[2], .902)
        self.assertAlmostEqual(box[1], .298)


if __name__ == '__main__':
    unittest.main()
