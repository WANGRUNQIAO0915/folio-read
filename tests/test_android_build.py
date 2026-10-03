import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from scripts.build_android_assets import build_assets, PDF_VERSION

ROOT = Path(__file__).resolve().parents[1]


class AndroidAssetsTest(unittest.TestCase):
    def test_real_offline_bundle_and_provenance(self):
        if not (ROOT / 'android/web/node_modules/pdfjs-dist/package.json').exists():
            self.skipTest('npm ci --prefix android/web --ignore-scripts --omit=optional is required')
        with tempfile.TemporaryDirectory() as temp:
            output = build_assets(ROOT, Path(temp) / 'assets')
            index = (output / 'mobile/index.html').read_text()
            self.assertLess(index.index('android.js'), index.index('pdf-import.js'))
            self.assertIn('Content-Security-Policy', index)
            self.assertIn("frame-src 'none'", index)
            self.assertFalse((output / 'mobile/sw.js').exists())
            self.assertEqual(json.loads((output / 'mobile/config.json').read_text()), {})
            self.assertTrue((output / 'vendor/pdfjs/legacy/build/pdf.worker.mjs').stat().st_size > 100000)
            self.assertTrue(list((output / 'vendor/pdfjs/cmaps').glob('*.bcmap')))
            self.assertTrue(list((output / 'vendor/pdfjs/standard_fonts').iterdir()))
            self.assertTrue(list((output / 'vendor/pdfjs/wasm').glob('*.wasm')))
            self.assertTrue((output / 'vendor/pdfjs/LICENSE').exists())
            self.assertFalse((output / 'library.html').exists())
            manifest = json.loads((output / 'asset-manifest.json').read_text())
            self.assertEqual(manifest['pdfjs_version'], PDF_VERSION)
            for name, digest in manifest['sha256'].items():
                self.assertEqual(hashlib.sha256((output / name).read_bytes()).hexdigest(), digest)
            (output / 'stale-secret.txt').write_text('not public')
            build_assets(ROOT, output)
            self.assertFalse((output / 'stale-secret.txt').exists())

    def test_native_security_and_build_contract(self):
        manifest = (ROOT / 'android/app/src/main/AndroidManifest.xml').read_text()
        self.assertIn('android:allowBackup="false"', manifest)
        self.assertIn('android:usesCleartextTraffic="false"', manifest)
        self.assertNotIn('READ_EXTERNAL_STORAGE', manifest)
        self.assertNotIn('MANAGE_EXTERNAL_STORAGE', manifest)
        java = (ROOT / 'android/app/src/main/java/io/github/wangrunqiao0915/folioread/MainActivity.java').read_text()
        self.assertIn('!isMainFrame', java)
        self.assertIn('Collections.singleton(ORIGIN)', java)
        self.assertIn('setAllowFileAccess(false)', java)
        self.assertNotIn('addJavascriptInterface', java)
        self.assertIn('ACTION_OPEN_DOCUMENT', java)
        self.assertIn('ACTION_CREATE_DOCUMENT', java)
        self.assertIn('response.setMimeType("text/javascript")', java)


if __name__ == '__main__':
    unittest.main()
