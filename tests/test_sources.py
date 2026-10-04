import json
import ssl
import unittest
import urllib.error
import urllib.parse
from unittest.mock import Mock, patch

from easyread import sources as S


PDF = b"%PDF-1.7\nsynthetic source fixture\n%%EOF"
TITLE = "Synthetic Paper for Reference Import"
DOI = "10.5555/reference-test"


class SourcesTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.routes = {}
        self.get = patch.object(S, "_get", side_effect=self.respond)
        self.get.start()
        self.addCleanup(self.get.stop)

    def respond(self, url, *args, **kwargs):
        self.calls.append(url)
        value = self.routes.get(url, S.SourceError("Fixture address does not exist", "not_found"))
        if isinstance(value, Exception):
            raise value
        if isinstance(value, dict):
            return json.dumps(value).encode(), "application/json", url
        if isinstance(value, str):
            return value.encode(), "text/html", url
        if isinstance(value, tuple):
            return value
        return value, "application/pdf", url

    def s2_title(self):
        return S.S2 + "search/match?query=" + urllib.parse.quote(TITLE) + "&fields=" + S.S2_FIELDS

    def s2_doi(self, doi=DOI):
        return S.S2 + "DOI:" + doi + "?fields=" + S.S2_FIELDS

    def crossref_doi(self, doi=DOI):
        return "https://api.crossref.org/works/" + urllib.parse.quote(doi, safe="")

    def crossref_title(self, title=TITLE):
        return "https://api.crossref.org/works?" + urllib.parse.urlencode({"query.bibliographic": title, "rows": 3})

    def work(self, title=TITLE):
        return {"DOI": DOI, "title": [title], "author": [{"given": "Test", "family": "Author"}],
                "published": {"date-parts": [[2024, 2, 3]]}, "container-title": ["Fixture Journal"],
                "link": [{"URL": "https://publisher.invalid/main.pdf", "content-type": "application/pdf"}]}

    def test_title_falls_back_after_rate_limit_and_preserves_metadata(self):
        self.routes[self.s2_title()] = S.SourceError("Semantic Scholar 请求受到限流", "rate_limited")
        self.routes[self.crossref_title()] = {"message": {"items": [self.work()]}}
        self.routes["https://publisher.invalid/main.pdf"] = PDF
        data, _, meta = S.fetch(TITLE)
        self.assertEqual(data, PDF)
        self.assertEqual(meta["title_en"], TITLE)
        self.assertEqual(meta["doi"], DOI)
        self.assertEqual(meta["authors"], "Test Author")
        self.assertEqual(meta["date"], "2024-02-03")

    def test_title_falls_back_to_arxiv(self):
        query = urllib.parse.urlencode({"search_query": 'ti:"' + TITLE + '"', "max_results": 3})
        self.routes["https://export.arxiv.org/api/query?" + query] = (
            '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v2</id>'
            f'<title>{TITLE}</title><published>2017-06-12</published><author><name>Fixture Author</name></author>'
            '</entry></feed>',
        )[0]
        self.routes["https://arxiv.org/pdf/1706.03762v2"] = PDF
        data, name, meta = S.fetch(TITLE)
        self.assertEqual(data, PDF)
        self.assertEqual(name, "1706.03762v2.pdf")
        self.assertEqual(meta["title_en"], TITLE)
        self.assertEqual(meta["authors"], "Fixture Author")

    def test_similar_title_is_not_silently_imported(self):
        self.routes[self.s2_title()] = {"data": [{"title": TITLE + " unrelated sequel", "openAccessPdf": {"url": "https://wrong.invalid/paper.pdf"}}]}
        self.routes[self.crossref_title()] = {"message": {"items": [self.work(TITLE + " unrelated sequel")]}}
        with self.assertRaises(S.SourceError) as exc:
            S.fetch(TITLE)
        self.assertEqual(exc.exception.code, "not_found")
        self.assertNotIn("https://wrong.invalid/paper.pdf", self.calls)
        self.assertNotIn("https://publisher.invalid/main.pdf", self.calls)

    def test_punctuation_case_and_unicode_title_normalization(self):
        self.routes[self.s2_title()] = {"data": [{"title": TITLE.upper() + ".", "openAccessPdf": {"url": "https://oa.invalid/paper.pdf"}}]}
        self.routes["https://oa.invalid/paper.pdf"] = PDF
        self.assertEqual(S.fetch(TITLE)[0], PDF)

    def test_doi_with_no_s2_fulltext_uses_crossref_pdf(self):
        self.routes[self.s2_doi()] = {"title": TITLE, "externalIds": {"DOI": DOI}, "openAccessPdf": None}
        self.routes[self.crossref_doi()] = {"message": self.work()}
        self.routes["https://publisher.invalid/main.pdf"] = PDF
        data, _, meta = S.fetch("doi: " + DOI)
        self.assertEqual(data, PDF)
        self.assertEqual(meta["doi"], DOI)

    def test_arxiv_failure_does_not_discard_open_access_alternative(self):
        self.routes[self.s2_doi()] = {"title": TITLE, "externalIds": {"DOI": DOI, "ArXiv": "1706.03762"}, "openAccessPdf": {"url": "https://oa.invalid/paper.pdf"}}
        self.routes["https://arxiv.org/pdf/1706.03762"] = S.SourceError("arXiv 网络不可用", "network")
        self.routes["https://oa.invalid/paper.pdf"] = PDF
        self.assertEqual(S.fetch(DOI)[0], PDF)

    def test_relative_pdf_and_reordered_page_tags(self):
        self.routes["https://publisher.invalid/article"] = (
            '<meta content="' + TITLE + '" name="citation_title">'
            '<meta name="citation_author" content="Author, Test">'
            '<meta name="citation_doi" content="' + DOI + '">'
            '<meta name="citation_pdf_url" content="files/paper.pdf">')
        self.routes["https://publisher.invalid/files/paper.pdf"] = PDF
        data, _, meta = S.fetch("https://publisher.invalid/article")
        self.assertEqual(data, PDF)
        self.assertEqual(meta["title_en"], TITLE)
        self.assertEqual(meta["authors"], "Test Author")

    def test_page_doi_s2_loop_is_bounded_without_network_retries(self):
        page = '<meta name="citation_title" content="' + TITLE + '"><meta name="citation_doi" content="' + DOI + '">'
        self.routes["https://publisher.invalid/article"] = page
        self.routes[self.s2_doi()] = {"title": TITLE, "externalIds": {"DOI": DOI}, "openAccessPdf": {"url": "https://publisher.invalid/article"}}
        self.routes[self.crossref_doi()] = {"message": {"DOI": DOI, "title": [TITLE], "URL": "https://publisher.invalid/article"}}
        self.routes["https://doi.org/" + DOI] = page
        with self.assertRaises(S.SourceError) as exc:
            S.fetch("https://publisher.invalid/article")
        self.assertEqual(exc.exception.code, "no_fulltext")
        self.assertEqual(len(self.calls), len(set(self.calls)))
        self.assertLessEqual(len(self.calls), 4)

    def test_network_failure_is_not_reported_as_missing_paper(self):
        with patch.object(S, "_get", side_effect=S.SourceError("HTTPS 连接失败，请检查网络和代理", "network")):
            with self.assertRaises(S.SourceError) as exc:
                S.fetch(TITLE)
        self.assertEqual(exc.exception.code, "network")
        self.assertIn("网络", str(exc.exception))
        self.assertNotIn("未找到", str(exc.exception))

    def test_encoded_doi_url_drops_tracking_query(self):
        self.routes[self.crossref_doi()] = {"message": self.work()}
        self.routes["https://publisher.invalid/main.pdf"] = PDF
        self.assertEqual(S.fetch("https://doi.org/10.5555%2Freference-test?utm_source=test#section")[0], PDF)
        self.assertIn(self.s2_doi(), self.calls)

    def test_arxiv_doi_goes_directly_to_pdf(self):
        self.routes["https://arxiv.org/pdf/1706.03762"] = PDF
        data, _, meta = S.fetch("10.48550/arXiv.1706.03762")
        self.assertEqual(data, PDF)
        self.assertEqual(meta["doi"], "10.48550/arXiv.1706.03762")
        self.assertFalse(any("semanticscholar" in url for url in self.calls))

    def test_acl_doi_uses_public_article_without_s2(self):
        self.routes["https://aclanthology.org/N19-1423/"] = '<meta name="citation_pdf_url" content="/N19-1423.pdf">'
        self.routes["https://aclanthology.org/N19-1423.pdf"] = PDF
        self.assertEqual(S.fetch("10.18653/v1/N19-1423")[0], PDF)
        self.assertFalse(any("semanticscholar" in url for url in self.calls))

    def test_html_instead_of_pdf_has_access_message(self):
        self.routes[self.crossref_doi()] = {"message": self.work()}
        self.routes["https://publisher.invalid/main.pdf"] = '<html>Sign in</html>'
        with self.assertRaises(S.SourceError) as exc:
            S.fetch(DOI)
        self.assertEqual(exc.exception.code, "access_denied")
        self.assertIn("登录", str(exc.exception))

    def test_direct_pdf_login_page_has_access_message(self):
        self.routes['https://publisher.invalid/private.pdf'] = '<html>Sign in</html>'
        with self.assertRaises(S.SourceError) as exc:
            S.fetch('https://publisher.invalid/private.pdf')
        self.assertEqual(exc.exception.code, 'access_denied')

    def test_openreview_filename_is_preserved(self):
        self.routes['https://openreview.net/pdf?id=abc-123'] = PDF
        data, filename, meta = S.fetch('https://openreview.net/forum?id=abc-123&extra=value')
        self.assertEqual(data, PDF)
        self.assertEqual(filename, 'openreview-abc-123.pdf')
        self.assertEqual(meta['venue'], 'OpenReview')

    def test_non_doi_website_is_not_misclassified_by_hostname_substring(self):
        url = "https://doi.org.example.invalid/article/10.5555/reference-test"
        self.routes[url] = PDF
        self.assertEqual(S.fetch(url)[0], PDF)
        self.assertEqual(self.calls, [url])

    def test_biorxiv_and_medrxiv_specific_pdf_routes_are_preserved(self):
        for host in ('www.biorxiv.org', 'www.medrxiv.org'):
            base = f'https://{host}/content/10.1101/2024.01.01.123456v1'
            self.routes[base + '.full.pdf'] = PDF
            self.assertEqual(S.fetch(base + '.abstract?utm_source=test')[0], PDF)

    def test_pmc_page_failure_uses_pmcid_fulltext_lookup(self):
        key = S.S2 + 'PMCID:PMC123456?fields=' + S.S2_FIELDS
        self.routes[key] = {'title': TITLE, 'openAccessPdf': {'url': 'https://oa.invalid/pmc.pdf'}}
        self.routes['https://oa.invalid/pmc.pdf'] = PDF
        self.assertEqual(S.fetch('https://pmc.ncbi.nlm.nih.gov/articles/PMC123456/')[0], PDF)

    def test_malformed_provider_fields_do_not_block_another_source(self):
        self.routes[self.s2_title()] = {'data': [None, {'title': TITLE, 'authors': [None], 'externalIds': [], 'openAccessPdf': []}]}
        work = self.work()
        work.update({'author': None, 'published': {'date-parts': ['invalid']}, 'link': [None, *work['link']]})
        self.routes[self.crossref_title()] = {'message': {'items': [None, work]}}
        self.routes['https://publisher.invalid/main.pdf'] = PDF
        self.assertEqual(S.fetch(TITLE)[0], PDF)

    def test_invalid_input_does_not_request_network(self):
        for ref in (None, 42, "", "x", "file://local/paper.pdf", "a" * 2001):
            with self.subTest(ref=str(ref)[:20]), self.assertRaises(S.SourceError):
                S.fetch(ref)
        self.assertEqual(self.calls, [])


