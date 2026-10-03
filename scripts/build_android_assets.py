"""Assemble only public reader assets plus integrity-locked offline PDF.js for Android."""
import argparse
import hashlib
import json
import shutil
import tempfile
from pathlib import Path

try:
    from .build_mobile_site import MOBILE_FILES, SHARED_FILES
except ImportError:
    from build_mobile_site import MOBILE_FILES, SHARED_FILES

ROOT = Path(__file__).resolve().parents[1]
PDF_VERSION = '6.3.289'
PDF_PATHS = ('legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs', 'cmaps', 'standard_fonts', 'wasm', 'LICENSE')


def build_assets(root: Path, output: Path) -> Path:
    web = root / 'easyread/web'
    pdf = root / 'android/web/node_modules/pdfjs-dist'
    if not (pdf / 'package.json').is_file():
        raise RuntimeError('Run npm ci --prefix android/web --ignore-scripts --omit=optional first')
    if json.loads((pdf / 'package.json').read_text())['version'] != PDF_VERSION:
        raise ValueError('Unexpected PDF.js version; use the committed npm lockfile')
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_symlink() or output == root.resolve() or root.resolve().is_relative_to(output):
        raise ValueError('Unsafe generated asset output path')
    with tempfile.TemporaryDirectory(prefix='folio-android-', dir=output.parent) as temp:
        stage = Path(temp)
        for relative in [*(f'mobile/{name}' for name in MOBILE_FILES if name not in {'sw.js', 'config.json'}), *SHARED_FILES]:
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(web / relative, target)
        shutil.copytree(web / 'vendor/katex', stage / 'vendor/katex')
        for relative in PDF_PATHS:
            source, target = pdf / relative, stage / 'vendor/pdfjs' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
        shutil.copy2(root / 'LICENSE', stage / 'LICENSE')
        shutil.copy2(root / 'android/web/android.js', stage / 'mobile/android.js')
        # A native Android OAuth client uses package + certificate, not the web client ID.
        (stage / 'mobile/config.json').write_text('{}\n', encoding='utf-8')
        index = stage / 'mobile/index.html'
        html = index.read_text(encoding='utf-8')
        csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'"
        html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="' + csp + '">')
        html = html.replace('<script defer src="core.js">', '<script defer src="android.js"></script>\n  <script defer src="core.js">')
        html = html.replace('请在 Safari 中开启 JavaScript，以使用离线阅读和笔记。', '此应用需要 Android System WebView 来显示阅读内容。')
        index.write_text(html, encoding='utf-8')
        manifest = {p.relative_to(stage).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sorted(stage.rglob('*')) if p.is_file()}
        (stage / 'asset-manifest.json').write_text(json.dumps({'pdfjs_version': PDF_VERSION, 'sha256': manifest}, indent=2) + '\n')
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'android/app/build/generated/folioAssets')
    args = parser.parse_args()
    print(build_assets(ROOT, args.output))
