import json
import tempfile
import unittest
from pathlib import Path

from scripts.build_mobile_site import MOBILE_FILES, SHARED_FILES, build_site


class MobileBuildTest(unittest.TestCase):
    def test_public_whitelist_and_cache_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            web = root / 'web'
            for relative in [*(f'mobile/{name}' for name in MOBILE_FILES), *SHARED_FILES, 'vendor/katex/fonts/test.woff2']:
                path = web / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('asset', encoding='utf-8')
            (web / 'mobile/sw.js').write_text("const CACHE='folio-mobile-dev-v2';", encoding='utf-8')
            config = web / 'mobile/config.json'
            config.write_text(json.dumps({'google_web_client_id': ''}), encoding='utf-8')
            (web / 'mobile/private-extra.json').write_text('must not be published', encoding='utf-8')
            output = build_site(web, root / 'build')
            first = (output / 'mobile/sw.js').read_text(encoding='utf-8')
            self.assertRegex(first, r"folio-mobile-[0-9a-f]{20}")
            self.assertFalse((output / 'mobile/private-extra.json').exists())
            (output / 'stale.json').write_text('must not remain', encoding='utf-8')
            build_site(web, root / 'build')
            self.assertEqual(first, (output / 'mobile/sw.js').read_text(encoding='utf-8'))
            self.assertFalse((output / 'stale.json').exists())
            config.write_text(json.dumps({'google_web_client_id': 'public-client'}), encoding='utf-8')
            build_site(web, root / 'build')
            self.assertNotEqual(first, (output / 'mobile/sw.js').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