class NetworkErrorsTest(unittest.TestCase):
    def test_http_errors_keep_their_cause_without_exposing_url_tokens(self):
        for status, code in ((403, "access_denied"), (429, "rate_limited"), (404, "not_found"), (503, "service_unavailable")):
            error = urllib.error.HTTPError("https://host.invalid/?key=private", status, "fixture", {}, None)
            with self.subTest(status=status), patch.object(S.urllib.request, "urlopen", side_effect=error):
                with self.assertRaises(S.SourceError) as exc:
                    S._get("https://host.invalid/?key=private")
                self.assertEqual(exc.exception.code, code)
                self.assertNotIn("private", str(exc.exception))

    def test_ssl_failure_has_network_message(self):
        error = urllib.error.URLError(ssl.SSLError("fixture EOF"))
        with patch.object(S.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(S.SourceError) as exc:
                S._get("https://host.invalid")
        self.assertEqual(exc.exception.code, "network")

    def test_size_limit_is_applied_before_import(self):
        response = Mock()
        response.read.return_value = b"12345"
        response.headers = {}
        response.geturl.return_value = "https://host.invalid/paper.pdf"
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(S.urllib.request, "urlopen", return_value=response):
            with self.assertRaises(S.SourceError) as exc:
                S._get("https://host.invalid/paper.pdf", limit=4)
        self.assertEqual(exc.exception.code, "too_large")


if __name__ == "__main__":
    unittest.main()
