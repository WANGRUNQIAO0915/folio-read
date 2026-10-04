"""Publish a whitelisted static reader with a content-versioned offline cache."""
from pathlib import Path
import hashlib
import shutil
import tempfile


MOBILE_FILES = (
    'index.html', 'manifest.webmanifest', 'mobile.css', 'core.js', 'storage.js',
    'drive.js', 'pdf-import.js', 'knowledge.js', 'ai.js', 'app.js', 'sw.js', 'config.json', 'icon-192.png', 'icon-512.png',
)
SHARED_FILES = ('favicon.svg', 'css/base.css', 'js/common/markup.js', 'js/common/journal-rank.js', 'js/common/organization.js', 'js/common/citations.js', 'js/reader/outline.js')


def build_site(web: Path, build: Path) -> Path:
    build = build.resolve()
    build.mkdir(parents=True, exist_ok=True)
    output = build / 'mobile-site'
    # Recreate this generated directory so old or unlisted files cannot be published.
    if output.is_symlink() or output.resolve().parent != build:
        raise ValueError('Mobile output must stay within the build directory')
    with tempfile.TemporaryDirectory(prefix='mobile-stage-', dir=build) as temp:
        stage = Path(temp)
        for relative in [*(f'mobile/{name}' for name in MOBILE_FILES), *SHARED_FILES]:
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(web / relative, destination)
        shutil.copytree(web / 'vendor/katex', stage / 'vendor/katex')
        shutil.copy2(web.parents[1] / 'LICENSE', stage / 'LICENSE')
        (stage / 'index.html').write_text('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=mobile/"><title>Folio Read</title><a href="mobile/">打开手机阅读</a>', encoding='utf-8')
        (stage / '.nojekyll').touch()
        digest = hashlib.sha256()
        for asset in sorted(stage.rglob('*')):
            if asset.is_file():
                digest.update(asset.relative_to(stage).as_posix().encode())
                digest.update(b'\0')
                digest.update(asset.read_bytes())
                digest.update(b'\0')
        worker = stage / 'mobile/sw.js'
        worker.write_text(worker.read_text(encoding='utf-8').replace('folio-mobile-dev-v2', 'folio-mobile-' + digest.hexdigest()[:20]), encoding='utf-8')
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output)
    return output


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    print('Mobile static site ready:', build_site(root / 'easyread/web', root / 'build'))
