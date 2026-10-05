"""Windows-only, bridge-free WebView2 session for deliberate institutional downloads.

No cookie/token extraction, request replay, login automation, or publisher scraping.
The app window and this raw WebView2 never share a browser profile.
"""
from __future__ import annotations

import ipaddress
import json
import shutil
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlsplit

VPN_HELP = 'https://inc.swjtu.edu.cn/wlfw/VPNfw.htm'
SCIENCEDIRECT = 'https://www.sciencedirect.com/'
MAX_BYTES = 100 * 1024 * 1024


def safe_origin(url, fixture_origin=None):
    try:
        p = urlsplit(str(url))
        if fixture_origin and p.scheme == 'http' and f'http://{p.netloc}' == fixture_origin:
            return fixture_origin
        if p.scheme != 'https' or not p.hostname or p.username or p.password or p.port not in (None, 443):
            return None
        host = p.hostname.lower().rstrip('.')
        if '.' not in host or host.rsplit('.', 1)[-1].isdigit() or host.endswith(('.localhost', '.local', '.internal')):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        return 'https://' + host
    except (ValueError, TypeError):
        return None


def official_origin(origin):
    host = urlsplit(origin).hostname or ''
    return any(host == base or host.endswith('.' + base) for base in ('swjtu.edu.cn', 'sciencedirect.com'))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('本机接口不允许重定向')


