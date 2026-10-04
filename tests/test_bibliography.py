import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import bibliography as B
from easyread.store import Workspace, write_json_atomic


class BibliographyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Workspace(Path(self.tmp.name) / 'paper')
        self.ws.root.mkdir()
        write_json_atomic(self.ws.paper_path, {'meta': {'title_en': 'Original title', 'title_zh': 'AI 译名', 'authors': 'Smith, John', 'doi': '10.1234/test', 'page_count': 20}})
        self.record = {'type': 'article-journal', 'DOI': '10.1234/test', 'title': 'Original title', 'author': [{'family': 'Smith', 'given': 'John'}], 'issued': {'date-parts': [[2024]]}, 'container-title': 'Journal', 'volume': '12', 'issue': '3', 'number': 'e2024001'}

    def tearDown(self):
        self.tmp.cleanup()

    def test_exact_doi_cached_and_manual_overrides_win(self):
        with patch.object(B, 'fetch_doi', return_value=self.record) as fetch:
            result = B.citation(self.ws)
            self.assertEqual(result['item']['author'][0]['family'], 'Smith')
            self.assertEqual(result['warnings'], [])
            self.assertNotIn('page', result['item'])  # 20 PDF sheets is not publication pagination.
            write_json_atomic(self.ws.item_path, {'meta_override': {'title_en': 'Edited title', 'year': '2025'}})
            result = B.citation(self.ws)
            self.assertEqual(result['item']['title'], 'Edited title')
            self.assertEqual(result['item']['issued']['date-parts'], [[2025]])
            self.assertEqual(fetch.call_count, 1)
            self.assertNotIn('AI 译名', str(result))

    def test_offline_does_not_guess_author_or_use_pdf_page_count(self):
        with patch.object(B, 'fetch_doi', side_effect=OSError('offline')):
            result = B.citation(self.ws)
        self.assertEqual(result['item']['author'], [{'literal': 'Smith, John'}])
        self.assertNotIn('page', result['item'])
        self.assertTrue(any('页码或文章号' in w for w in result['warnings']))
        self.assertTrue(any('作者仅有文本' in w for w in result['warnings']))
        self.assertFalse((self.ws.root / 'citation.json').exists())

    def test_doi_change_invalidates_cache(self):
        write_json_atomic(self.ws.root / 'citation.json', {'doi': '10.1234/other', 'record': self.record})
        with patch.object(B, 'fetch_doi', return_value=self.record) as fetch:
            B.citation(self.ws)
            fetch.assert_called_once_with('10.1234/test')

    def test_wrong_article_doi_is_flagged(self):
        with patch.object(B, 'fetch_doi', return_value={**self.record, 'title': 'Unrelated publication about medicine'}):
            result = B.citation(self.ws)
        self.assertTrue(any('题名与本机原标题不同' in w for w in result['warnings']))

    def test_preprint_and_organization_names(self):
        result = B.fallback({'title_en': 'Preprint', 'arxiv': 'arXiv:2401.00001', 'year': 2024, 'author': [{'literal': 'Research Consortium'}]})
        self.assertEqual(result['type'], 'article')
        self.assertEqual(result['archive'], 'arXiv')
        self.assertEqual(result['author'][0]['literal'], 'Research Consortium')


if __name__ == '__main__':
    unittest.main()
