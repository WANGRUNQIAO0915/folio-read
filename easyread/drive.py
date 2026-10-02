"""Google Drive sync for the desktop. Per-file scope, loopback PKCE, DPAPI.

No general Drive browsing, public sharing, model settings, or API keys.
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
            self.token = ''; self.account = None
        write_json_atomic(self.config_path, self.cfg)

    def status(self):
        return {'configured': bool(self.cfg.get('client_id')), 'client_id': self.cfg.get('client_id', ''),
                'connected': bool(self.account), 'account': self.account, 'busy': self.busy,
                'message': self.message, 'error': self.error, 'last_sync': self.cfg.get('last_sync', ''),
                'papers': [{'id': ws.id, 'selected': bool((ws.load('reader').get('_cloud') or {}).get('enabled')), 'title': (ws.load('paper') or {}).get('meta', {}).get('title_zh') or ws.id} for ws in self.lib.all()],
                'cloud': [f for f in self.files if (f.get('appProperties') or {}).get('folioType') == 'paper']}

    def _tokens(self, data):
        if data.get('scope') and SCOPE not in data['scope'].split():
            raise ValueError('请允许 Folio Read 访问它创建的云盘文件')
        self.token = data.get('access_token') or ''
        self.expires = time.time() + max(0, int(data.get('expires_in', 3600)) - 60)
        refresh = data.get('refresh_token')
        if refresh:
            self.token_path.write_bytes(_protect(json.dumps({'client_id': self.cfg['client_id'], 'refresh_token': refresh}).encode()))

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

    def login(self):
        if not self.cfg.get('client_id'):
            raise ValueError('请先保存 Google 桌面客户端配置')
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
            params = dict(client_id=self.cfg['client_id'], redirect_uri=redirect, response_type='code', scope=SCOPE,
                          state=state, code_challenge=challenge, code_challenge_method='S256', access_type='offline', prompt='consent select_account')
            self.message = '请在浏览器中完成 Google 登录授权'
            webbrowser.open('https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params))
            server.timeout = 1
            deadline = time.time() + 300
            while not result and time.time() < deadline:
                server.handle_request()
        if not result.get('code'):
            raise ValueError('Google 授权未完成或已超时')
        self._tokens(self._exchange(dict(grant_type='authorization_code', code=result['code'], redirect_uri=redirect, code_verifier=verifier)))
        self.identify(); self.files = self.list_files(); self.message = 'Google 云盘已连接'

    def list_files(self):
        files, page = [], ''
        while True:
            params = dict(q=f"trashed = false and appProperties has {{ key='folioApp' and value='{APP}' }}", pageSize=1000,
                          fields='nextPageToken,files(id,name,modifiedTime,size,appProperties)')
            if page:
                params['pageToken'] = page
            data = self.request(API + '?' + urllib.parse.urlencode(params))
            files.extend(data.get('files', [])); page = data.get('nextPageToken')
            if not page:
                return files

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
        images = {}
        paths = [p.get('img') for p in paper.get('meta', {}).get('pages', [])] + [b.get('src') for b in paper.get('blocks', [])]
        for rel in filter(None, paths):
            path = (ws.root / rel).resolve()
            if not path.is_relative_to(ws.root) or str(rel).replace('\\', '/').split('/')[0] not in ('pages', 'figures'):
                raise ValueError('阅读图片必须位于论文目录')
            if path.is_file():
                mime = {'.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif'}.get(path.suffix.lower(), 'webp')
                images[rel] = 'data:image/' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode()
        return P.normalize(dict(paper_id=ws.id, paper=paper, reader=ws.load('reader'), item=ws.load('item'), discussion=ws.load('discussion'), images=images))

    def select(self, ids):
        selected = set(ids)
        for ws in self.lib.all():
            def change(reader):
                reader.setdefault('_cloud', {})['enabled'] = ws.id in selected
            ws.update('reader', change)

    def sync(self):
        self.identify()
        files = self.list_files()
        workspaces = [ws for ws in self.lib.all() if (ws.load('reader').get('_cloud') or {}).get('enabled')]
        for i, ws in enumerate(workspaces):
            self.message = f'正在同步 {i+1} / {len(workspaces)} 篇'
            data = self.bundle(ws); pid = data['paper_id']
            local = ws.load('reader'); cloud = local.get('_cloud') or {}
            if cloud.get('account') and cloud['account'] != self.account['permissionId']:
                raise ValueError('所选论文已绑定另一 Google 账号，请切回原账号')
            remote = self.latest(files, pid)
            parent = self.folder(files)
            content_hash = hashlib.sha256(P.canonical({k: data[k] for k in ('paper', 'images', 'discussion')}).encode()).hexdigest()
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
                merged['_cloud'] = dict(enabled=True, account=self.account['permissionId'], synced_once=True, pending=pending,
                                         content_hash=content_hash, synced_at=now_iso())
                ws._snapshot(); write_json_atomic(ws.reader_path, merged)
            files = fresh
        self.files = files; self.cfg['last_sync'] = now_iso(); self.cfg['device_id'] = self.device
        write_json_atomic(self.config_path, self.cfg); self.message = '同步完成'

    def pull(self, file_id):
        """Download a selected cloud reading copy; never reconstruct a fake PDF."""
        self.identify(); files = self.list_files()
        file = next((f for f in files if f['id'] == file_id and (f.get('appProperties') or {}).get('folioType') == 'paper'), None)
        if not file:
            raise ValueError('找不到这篇云端论文，请刷新后再试')
        data = P.normalize(self.download(file)); pid = data['paper_id']
        if pid != file['appProperties'].get('folioPaperId'):
            raise ValueError('云端论文标识不匹配')
        remote = P.materialize([data['reader']], self.events(files, pid))
        ws = next((w for w in self.lib.all() if (w.load('paper') or {}).get('meta', {}).get('source_sha256') == pid or w.id == pid), None)
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
        with dir_lock(ws.root):
            current = ws.load('reader'); cloud = current.get('_cloud') or {}
            if cloud.get('account') and cloud['account'] != self.account['permissionId']:
                raise ValueError('这篇论文属于另一 Google 账号')
            merged = P.materialize([current, remote], cloud.get('pending', []))
            merged['rev'] = current.get('rev', 0) + 1
            merged['_cloud'] = dict(cloud, enabled=True, account=self.account['permissionId'], pending=cloud.get('pending', []))
            ws._snapshot(); write_json_atomic(ws.reader_path, merged)
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
        self.token = ''; self.account = None; self.files = []; self.message = '已断开本机登录'
