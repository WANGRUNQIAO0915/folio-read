import tempfile
import unittest
from pathlib import Path

from pypdf import PdfWriter
from pypdf.annotations import Link
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from unittest.mock import patch

from easyread import links, prompts
from easyread.build import build
from easyread.store import Workspace, write_json_atomic


class SourceLinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ws = Workspace(Path(self.temp.name))
        writer = PdfWriter()
        page = writer.add_blank_page(width=600, height=800)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                                 NameObject('/Subtype'): NameObject('/Type1'),
                                 NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):
            DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 75 650 Td (View supplementary material) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        writer.add_annotation(0, Link(rect=(74, 646, 260, 665), url='https://example.org/supplement?a=1&b=2'))
        writer.add_annotation(0, Link(rect=(74, 600, 260, 620), url='javascript:alert(1)'))
        writer.write(self.ws.root / 'source.pdf')
        write_json_atomic(self.ws.paper_path, {'meta': {}, 'blocks': [
            {'id': 'p1-1', 'page': 1, 'type': 'para', 'en': 'View supplementary material', 'zh': '查看补充材料'}]})
        self.before = self.ws.paper_path.read_bytes()

    def tearDown(self):
        self.temp.cleanup()

    def test_annotation_recovered_without_rewriting_translation(self):
        paper = links.for_reader(self.ws)
        self.assertEqual(len(paper['source_links']), 1)
        self.assertEqual(paper['blocks'][0]['source_link_only'], 'https://example.org/supplement?a=1&b=2')
        self.assertEqual(paper['blocks'][0]['zh'], '查看补充材料')
        self.assertEqual(self.before, self.ws.paper_path.read_bytes())
        first = paper['source_links'][0]
        # One PDF link can have separate annotations on wrapped lines.
        with patch('easyread.links.ensure', return_value=[first, {**first, 'label': 'View supplementary'}]):
            self.assertEqual(len(links.for_reader(self.ws)['blocks'][0]['source_links']), 2)

    def test_cache_is_reused_and_missing_pdf_is_supported(self):
        links.ensure(self.ws.root)
        cache = self.ws.root / 'extract/links.json'
        before = cache.stat().st_mtime_ns
        links.ensure(self.ws.root)
        self.assertEqual(before, cache.stat().st_mtime_ns)
        (self.ws.root / 'source.pdf').unlink()
        self.assertEqual(links.ensure(self.ws.root), [])

    def test_repeated_phrase_does_not_guess_a_paragraph(self):
        paper = self.ws.load('paper')
        paper['blocks'].append({**paper['blocks'][0], 'id': 'p1-2'})
        result = links.for_reader(self.ws, paper)
        self.assertTrue(result['source_links'])
        self.assertFalse(any('source_link_only' in b for b in result['blocks']))
        first = result['source_links'][0]
        with patch('easyread.links.ensure', return_value=[first, {**first, 'url': 'https://example.org/other'}]):
            self.assertNotIn('source_link_only', links.for_reader(self.ws)['blocks'][0])

    def test_prompt_and_offline_export_keep_real_destinations(self):
        prompt = prompts.translate(self.ws, [1], 'text', '')
        self.assertIn('https://example.org/supplement?a=1&b=2', prompt)
        out = build(self.ws, self.ws.root / 'offline.html').read_text(encoding='utf-8')
        self.assertIn('https://example.org/supplement?a=1&b=2', out)
        self.assertIn('source_link_only', out)
        self.assertEqual(self.before, self.ws.paper_path.read_bytes())

    def test_url_protocol_filter(self):
        for unsafe in ('javascript:alert(1)', 'data:text/html,hi', 'file:///C:/secret',
                       '//example.org', 'https://user:password@example.org', 'https://bad host.org',
                       'https://example.org\\evil', 'https://example.org\x00'):
            self.assertEqual(links.safe_url(unsafe), '')
        self.assertEqual(links.safe_url('mailto:author@example.org'), 'mailto:author@example.org')
