import unittest
from html.parser import HTMLParser
from urllib.parse import urlsplit

from easyread.config import WEB


class Resources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ('src', 'href') and value and value.startswith('/web/'):
                self.paths.append(urlsplit(value).path.removeprefix('/web/'))


class WebAssetsTest(unittest.TestCase):
    def test_all_desktop_page_resources_are_in_source(self):
        for name in ('library.html', 'reader.html', 'study.html'):
            parser = Resources()
            parser.feed((WEB / name).read_text(encoding='utf-8'))
            self.assertTrue(parser.paths, name)
            for relative in parser.paths:
                with self.subTest(page=name, resource=relative):
                    self.assertTrue((WEB / relative).is_file(), 'Missing UI resource: ' + relative)
