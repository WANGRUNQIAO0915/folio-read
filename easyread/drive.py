"""Google Drive sync for the desktop. Loopback PKCE and DPAPI.

Per-file sync by default; opt-in folder imports require explicit Drive readonly
consent. Broad read capability is constrained in code to app folder PDF children.
No public sharing, model settings, or API keys.
"""
from __future__ import annotations

import base64
import copy
import ctypes
import hashlib
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from . import portable as P
from .store import dir_lock, now_iso, read_json, write_json_atomic

SCOPE = 'https://www.googleapis.com/auth/drive.file'
FOLDER_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
MAX_SOURCE = 128 * 1024 * 1024
API = 'https://www.googleapis.com/drive/v3/files'
APP = 'mobile-v1'


def _protect(data: bytes, decrypt=False) -> bytes:
    if os.name != 'nt':
        raise ValueError('持久 Google 登录目前仅支持 Windows 的加密存储')
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buf = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    fn = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise ValueError('无法使用 Windows 加密保存 Google 登录')
    kernel = ctypes.WinDLL('kernel32')
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel.LocalFree(result.data)


def _json_request(url, body=None, headers=None, method=None):
    request = urllib.request.Request(url, body, headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read(P.MAX_BYTES + 1)
            if len(raw) > P.MAX_BYTES:
                raise ValueError('云端文件超过 64 MB')
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        # Never echo OAuth responses or credentials into logs/UI.
        raise ValueError(f'Google 请求失败（{e.code}）；请重新连接或稍后重试') from None


class Drive:
    def __init__(self, home: Path, lib):
        self.home, self.lib = Path(home), lib
        self.config_path = self.home / 'drive-config.json'
        self.token_path = self.home / '.drive-tokens.bin'
        self.cfg = read_json(self.config_path, {}) or {}
        self.device = self.cfg.get('device_id') or str(uuid.uuid4())
        self.token, self.expires, self.account = '', 0, None
        self.granted_scopes = set()
        self.import_errors = []
        self.busy, self.message, self.error = False, '', ''
        self.files = []
        self.lock = threading.Lock()
        threading.Thread(target=self._auto_sync, daemon=True).start()

    def _auto_sync(self):
        while True:
            time.sleep(60)
            if not self.busy and self.token_path.exists() and self.cfg.get('client_id'):
                try:
                    self.run('sync')
                except ValueError:
                    pass

    def configure(self, data):
        if self.busy:
            raise ValueError('请等当前连接或同步结束后再修改配置')
        cid = str(data.get('client_id', '')).strip()
        if not cid.endswith('.apps.googleusercontent.com') or len(cid) > 300:
            raise ValueError('请填写 Google 桌面应用客户端 ID')
        changed = cid != self.cfg.get('client_id')
        self.cfg.update(client_id=cid, client_secret=str(data.get('client_secret') or self.cfg.get('client_secret') or '')[:500], device_id=self.device)
        if changed:
            self.token = ''; self.account = None; self.granted_scopes = set()
        write_json_atomic(self.config_path, self.cfg)

    def status(self):
        return {'configured': bool(self.cfg.get('client_id')), 'client_id': self.cfg.get('client_id', ''),
                'connected': bool(self.account), 'account': self.account, 'busy': self.busy,
                'message': self.message, 'error': self.error, 'last_sync': self.cfg.get('last_sync', ''),
                'sync_all': self.cfg.get('sync_all', True),
                'folder_import_enabled': self.cfg.get('folder_import_enabled', False),
                'folder_read_granted': FOLDER_READ_SCOPE in self.granted_scopes,
                'import_errors': self.import_errors,
                'papers': [{'id': ws.id, 'selected': self.cfg.get('sync_all', True) or bool((ws.load('reader').get('_cloud') or {}).get('enabled')), 'title': (ws.load('paper') or {}).get('meta', {}).get('title_zh') or (ws.load('paper') or {}).get('meta', {}).get('title_en') or ws.id} for ws in self.lib.all()],
                'cloud': [f for f in self.files if (f.get('appProperties') or {}).get('folioType') == 'paper']}

    def _tokens(self, data):
        if data.get('scope') and SCOPE not in data['scope'].split():
            raise ValueError('请允许 Folio Read 访问它创建的云盘文件')
        # Capability is learned only from an actual OAuth response, never a UI flag.
        if data.get('scope'):
            self.granted_scopes = set(data['scope'].split())
        self.token = data.get('access_token') or ''
        self.expires = time.time() + max(0, int(data.get('expires_in', 3600)) - 60)
        refresh = data.get('refresh_token')
        if refresh:
            self.token_path.write_bytes(_protect(json.dumps({'client_id': self.cfg['client_id'], 'refresh_token': refresh, 'scope': ' '.join(sorted(self.granted_scopes))}).encode()))

    def _exchange(self, values):
        values.update(client_id=self.cfg['client_id'])
        if self.cfg.get('client_secret'):
            values['client_secret'] = self.cfg['client_secret']
        return _json_request('https://oauth2.googleapis.com/token', urllib.parse.urlencode(values).encode(), {'Content-Type': 'application/x-www-form-urlencoded'})

    def request(self, url, body=None, headers=None, method=None):
        if not url.startswith('https://www.googleapis.com/'):
            raise ValueError('云盘请求地址无效')
        if not self.token or time.time() >= self.expires:
            if not self.token_path.exists():
                raise ValueError('请先连接 Google 云盘')
            saved = json.loads(_protect(self.token_path.read_bytes(), decrypt=True))
            if saved['client_id'] != self.cfg.get('client_id'):
                raise ValueError('Google 客户端已变化，请重新连接')
            self.granted_scopes = set(saved.get('scope', '').split())
            self._tokens(self._exchange({'grant_type': 'refresh_token', 'refresh_token': saved['refresh_token']}))
        return _json_request(url, body, {**(headers or {}), 'Authorization': 'Bearer ' + self.token}, method)

    def identify(self):
        account = self.request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)').get('user')
        if not account or not account.get('permissionId'):
            raise ValueError('未能确认 Google 云盘账号')
        self._account_key(account)
        self.account = account

    @staticmethod
    def _account_key(account):
        key = (account or {}).get('permissionId', '')
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', key):
            raise ValueError('Google 云盘账号标识无效')
        return key

    def login(self, folder_import=None):
        folder_import = self.cfg.get('folder_import_enabled', False) if folder_import is None else bool(folder_import)
        if not self.cfg.get('client_id'):
            raise ValueError('请先保存 Google 桌面客户端配置')
        requested_scope = SCOPE + (' ' + FOLDER_READ_SCOPE if folder_import else '')
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        state, result = secrets.token_urlsafe(32), {}
        class Callback(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                url = urllib.parse.urlparse(self.path)
                query = urllib.parse.parse_qs(url.query)
                valid = url.path == '/callback' and secrets.compare_digest(query.get('state', [''])[0], state)
                if valid:
                    result.update(code=query.get('code', [''])[0], error=query.get('error', [''])[0])
                body = ('登录请求已收到，请返回 Folio Read。' if valid else '登录状态不匹配。').encode('utf-8')
                self.send_response(200 if valid else 400)
                self.send_header('Content-Type', 'text/plain; charset=utf-8'); self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body)
        with HTTPServer(('127.0.0.1', 0), Callback) as server:
            redirect = f'http://127.0.0.1:{server.server_port}/callback'
            params = dict(client_id=self.cfg['client_id'], redirect_uri=redirect, response_type='code', scope=requested_scope,
                          state=state, code_challenge=challenge, code_challenge_method='S256', access_type='offline', prompt='consent select_account')
            self.message = '请在浏览器中完成 Google 登录授权'
            webbrowser.open('https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params))
            server.timeout = 1
            deadline = time.time() + 300
            while not result and time.time() < deadline:
                server.handle_request()
        if not result.get('code'):
            raise ValueError('Google 授权未完成或已超时')
        self.granted_scopes = set()
        self._tokens(self._exchange(dict(grant_type='authorization_code', code=result['code'], redirect_uri=redirect, code_verifier=verifier)))
        self.identify(); self.files = self.list_files()
        self.cfg['folder_import_enabled'] = folder_import
        write_json_atomic(self.config_path, self.cfg)
        self.message = 'Google 云盘已连接'
        if folder_import and FOLDER_READ_SCOPE not in self.granted_scopes:
            self.message += '；文件夹导入尚未获得只读权限，普通同步仍可使用'

    def disable_folder_import(self):
        if self.busy:
            raise ValueError('请等当前同步完成')
        self.cfg['folder_import_enabled'] = False
        write_json_atomic(self.config_path, self.cfg)
        self.message = '已停止扫描文件夹；撤回 Google 授权请到 Google 账号权限页操作'

    def list_files(self):
        files, page = [], ''
        while True:
            params = dict(q=f"trashed = false and appProperties has {{ key='folioApp' and value='{APP}' }}", pageSize=1000,
                          fields='nextPageToken,files(id,name,mimeType,parents,modifiedTime,size,appProperties)')
            if page:
                params['pageToken'] = page
            data = self.request(API + '?' + urllib.parse.urlencode(params))
            files.extend(data.get('files', [])); page = data.get('nextPageToken')
            if not page:
                return files

    def list_folder_pdfs(self, folder_id):
        """Only direct PDF children of a known app folder; never browse all Drive."""
        if not isinstance(folder_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,199}', folder_id):
            raise ValueError('云盘文件夹标识无效')
        files, page = [], ''
        while True:
            params = dict(q=f"trashed = false and '{folder_id}' in parents and mimeType != 'application/vnd.google-apps.folder'",
                          pageSize=1000, fields='nextPageToken,incompleteSearch,files(id,name,mimeType,parents,modifiedTime,version,size,md5Checksum,sha256Checksum,appProperties)')
            if page:
                params['pageToken'] = page
            data = self.request(API + '?' + urllib.parse.urlencode(params))
            if data.get('incompleteSearch'):
                raise ValueError('云盘文件夹扫描不完整，请再次同步')
            # Some external uploaders use octet-stream for a PDF filename.
            files.extend(f for f in data.get('files', []) if (f.get('mimeType') == 'application/pdf' or str(f.get('name', '')).lower().endswith('.pdf'))
                         and not ((f.get('appProperties') or {}).get('folioApp') == APP and f['appProperties'].get('folioType') == 'source'))
            page = data.get('nextPageToken')
            if not page:
                return files

    def source_folder(self, files, parent):
        matches = [f for f in files if (f.get('appProperties') or {}).get('folioType') == 'source-folder'
                   and f['appProperties'].get('folioParentId') == parent]
        if matches:
            return min(matches, key=lambda f: f['id'])['id']
        data = dict(name='Folio Read Sources', mimeType='application/vnd.google-apps.folder', parents=[parent],
                    appProperties=dict(folioApp=APP, folioType='source-folder', folioParentId=parent))
        file = self.request(API + '?fields=id,name,parents,appProperties', json.dumps(data).encode(), {'Content-Type': 'application/json'}, 'POST')
        files.append(file)
        return file['id']

    def _workspace_for_hash(self, pid):
        if not isinstance(pid, str) or not re.fullmatch(r'[a-f0-9]{64}', pid):
            return None
        return next((w for w in self.lib.all() if (w.load('paper').get('meta') or {}).get('source_sha256') == pid or w.id == pid), None)

    @staticmethod
    def _original_blocks(ws):
        blocks = []
        for path in sorted((ws.root / 'extract').glob('page-*.txt')):
            page = int(path.stem.split('-')[-1])
            text = path.read_text(encoding='utf-8')
            for i, start in enumerate(range(0, len(text), 1400)):
                if text[start:start+1400].strip():
                    blocks.append(dict(id=f'pdf-p{page}-t{i}', type='para', page=page, en=text[start:start+1400], zh=''))
        return blocks

    def _import_pdf_bytes(self, raw, name, pid):
        """Parse only on this device. Never enqueue translation, enrichment, or AI."""
        from . import pdfwork
        from .library import Library
        from .store import Workspace
        stage = Path(tempfile.mkdtemp(prefix='.drive-pdf-', dir=self.lib.root))
        try:
            staged, _ = Library(stage).create_from_pdf(raw, str(name).replace('\\', '/').rsplit('/', 1)[-1][:240])
            if pdfwork.page_count(staged.root / 'source.pdf') > 300:
                raise ValueError('文件夹自动导入最多支持 300 页，请拆分 PDF')
            pages = pdfwork.render_pages(staged.root / 'source.pdf', staged.root / 'pages', scale=1.2, quality=72)
            pdfwork.extract_text(staged.root / 'source.pdf', staged.root / 'extract')
            paper = staged.load('paper')
            paper['blocks'] = self._original_blocks(staged)
            paper['meta'].update(pages=pages, page_count=len(pages), text_status='original',
                                 extraction_note='PDF 原文，尚未翻译。复杂排版请对照原页。' if paper['blocks'] else '此 PDF 未提取到文字。原稿已保留，扫描版需先进行 OCR 才能全文检索。')
            write_json_atomic(staged.paper_path, paper)
            # Do not expose a half-parsed document; respect concurrent local imports.
            with dir_lock(self.lib.root):
                existing = self._workspace_for_hash(pid)
                if existing:
                    return existing
                destination = self.lib.root / pid[:12]
                if destination.exists():
                    destination = self.lib.root / pid
                if destination.exists():
                    raise ValueError('本机论文目录冲突，请检查资料库')
                staged.root.rename(destination)
                return Workspace(destination)
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    def import_folder_pdfs(self, files):
        """Opt-in boundary: saved preference alone cannot expand account access."""
        errors, imported = [], 0
        if not self.cfg.get('folder_import_enabled', False):
            return imported, errors
        if FOLDER_READ_SCOPE not in self.granted_scopes:
            return imported, [dict(name='文件夹导入', error='需要明确授权 Google 云盘只读访问；普通应用同步仍可继续')]
        account_key = self._account_key(self.account)
        cache_path = self.home / '.drive-cache' / account_key / 'folder-imports.json'
        cache = read_json(cache_path, {}) or {}
        folders = sorted({f['id'] for f in files if (f.get('appProperties') or {}).get('folioType') == 'folder'})
        seen = set()
        for folder_id in folders:
            try:
                candidates = self.list_folder_pdfs(folder_id)
            except Exception as error:
                errors.append(dict(name='Folio Read', error=str(error)[:200])); continue
            for file in candidates:
                if file.get('id') in seen:
                    continue
                seen.add(file.get('id'))
                name = str(file.get('name') or '论文.pdf')[:240]
                try:
                    file_id = file.get('id')
                    if not isinstance(file_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,199}', file_id) or not 0 < int(file.get('size', 0)) <= MAX_SOURCE:
                        raise ValueError('PDF 标识无效或超过 128 MB')
                    revision = P.canonical({k: file.get(k) for k in ('version', 'modifiedTime', 'size', 'md5Checksum', 'sha256Checksum')})
                    cacheable = any(file.get(k) for k in ('version', 'modifiedTime', 'md5Checksum', 'sha256Checksum'))
                    prior = cache.get(file_id, {})
                    cached_ws = self._workspace_for_hash(prior.get('paper_id'))
                    if cacheable and prior.get('revision') == revision and cached_ws and (cached_ws.root / 'source.pdf').is_file():
                        if (cached_ws.load('reader').get('_cloud') or {}).get('account') not in (None, account_key):
                            raise ValueError('同一 PDF 已绑定另一 Google 账号，请切回原账号')
                        continue
                    raw, _ = self.binary_request(API + '/' + urllib.parse.quote(file_id, safe='') + '?alt=media', limit=MAX_SOURCE)
                    if not raw or not raw.startswith(b'%PDF') or len(raw) != int(file['size']):
                        raise ValueError('PDF 内容无效或下载期间发生变化，请再次同步')
                    if file.get('md5Checksum') and hashlib.md5(raw).hexdigest() != file['md5Checksum']:
                        raise ValueError('PDF 校验失败，请再次同步')
                    pid = hashlib.sha256(raw).hexdigest()
                    if file.get('sha256Checksum') and file['sha256Checksum'].lower() != pid:
                        raise ValueError('PDF 校验失败，请再次同步')
                    ws = self._workspace_for_hash(pid)
                    if not ws:
                        remote = self.latest(files, pid)
                        if remote:
                            self.pull(remote['id'], files=files)
                            ws = self._workspace_for_hash(pid)
                        else:
                            ws = self._import_pdf_bytes(raw, name, pid)
                            imported += 1
                    cloud = ws.load('reader').get('_cloud') or {}
                    if cloud.get('account') not in (None, account_key):
                        raise ValueError('同一 PDF 已绑定另一 Google 账号，请切回原账号')
                    if not (ws.root / 'source.pdf').exists():
                        (ws.root / 'source.pdf').write_bytes(raw)
                    def mark(reader):
                        reader.setdefault('_cloud', {}).update(enabled=True, account=account_key, drive_imported=True)
                    ws.update('reader', mark)
                    # Commit success only after durable local import. Failed uploads retry via normal sync.
                    if cacheable:
                        cache[file_id] = dict(revision=revision, paper_id=pid)
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    write_json_atomic(cache_path, cache)
                except Exception as error:
                    errors.append(dict(name=name, error=str(error)[:200]))
        return imported, errors

    def download(self, file):
        if not P.safe_key(file.get('id')) or int(file.get('size', 0)) > P.MAX_BYTES:
            raise ValueError('云盘文件无效或过大')
        return self.request(API + '/' + urllib.parse.quote(file['id'], safe='') + '?alt=media')

    def upload(self, name, data, properties, folder=None):
        boundary = 'folio_' + uuid.uuid4().hex
        meta = dict(name=name, mimeType='application/json', appProperties=dict(folioApp=APP, **properties))
        if folder:
            meta['parents'] = [folder]
        raw = ('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + json.dumps(meta, ensure_ascii=False) +
               '\r\n--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + json.dumps(data, ensure_ascii=False) + '\r\n--' + boundary + '--\r\n').encode()
        if len(raw) > P.MAX_BYTES:
            raise ValueError('阅读文件超过 64 MB，请减少原页图片后重试')
        return self.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,appProperties', raw,
                            {'Content-Type': 'multipart/related; boundary=' + boundary}, 'POST')

    def folder(self, files):
        folders = sorted([f for f in files if (f.get('appProperties') or {}).get('folioType') == 'folder'], key=lambda f: f['id'])
        if folders:
            return folders[0]['id']
        data = dict(name='Folio Read', mimeType='application/vnd.google-apps.folder', appProperties=dict(folioApp=APP, folioType='folder'))
        file = self.request(API + '?fields=id', json.dumps(data).encode(), {'Content-Type': 'application/json'}, 'POST')
        files.append(dict(file, appProperties={'folioType': 'folder'}))
        return file['id']

    def binary_request(self, url, body=None, headers=None, method=None, limit=128*1024*1024):
        if not url.startswith('https://www.googleapis.com/'):
            raise ValueError('云盘文件地址无效')
        if not self.token or time.time() >= self.expires:
            self.request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)')
        req = urllib.request.Request(url, body, {**(headers or {}), 'Authorization':'Bearer '+self.token}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                raw = response.read(limit+1)
                if len(raw)>limit:
                    raise ValueError('原始 PDF 超过 128 MB')
                return raw, response.headers
        except urllib.error.HTTPError as error:
            if error.code == 308:
                return None, error.headers
            raise ValueError(f'Google 文件传输失败（{error.code}），原稿仍保存在本机') from None

    @staticmethod
    def latest_kind(files, pid, kind):
        matches = [f for f in files if (f.get('appProperties') or {}).get('folioType') == kind and f['appProperties'].get('folioPaperId') == pid]
        return max(matches, key=lambda f: (P.timestamp(f.get('modifiedTime')), f['id']), default=None)

    def upload_source(self, ws, pid, files, parent):
        if self.latest_kind(files, pid, 'source'):
            return
        path = ws.root / 'source.pdf'
        if not path.is_file():
            return
        if path.stat().st_size>128*1024*1024:
            raise ValueError('原始 PDF 超过 128 MB，请先压缩')
        raw=path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=pid or not raw.startswith(b'%PDF'):
            raise ValueError('原始 PDF 与论文标识不一致，请检查原稿')
        if (ws.load('reader').get('_cloud') or {}).get('drive_imported'):
            parent = self.source_folder(files, parent)
        meta=dict(name=(ws.load('paper').get('meta') or {}).get('source') or ws.id+'.pdf', mimeType='application/pdf', parents=[parent],
                  appProperties=dict(folioApp=APP, folioType='source', folioPaperId=pid))
        _, headers=self.binary_request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,modifiedTime,size,appProperties',
                                      json.dumps(meta).encode(), {'Content-Type':'application/json','X-Upload-Content-Type':'application/pdf','X-Upload-Content-Length':str(len(raw))}, 'POST')
        session=headers.get('Location')
        if not session or not session.startswith('https://www.googleapis.com/upload/drive/'):
            raise ValueError('Google 上传会话无效')
        offset=0
        while offset<len(raw):
            end=min(len(raw),offset+4*1024*1024)
            result,headers=self.binary_request(session, raw[offset:end], {'Content-Type':'application/pdf','Content-Range':f'bytes {offset}-{end-1}/{len(raw)}'}, 'PUT', limit=P.MAX_BYTES)
            if result is not None:
                files.append(json.loads(result));return
            received=headers.get('Range')
            next_offset=int(received.rsplit('-',1)[1])+1 if received else 0
            if next_offset<=offset or next_offset>len(raw):
                raise ValueError('PDF 上传进度无效，请重试')
            offset=next_offset
        raise ValueError('PDF 上传未得到完成确认，请重试')

    def source_bytes(self, files, pid):
        file=self.latest_kind(files,pid,'source')
        if not file:
            return None
        if not P.safe_key(file.get('id')) or int(file.get('size',0))>128*1024*1024:
            raise ValueError('云端原始 PDF 无效或过大')
        raw,_=self.binary_request(API+'/'+urllib.parse.quote(file['id'],safe='')+'?alt=media')
        if not raw or not raw.startswith(b'%PDF') or hashlib.sha256(raw).hexdigest()!=pid:
            raise ValueError('云端 PDF 校验失败，请保留文件并重新同步')
        return raw

    @staticmethod
    def content_hash(data):
        content={k:data[k] for k in ('paper','images','discussion')}
        content['item']={k:data.get('item',{})[k] for k in ('status','starred','rating','meta_override') if k in data.get('item',{})}
        return hashlib.sha256(P.canonical(content).encode()).hexdigest()

    @staticmethod
    def legacy_content_hash(data):
        """Recognize the tags-inclusive hash stored by pre-organization clients."""
        content = {k: data[k] for k in ('paper', 'images', 'discussion')}
        content['item'] = {k: data.get('item', {})[k] for k in ('tags', 'status', 'starred', 'rating', 'meta_override') if k in data.get('item', {})}
        return hashlib.sha256(P.canonical(content).encode()).hexdigest()

    @staticmethod
    def latest(files, pid):
        matches = [f for f in files if (f.get('appProperties') or {}).get('folioType') == 'paper' and f['appProperties'].get('folioPaperId') == pid]
        return max(matches, key=lambda f: (P.timestamp(f.get('modifiedTime')), f['id']), default=None)

    def events(self, files, pid):
        events = []
        for f in files:
            props = f.get('appProperties') or {}
            if props.get('folioType') == 'ops' and props.get('folioPaperId') == pid:
                file_id = str(f['id'])
                if not all(c.isalnum() or c in '_-' for c in file_id) or len(file_id) > 200:
                    raise ValueError('云端批注标识无效')
                cache = self.home / '.drive-cache' / self._account_key(self.account)
                cache.mkdir(parents=True, exist_ok=True)
                data = read_json(cache / (file_id + '.json'))
                if data is None:
                    data = self.download(f)
                if data.get('schema') != 1 or data.get('paper_id') != pid or not isinstance(data.get('ops'), list):
                    raise ValueError('云端批注文件不完整，请保留文件并检查同步')
                if not (cache / (file_id + '.json')).exists():
                    write_json_atomic(cache / (file_id + '.json'), data)
                events.extend(data['ops'])
        return events

    def bundle(self, ws):
        from .links import for_reader
        paper = for_reader(ws)
        if not paper.get('blocks'):
            blocks = self._original_blocks(ws)
            if blocks:
                paper['blocks']=blocks;paper.setdefault('meta',{})['text_status']='original'
                paper['meta']['extraction_note']='PDF 原文，尚未翻译。复杂排版请对照原页。'
        elif any(b.get('zh') for b in paper['blocks']):
            paper.setdefault('meta',{})['text_status']='translated'
        images = {}
        paths = [p.get('img') for p in paper.get('meta', {}).get('pages', [])] + [b.get('src') for b in paper.get('blocks', [])]
        for rel in filter(None, paths):
            path = (ws.root / rel).resolve()
            if not path.is_relative_to(ws.root) or str(rel).replace('\\', '/').split('/')[0] not in ('pages', 'figures'):
                raise ValueError('阅读图片必须位于论文目录')
            if path.is_file():
                mime = {'.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif'}.get(path.suffix.lower(), 'webp')
                images[rel] = 'data:image/' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode()
        from .organization import Organization, paper_id, export_subset
        organization = export_subset(Organization(self.lib).load(), [paper_id(ws)])
        return P.normalize(dict(paper_id=ws.id, paper=paper, reader=ws.load('reader'), item=ws.load('item'), discussion=ws.load('discussion'), images=images, organization=organization))

    def select(self, ids, sync_all=False):
        selected = set(ids)
        self.cfg['sync_all']=bool(sync_all)
        write_json_atomic(self.config_path,self.cfg)
        for ws in self.lib.all():
            def change(reader):
                reader.setdefault('_cloud', {})['enabled'] = ws.id in selected
            ws.update('reader', change)

    def _sync_workspace(self, ws, files):
        content_versions = {name: (ws.root / (name+'.json')).read_bytes() if (ws.root / (name+'.json')).exists() else None for name in ('paper','discussion','item')}
        data = self.bundle(ws); pid = data['paper_id']
        local = ws.load('reader'); cloud = local.get('_cloud') or {}
        if cloud.get('account') and cloud['account'] != self.account['permissionId']:
            raise ValueError('所选论文已绑定另一 Google 账号，请切回原账号')
        remote = self.latest(files, pid)
        parent = self.folder(files)
        self.upload_source(ws,pid,files,parent)
        content_hash = self.content_hash(data)
        legacy_data = dict(data, item=ws.load('item') or {})
        unchanged_local = cloud.get('content_hash') in (content_hash, self.legacy_content_hash(legacy_data))
        observed_remote = cloud.get('remote_content_hash', cloud.get('content_hash'))
        remote_hash = (remote or {}).get('appProperties', {}).get('folioContent')
        if remote and cloud.get('content_hash') and 'remote_content_hash' not in cloud and not unchanged_local and remote_hash not in (None, cloud['content_hash'], content_hash):
            # Old sidebar tag edits also changed item.json. The immutable old
            # snapshot is the only reliable baseline for distinguishing those
            # edits from changed article content during the hash migration.
            baseline_file = next((f for f in files if f.get('appProperties', {}).get('folioType') == 'paper'
                                  and f['appProperties'].get('folioPaperId') == pid
                                  and f['appProperties'].get('folioContent') == cloud['content_hash']), None)
            if not baseline_file:
                raise ValueError('旧版同步基线缺失且云端正文已更新；已保留两端内容，请先备份后重新导入云端论文')
            baseline = P.normalize(self.download(baseline_file))
            if baseline['paper_id'] != pid:
                raise ValueError('旧版同步基线标识不匹配，已保留本机内容')
            unchanged_local = self.content_hash(baseline) == content_hash
        if remote and unchanged_local and remote_hash not in (None, content_hash, observed_remote):
            self.pull(remote['id'], files=files, update_content=True, expected_content=content_versions)
            data=self.bundle(ws);local=ws.load('reader');cloud=local.get('_cloud') or {};content_hash=self.content_hash(data)
        if not remote or (remote['appProperties'].get('folioContent') != content_hash and cloud.get('content_hash') != content_hash):
            remote = self.upload((data['paper']['meta'].get('short_zh') or ws.id)[:60] + '.folio.json', data, dict(folioType='paper', folioPaperId=pid, folioContent=content_hash), parent)
            files.append(remote)
        initial = [] if cloud.get('synced_once') else P.reader_events(local, self.device)
        outgoing = initial + cloud.get('pending', [])
        if outgoing:
            batch = str(uuid.uuid4())
            files.append(self.upload('笔记-' + batch + '.json', dict(schema=1, paper_id=pid, device_id=self.device, ops=outgoing),
                                     dict(folioType='ops', folioPaperId=pid, folioBatch=batch), parent))
        fresh = self.list_files()
        remote_data = P.normalize(self.download(self.latest(fresh, pid)))
        events = self.events(fresh, pid)
        sent = {e['event_id'] for e in outgoing}
        with dir_lock(ws.root):
            current = ws.load('reader')
            pending = [e for e in (current.get('_cloud') or {}).get('pending', []) if e['event_id'] not in sent]
            merged = P.materialize([local, remote_data['reader']], events + pending)
            merged['rev'] = current.get('rev', 0) + 1
            merged['_cloud'] = dict(cloud, enabled=True, account=self.account['permissionId'], synced_once=True, pending=pending,
                                     content_hash=content_hash, remote_content_hash=(remote or {}).get('appProperties', {}).get('folioContent'), synced_at=now_iso())
            ws._snapshot(); write_json_atomic(ws.reader_path, merged)
        self._merge_bundle_organization(remote_data)
        index=P.normalize(dict(remote_data, reader=merged, images={}))
        # Classification has its own snapshots. Do not re-upload article text
        # for a folder rename, tag edit, or tombstone.
        index.pop('organization', None)
        index['item'].pop('tags', None)
        index['reader']['progress']=dict(block=None,ratio=0,at='')
        index_hash=hashlib.sha256(P.canonical(index).encode()).hexdigest()
        prior_index=self.latest_kind(fresh,pid,'index')
        if not prior_index or prior_index['appProperties'].get('folioContent')!=index_hash:
            fresh.append(self.upload((index['paper']['meta'].get('title_zh') or index['paper']['meta'].get('title_en') or ws.id)[:60]+'.knowledge.json',index,
                                     dict(folioType='index',folioPaperId=pid,folioContent=index_hash),parent))
        return fresh

    def _organization_account(self, bind=False):
        """Logical metadata must not leak after switching the connected account."""
        path = self.lib.root / '.organization-account.json'
        with dir_lock(self.lib.root, '.organization.lock'):
            account = (read_json(path, {}) or {}).get('account')
            if account and account != self.account['permissionId']:
                raise ValueError('分类资料已绑定另一 Google 账号，请切回原账号')
            if bind and not account:
                write_json_atomic(path, {'account': self.account['permissionId']})

    def _merge_bundle_organization(self, data):
        from .organization import Organization, empty, tags, has_data
        if isinstance(data.get('organization'), dict):
            state = data['organization']
        else:
            state = empty()
            state['assignments'][data['paper_id']] = {'folder_id': None, 'tags': tags(data.get('item', {}).get('tags', []), False), 'version': {'at': '', 'id': ''}}
        if has_data(state):
            self._organization_account(bind=True)
        return Organization(self.lib).merge(state)

    def _sync_organization(self, files, publish=True):
        """Immutable snapshots merge by record, including empty-folder tombstones."""
        from .organization import Organization, paper_id, subset, has_data
        self._organization_account()
        organization = Organization(self.lib)
        states = []
        for file in files:
            if file.get('appProperties', {}).get('folioType') != 'organization':
                continue
            data = self.download(file)
            if not isinstance(data, dict):
                raise ValueError('云端分类文件无效，请保留文件并重试')
            state = data.get('organization', data)
            if not isinstance(state, dict) or state.get('schema') != 1 or not isinstance(state.get('folders'), dict) or not isinstance(state.get('assignments'), dict):
                raise ValueError('云端分类文件无效，请保留文件并重试')
            states.append(state)
        if any(has_data(state) for state in states):
            self._organization_account(bind=True)
        state = organization.merge(*states)
        eligible = {paper_id(ws) for ws in self.lib.all() if self.cfg.get('sync_all', True) or (ws.load('reader').get('_cloud') or {}).get('enabled')}
        # Retain already-synced assignments while excluding never-selected papers.
        eligible.update(f['appProperties'].get('folioPaperId') for f in files if f.get('appProperties', {}).get('folioType') == 'paper')
        outgoing = subset(state, eligible)
        outgoing['assignments'] = {pid: row for pid, row in outgoing['assignments'].items() if row['folder_id'] or row['tags'] or row['version']['at'] or row['version']['id']}
        if not publish or not (outgoing['folders'] or outgoing['assignments']):
            return files
        digest = hashlib.sha256(P.canonical(outgoing).encode()).hexdigest()
        if not any(f.get('appProperties', {}).get('folioType') == 'organization' and f['appProperties'].get('folioContent') == digest for f in files):
            self._organization_account(bind=True)
            payload = {'schema': 1, 'kind': 'folio-organization', 'organization': outgoing}
            files.append(self.upload('organization-' + str(uuid.uuid4()) + '.json', payload,
                                     {'folioType': 'organization', 'folioContent': digest}, self.folder(files)))
        return files

    def sync(self):
        self.identify()
        files = self.list_files()
        def selected():
            return [ws for ws in self.lib.all() if self.cfg.get('sync_all', True) or (ws.load('reader').get('_cloud') or {}).get('enabled')]
        # Never upload any selected paper to an accidentally switched account.
        for ws in selected():
            bound = (ws.load('reader').get('_cloud') or {}).get('account')
            if bound and bound != self.account['permissionId']:
                raise ValueError('所选论文已绑定另一 Google 账号，请切回原账号')
        self._organization_account()
        organization_errors = []
        try:
            files = self._sync_organization(files, publish=False)
        except Exception as error:
            organization_errors.append(dict(name='分类资料', error=str(error)[:200]))
        if self.cfg.get('folder_import_enabled') and FOLDER_READ_SCOPE in self.granted_scopes:
            self.folder(files)
        imported, errors = self.import_folder_pdfs(files)
        errors.extend(organization_errors)
        workspaces = selected()
        for i, ws in enumerate(workspaces):
            self.message = f'正在同步 {i+1} / {len(workspaces)} 篇'
            try:
                files = self._sync_workspace(ws, files)
            except Exception as error:
                errors.append(dict(name=(ws.load('paper').get('meta') or {}).get('title_en') or ws.id, error=str(error)[:200]))
        if self.cfg.get('sync_all', True):
            known = {(w.load('paper').get('meta') or {}).get('source_sha256') or w.id for w in self.lib.all()}
            for pid in sorted({f['appProperties']['folioPaperId'] for f in files if f.get('appProperties', {}).get('folioType') == 'paper'} - known):
                try:
                    self.message = '正在接收另一设备上传的论文'
                    self.pull(self.latest(files, pid)['id'], files=files)
                except Exception as error:
                    errors.append(dict(name=pid, error=str(error)[:200]))
        try:
            files = self._sync_organization(self.list_files())
        except Exception as error:
            errors.append(dict(name='分类资料', error=str(error)[:200]))
        self.files = files
        self.import_errors = errors
        self.cfg['last_sync_attempt'] = now_iso()
        self.cfg['device_id'] = self.device
        if not errors:
            self.cfg['last_sync'] = now_iso()
        write_json_atomic(self.config_path, self.cfg)
        self.message = (f'已导入 {imported} 篇；' if imported else '') + ('同步完成' if not errors else f'其余同步已完成；{len(errors)} 项需重试')
        self.error = '；'.join(f"{e['name']}: {e['error']}" for e in errors)[:600]

    def pull(self, file_id, files=None, update_content=False, expected_content=None):
        """Receive the shared document and verified original PDF, with local caching."""
        self.identify(); files = self.list_files() if files is None else files
        file = next((f for f in files if f['id'] == file_id and (f.get('appProperties') or {}).get('folioType') == 'paper'), None)
        if not file:
            raise ValueError('找不到这篇云端论文，请刷新后再试')
        self._organization_account()
        data = P.normalize(self.download(file)); pid = data['paper_id']
        if pid != file['appProperties'].get('folioPaperId'):
            raise ValueError('云端论文标识不匹配')
        remote = P.materialize([data['reader']], self.events(files, pid))
        ws = next((w for w in self.lib.all() if (w.load('paper') or {}).get('meta', {}).get('source_sha256') == pid or w.id == pid), None)
        if ws and (ws.load('reader').get('_cloud') or {}).get('account') not in (None,self.account['permissionId']):
            raise ValueError('这篇论文属于另一 Google 账号')
        if ws is None:
            from .store import Workspace, empty_discussion, empty_reader
            import tempfile
            if not P.safe_key(pid) or not all(c.isalnum() or c in '_-' for c in pid) or len(pid) > 64:
                raise ValueError('论文同步标识不能用作本机文件名')
            folder_id = pid[:12] if len(pid) == 64 else pid
            if (self.lib.root / folder_id).exists():
                folder_id = pid
            destination = self.lib.root / folder_id
            if destination.exists():
                raise ValueError('本机论文目录冲突，请先检查资料库')
            stage = Path(tempfile.mkdtemp(prefix='.drive-import-', dir=self.lib.root))
            source=self.source_bytes(files,pid)
            if source:
                (stage/'source.pdf').write_bytes(source)
            for rel, image in data['images'].items():
                path = (stage / rel).resolve()
                if not path.is_relative_to(stage) or rel.replace('\\', '/').split('/')[0] not in ('pages', 'figures'):
                    raise ValueError('云端图片路径无效')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(image.split(',', 1)[1], validate=True))
            write_json_atomic(stage / 'paper.json', data['paper'])
            write_json_atomic(stage / 'discussion.json', data.get('discussion') or empty_discussion())
            write_json_atomic(stage / 'item.json', dict(data.get('item') or {}, added=now_iso()))
            write_json_atomic(stage / 'reader.json', empty_reader())
            stage.rename(destination); ws = Workspace(destination)
        elif update_content:
            # Validate every image before touching the local document. Downloading must
            # not replace a translation or metadata edit made while the request ran.
            images=[]
            for rel,image in data['images'].items():
                path=(ws.root/rel).resolve()
                if not path.is_relative_to(ws.root) or rel.replace('\\','/').split('/')[0] not in ('pages','figures'):
                    raise ValueError('云端图片路径无效')
                images.append((path,base64.b64decode(image.split(',',1)[1],validate=True)))
            with dir_lock(ws.root):
                if expected_content is None or any(((ws.root/(name+'.json')).read_bytes() if (ws.root/(name+'.json')).exists() else None)!=raw for name,raw in expected_content.items()):
                    raise ValueError('下载期间本机正文有更新，已保留本机修改，请再次同步')
                if ws.load('job').get('state') in ('running','queued'):
                    raise ValueError('这篇论文正在处理，完成后再同步正文')
                for path,raw in images:
                    path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
                write_json_atomic(ws.paper_path,data['paper'])
                write_json_atomic(ws.discussion_path,data.get('discussion') or {})
                write_json_atomic(ws.item_path,dict(ws.load('item'),**data.get('item',{})))
        if not (ws.root/'source.pdf').exists():
            source=self.source_bytes(files,pid)
            if source:
                (ws.root/'source.pdf').write_bytes(source)
        with dir_lock(ws.root):
            current = ws.load('reader'); cloud = current.get('_cloud') or {}
            if cloud.get('account') and cloud['account'] != self.account['permissionId']:
                raise ValueError('这篇论文属于另一 Google 账号')
            merged = P.materialize([current, remote], cloud.get('pending', []))
            merged['rev'] = current.get('rev', 0) + 1
            merged['_cloud'] = dict(cloud, enabled=True, account=self.account['permissionId'], pending=cloud.get('pending', []),
                                    synced_once=True, content_hash=self.content_hash(data), remote_content_hash=file.get('appProperties', {}).get('folioContent'))
            ws._snapshot(); write_json_atomic(ws.reader_path, merged)
        self._merge_bundle_organization(data)
        self.files = files; self.message = '论文已下载到 Windows，可离线阅读'

    def run(self, action, *args):
        with self.lock:
            if self.busy:
                raise ValueError('连接或同步正在进行')
            self.busy = True; self.error = ''
        def work():
            try:
                getattr(self, action)(*args)
            except Exception as e:
                self.error = str(e)[:300]; self.message = '操作未完成'
            finally:
                self.busy = False
        threading.Thread(target=work, daemon=True).start()

    def disconnect(self):
        if self.busy:
            raise ValueError('请等当前同步结束后再断开')
        self.token_path.unlink(missing_ok=True)
        self.token = ''; self.account = None; self.granted_scopes = set(); self.files = []; self.message = '已断开本机登录'
