"""Build the Windows application from a clean Python environment."""
import importlib.metadata
import json
import subprocess
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
if sys.platform != 'win32':
    raise SystemExit('Windows EXE builds must run on Windows.')
build = root / 'build/windows'
dist = root / 'dist'
notices = build / 'third-party'
notices.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(root))
from easyread.desktop import app_icon

manifest = []
for dependency in sorted(importlib.metadata.distributions(), key=lambda d: d.metadata['Name'].lower()):
    name = dependency.metadata['Name']
    copied = []
    for item in dependency.files or []:
        if not any(part.lower().startswith(('license', 'copying', 'notice')) for part in item.parts):
            continue
        original = Path(dependency.locate_file(item))
        if not original.is_file():
            continue
        relative = Path(name) / Path(str(item).replace('..', '_'))
        output = notices / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(original.read_bytes())
        copied.append(relative.as_posix())
    manifest.append({'name': name, 'version': dependency.version, 'license_files': copied})
for filename in ('LICENSE.txt', 'LICENSE', 'LICENSE_PYTHON'):
    original = Path(sys.base_prefix) / filename
    if original.is_file():
        output = notices / 'Python' / filename
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(original.read_bytes())
(notices / 'dependency-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
icon = build / 'FolioRead.ico'
app_icon().resize((256, 256)).save(icon, sizes=[(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)])
command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--windowed',
    '--name', 'FolioRead', '--icon', str(icon), '--paths', str(root),
    '--distpath', str(dist), '--workpath', str(build / 'work'), '--specpath', str(build),
    '--hidden-import', 'webview.platforms.winforms', '--hidden-import', 'webview.platforms.edgechromium',
    '--collect-all', 'pypdfium2', '--collect-all', 'pypdfium2_raw',
    '--add-data', str(root / 'easyread/web') + ';easyread/web',
    '--add-data', str(root / 'easyread/check_tex.js') + ';easyread',
    '--add-data', str(root / 'LICENSE') + ';licenses/easyread',
    '--add-data', str(notices) + ';licenses/third-party', str(root / 'desktop_launcher.py')]
subprocess.run(command, cwd=root, check=True)
with zipfile.ZipFile(dist / 'FolioRead-Windows.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write(dist / 'FolioRead.exe', 'FolioRead-Windows/FolioRead.exe')
    archive.write(root / 'LICENSE', 'FolioRead-Windows/LICENSE')
    archive.write(root / 'README.md', 'FolioRead-Windows/README.md')
    for path in sorted(notices.rglob('*')):
        if path.is_file():
            archive.write(path, 'FolioRead-Windows/第三方许可/' + path.relative_to(notices).as_posix())
print('Built:', dist / 'FolioRead.exe')