class InstitutionalBrowser:
    def __init__(self, home, window, server_url, allow_fixture_origin=None):
        parsed = urlsplit(server_url)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError('机构导入需要本机应用服务')
        self.home, self.window, self.server_url = Path(home), window, server_url
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.fixture_origin = allow_fixture_origin
        self.form = self.view = self.status = self.folder = self.arm_button = None
        self.profile = None
        self.active = None
        self.results = []  # Only import IDs and generic outcomes; never URLs or auth state.
        self.armed_until = 0
        self.approved = set()
        self.session = 0
        self.commit_lock = threading.Lock()
        self.phase = "idle"
        self._closed = False

    def _ui(self, callback):
        from System import Action
        self.window.native.Invoke(Action(callback))

    def _guard(self, callback):
        session = self.session
        def guarded(sender, args):
            if not self._closed and session == self.session:
                callback(sender, args)
        return guarded

    def open(self):
        self._ui(self._open)

    def _open(self):
        if self.form is not None and not self.form.IsDisposed:
            self.form.Show(); self.form.Activate()
            return
        from System import Uri
        from System.Windows.Forms import (Form, Button, Label, ComboBox, ComboBoxStyle,
                                         FlowLayoutPanel, DockStyle)
        # Import only the assembly loader; do NOT instantiate EdgeChrome (JS bridge).
        from webview.platforms import edgechromium  # noqa: F401
        from Microsoft.Web.WebView2.WinForms import WebView2, CoreWebView2CreationProperties
        from . import config
        from .library import Library
        from .organization import Organization, folder_path
        self._closed = False
        self.session += 1
        self.cancelled = threading.Event()
        self.armed_until = 0
        self.approved = set()
        self.active = None
        self.phase = "idle"
        self.profile = Path(tempfile.mkdtemp(prefix='folio-institution-'))
        self.download_dir = self.profile / 'downloads'
        self.download_dir.mkdir()
        self.form = Form(); self.form.Text = 'Folio Read · 机构访问（临时会话）'
        self.form.Width = 1180; self.form.Height = 850
        bar = FlowLayoutPanel(); bar.Dock = DockStyle.Top; bar.Height = 100; bar.AutoScroll = True
        self.status = Label(); self.status.AutoSize = True
        self.status.Text = '请自行完成学校认证；不保证学校订阅。下载前先允许一次 PDF，关闭即结束临时会话。'
        self.folder = ComboBox(); self.folder.DropDownStyle = ComboBoxStyle.DropDownList; self.folder.Width = 180
        self.folder_ids = [None]; self.folder.Items.Add('保存到：未分类')
        state = Organization(Library(Path(config.load()['library_dir']))).load()
        for fid, record in state['folders'].items():
            if not record['deleted']:
                self.folder_ids.append(fid); self.folder.Items.Add(folder_path(state, fid))
        self.folder.SelectedIndex = 0
        def button(text, callback):
            b = Button(); b.Text = text; b.AutoSize = True
            b.Click += lambda *_: callback(); bar.Controls.Add(b)
            return b
        button('西南交大官方 VPN 指南', lambda: self.navigate(VPN_HELP))
        button('ScienceDirect', lambda: self.navigate(SCIENCEDIRECT))
        button('后退', lambda: self.view.GoBack() if self.view.CanGoBack else None)
        button('前进', lambda: self.view.GoForward() if self.view.CanGoForward else None)
        bar.Controls.Add(self.folder)
        self.arm_button = button('允许下一次 PDF 下载（2 分钟）', self.arm)
        button('取消下载', self.cancel)
        button('关闭并清除会话', lambda: self.form.Close())
        bar.Controls.Add(self.status)
        self.view = WebView2(); self.view.Dock = DockStyle.Fill
        props = CoreWebView2CreationProperties(); props.UserDataFolder = str(self.profile / 'browser')
        props.set_IsInPrivateModeEnabled(True)
        self.view.CreationProperties = props
        self.form.Controls.Add(self.view); self.form.Controls.Add(bar)
        self.view.CoreWebView2InitializationCompleted += self._guard(self._ready)
        self.form.FormClosing += self._closing
        self.form.Show(self.window.native)
        self.view.EnsureCoreWebView2Async(None)

    def navigate(self, url):
        if self.view.CoreWebView2:
            self.view.CoreWebView2.Navigate(url)

    def _ready(self, sender, args):
        if not args.IsSuccess:
            self.status.Text = '浏览器初始化失败。请检查官方 WebView2 Runtime，关闭后重试。'
            self.arm_button.Enabled = False
            return
        from Microsoft.Web.WebView2.Core import CoreWebView2PermissionState, CoreWebView2WebResourceContext
        core = self.view.CoreWebView2
        settings = core.Settings
        settings.IsWebMessageEnabled = False
        settings.AreHostObjectsAllowed = False
        settings.AreDevToolsEnabled = False
        settings.IsPasswordAutosaveEnabled = False
        settings.IsGeneralAutofillEnabled = False
        core.NavigationStarting += self._guard(self._navigation)
        core.FrameNavigationStarting += self._guard(self._frame_navigation)
        core.NewWindowRequested += self._guard(self._popup)
        core.DownloadStarting += self._guard(self._download)
        core.AddWebResourceRequestedFilter('*', CoreWebView2WebResourceContext.All)
        def resource(_, args):
            uri = str(args.Request.Uri)
            if not safe_origin(uri, self.fixture_origin):
                args.Response = core.Environment.CreateWebResourceResponse(None, 403, 'Blocked', '')
        core.WebResourceRequested += resource
        def permission(_, args):
            args.State = CoreWebView2PermissionState.Deny
            args.Handled = True
        core.PermissionRequested += permission
        core.NavigationCompleted += self._guard(self._navigated)
        core.Navigate(self.fixture_origin or VPN_HELP)

    def _navigation(self, _, args):
        origin = safe_origin(args.Uri, self.fixture_origin)
        if not origin:
            args.Cancel = True; self.status.Text = '已阻止不安全或本机地址。请使用官方 HTTPS 网站。'
            return
        if origin != self.fixture_origin and not official_origin(origin) and origin not in self.approved:
            # Never enter a nested/modal loop from a WebView2 event callback.
            # Cancelling a POST loses its body, so approve the origin only; the
            # user retries the original action, rather than us replaying login.
            args.Cancel = True
            from System import Action
            session = self.session
            def confirm_origin():
                if self._closed or session != self.session or origin in self.approved:
                    return
                from System.Windows.Forms import MessageBox, MessageBoxButtons, DialogResult
                answer = MessageBox.Show(self.form,
                    '页面请求转到：' + origin + '\n仅在确认是官方认证或出版社站点时允许。允许后请重新点击刚才的登录或链接。',
                    '确认机构跳转', MessageBoxButtons.YesNo)
                if answer == DialogResult.Yes and not self._closed and session == self.session:
                    self.approved.add(origin)
                    self.status.Text = '已允许该站点。请重新点击刚才的登录或链接。'
            self.form.BeginInvoke(Action(confirm_origin))

    def _frame_navigation(self, _, args):
        if str(args.Uri) != 'about:blank' and not safe_origin(args.Uri, self.fixture_origin):
            args.Cancel = True

    def _popup(self, _, args):
        args.Handled = True
        if args.IsUserInitiated:
            self.navigate(str(args.Uri))
        else:
            self.status.Text = '已拦截自动弹窗。请点击网页上的登录或论文链接。'

    def _navigated(self, _, args):
        if not args.IsSuccess:
            self.status.Text = '页面未能加载。可后退或重试；证书错误不会被绕过。'
        elif not self.active:
            self.status.Text = '当前站点：' + (safe_origin(self.view.Source.ToString(), self.fixture_origin) or '') + '。请自行登录并找到 PDF。'

    def arm(self):
        if self.active or not self.view.CoreWebView2:
            return
        self.armed_until = time.monotonic() + 120
        self.status.Text = '已允许接下来一次下载；请在两分钟内点击网页的 PDF 下载。不会自动检索或批量下载。'

    def cancel(self):
        self.armed_until = 0
        with self.commit_lock:
            if self.phase == "committing":
                if not self._closed:
                    self.status.Text = "已完成下载，正在写入文献库；此次导入不能再取消。"
                return
            if hasattr(self, "download_cancelled"):
                self.download_cancelled.set()
        if self.active:
            self.active.Cancel()
        else:
            self.status.Text = '已取消下载许可。'

    def _download(self, _, args):
        args.Handled = True
        op = args.DownloadOperation
        if self.active or time.monotonic() >= self.armed_until or not safe_origin(op.Uri, self.fixture_origin):
            args.Cancel = True
            self.status.Text = '下载已拦截。请先点击“允许下一次 PDF 下载”，每次只下载一篇。'
            return
        self.armed_until = 0
        if int(op.TotalBytesToReceive) > MAX_BYTES:
            args.Cancel = True; self.status.Text = '文件超过 100 MiB，已取消。'; return
        import uuid
        path = self.download_dir / (uuid.uuid4().hex + '.pdf')
        args.ResultFilePath = str(path)
        self.active = op
        self.phase = "download"
        self.download_cancelled = threading.Event()
        self.folder.Enabled = self.arm_button.Enabled = False
        fid = self.folder_ids[self.folder.SelectedIndex]
        # Do not use the publisher's suggested path/URL as a local filename or metadata.
        self.status.Text = '正在下载 PDF…（可取消）'
        finished = False
        session = self.session
        def progress(*_):
            if int(op.BytesReceived) > MAX_BYTES:
                op.Cancel()
            elif not self._closed and session == self.session:
                self.status.Text = f'正在下载：{int(op.BytesReceived) // 1024} KiB（可取消）'
        def state(*_):
            nonlocal finished
            current = str(op.State)
            if current not in ('Completed', 'Interrupted') or finished:
                return
            finished = True
            op.BytesReceivedChanged -= progress
            op.StateChanged -= state
            if current == 'Interrupted' or self._closed or session != self.session:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
                if session != self.session:
                    return
                self.active = None
                if not self._closed:
                    self.folder.Enabled = self.arm_button.Enabled = True
                    self.status.Text = '下载已取消或中断；没有导入。'
                return
            self.phase = 'validating'
            self.status.Text = '正在校验并导入 PDF…'
            threading.Thread(target=self._import, args=(path, fid, self.session, self.cancelled, self.download_cancelled), daemon=True).start()
        op.BytesReceivedChanged += progress
        op.StateChanged += state
        state()

    def _import(self, path, fid, session, cancelled, download_cancelled):
        from .institutional_import import validate_pdf
        result = None
        try:
            data = validate_pdf(path)
            if cancelled.is_set() or download_cancelled.is_set():
                raise InterruptedError()
            with self.http.open(self.server_url + '/api/library', timeout=10) as response:
                token = json.loads(response.read())['token']
            query = urlencode({'translate': '0', 'name': 'institutional-paper.pdf', 'folder_id': fid or ''})
            request = urllib.request.Request(self.server_url + '/api/import?' + query, data=data,
                                             headers={'X-Token': token, 'Content-Type': 'application/pdf'})
            with self.commit_lock:
                if cancelled.is_set() or download_cancelled.is_set():
                    raise InterruptedError()
                self.phase = "committing"
            with self.http.open(request, timeout=120) as response:
                result = json.loads(response.read())
            message = '已导入文献库，正在准备阅读。' if result['new'] else '这篇已在文献库中，原分类保持不变。'
            self.results.append(result)
        except InterruptedError:
            message = "已取消导入。"
        except Exception:
            # Exception strings from network/parser libraries may contain URLs or paths.
            message = '未能导入：请确认是有效、未加密且不含主动内容的 PDF（≤100 MiB），保存文件夹仍存在。'
            self.results.append({'error': 'validation_or_import_failed'})
        finally:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        def done():
            if session != self.session:
                return
            self.active = None
            self.phase = "idle"
            if not self._closed:
                self.folder.Enabled = self.arm_button.Enabled = True
                self.status.Text = message
        try:
            self._ui(done)
        except Exception:
            pass

    def _closing(self, *_):
        self._closed = True
        self.cancelled.set()
        self.cancel()
        self.view.Dispose()
        profile = self.profile
        def cleanup():
            for _ in range(30):
                try:
                    shutil.rmtree(profile)
                    return
                except FileNotFoundError:
                    return
                except OSError:
                    time.sleep(1)
        threading.Thread(target=cleanup, daemon=False, name="InstitutionalProfileCleanup").start()
