"""Portable state-machine checks; actual WebView2 behavior is tested on Windows."""
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from easyread import institutional_browser as browser


class EventHook:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self

    def __isub__(self, handler):
        self.handlers.remove(handler)
        return self

    def fire(self):
        for handler in list(self.handlers):
            handler(None, None)


class Operation:
    def __init__(self, uri='https://www.sciencedirect.com/paper.pdf', total=10):
        self.Uri = uri
        self.TotalBytesToReceive = total
        self.BytesReceived = 0
        self.State = 'InProgress'
        self.BytesReceivedChanged = EventHook()
        self.StateChanged = EventHook()
        self.Cancel = Mock()


class Response:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self):
        return json.dumps(self.value).encode()


class InstitutionalBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manager = browser.InstitutionalBrowser(self.root, None, 'http://127.0.0.1:54321')
        manager = self.manager
        manager.session = 1
        manager.cancelled = threading.Event()
        manager.download_cancelled = threading.Event()
        manager.download_dir = self.root
        manager.status = SimpleNamespace(Text='initial')
        manager.folder = SimpleNamespace(Enabled=True, SelectedIndex=0)
        manager.arm_button = SimpleNamespace(Enabled=True)
        manager.folder_ids = [None, 'chosen-folder']
        manager.view = SimpleNamespace(CoreWebView2=object())
        manager._ui = lambda callback: callback()

    def args(self, **kwargs):
        return SimpleNamespace(DownloadOperation=Operation(**kwargs), Handled=False, Cancel=False,
                               ResultFilePath='publisher-controlled.exe')

    def import_file(self):
        path = self.root / 'download.pdf'
        path.write_bytes(b'%PDF fixture')
        return path

    def run_import(self, path, folder=None):
        manager = self.manager
        with patch('easyread.institutional_import.validate_pdf', return_value=b'%PDF fixture'):
            manager._import(path, folder, manager.session, manager.cancelled, manager.download_cancelled)

    def test_safe_origin_only_public_https_and_exact_fixture(self):
        self.assertEqual(browser.safe_origin('https://WWW.ScienceDirect.COM:443/article?q=secret#part'),
                         'https://www.sciencedirect.com')
        self.assertEqual(browser.safe_origin('https://inc.swjtu.edu.cn.'), 'https://inc.swjtu.edu.cn')
        for url in ('http://example.org/', 'file:///C:/private.pdf', 'javascript:alert(1)',
                    'data:text/html,secret', 'about:blank', 'https://localhost/', 'https://host.local/',
                    'https://host.internal/', 'https://a.localhost/', 'https://127.0.0.1/',
                    'https://192.168.0.1/', 'https://10.0.0.1/', 'https://169.254.169.254/',
                    'https://[::1]/', 'https://user:password@example.org/', 'https://example.org:8443/',
                    'https://example.org:bad/', 'https:///no-host', None):
            with self.subTest(url=url):
                self.assertIsNone(browser.safe_origin(url))
        fixture = 'http://127.0.0.1:45678'
        self.assertEqual(browser.safe_origin(fixture + '/fixture.pdf', fixture), fixture)
        self.assertIsNone(browser.safe_origin('http://127.0.0.1:45679/fixture.pdf', fixture))
        self.assertIsNone(browser.safe_origin('http://localhost:45678/fixture.pdf', fixture))

    def test_attachment_navigation_abort_keeps_download_status(self):
        self.manager.status.Text = '正在下载 PDF'
        for error in ('ConnectionAborted', 'OperationCanceled'):
            self.manager._navigated(None, SimpleNamespace(IsSuccess=False, WebErrorStatus=error))
            self.assertEqual(self.manager.status.Text, '正在下载 PDF')
        self.manager._navigated(None, SimpleNamespace(IsSuccess=False, WebErrorStatus='CertificateExpired'))
        self.assertIn('证书错误不会被绕过', self.manager.status.Text)

    def test_official_origin_does_not_accept_lookalike_suffix(self):
        for origin in ('https://swjtu.edu.cn', 'https://inc.swjtu.edu.cn',
                       'https://sciencedirect.com', 'https://www.sciencedirect.com'):
            self.assertTrue(browser.official_origin(origin))
        for origin in ('https://evilsciencedirect.com', 'https://sciencedirect.com.evil.org',
                       'https://swjtu.edu.cn.evil.org'):
            self.assertFalse(browser.official_origin(origin))

    def test_server_constructor_accepts_only_loopback_origin(self):
        for origin in ('https://127.0.0.1:80', 'http://localhost:80', 'http://example.org:80',
                       'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
                       'http://127.0.0.1:80/', 'http://127.0.0.1:80/api',
                       'http://127.0.0.1:80?x=y', 'http://127.0.0.1:80#fragment',
                       'http://user:pass@127.0.0.1:80'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                browser.InstitutionalBrowser(self.root, None, origin)

    def test_local_opener_never_reads_proxy_settings_and_rejects_redirects(self):
        with patch.object(urllib.request, 'getproxies', side_effect=AssertionError('must not inspect proxies')):
            manager = browser.InstitutionalBrowser(self.root, None, 'http://127.0.0.1:54321')
        self.assertTrue(any(isinstance(handler, browser.NoRedirect) for handler in manager.http.handlers))
        self.assertFalse(any(isinstance(handler, urllib.request.ProxyHandler) and handler.proxies
                             for handler in manager.http.handlers))
        request = urllib.request.Request('http://127.0.0.1:54321/api/import', data=b'%PDF')
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code), self.assertRaises(ValueError):
                browser.NoRedirect().redirect_request(request, None, code, 'redirect', {}, 'https://example.org/')

    def test_guard_ignores_closed_or_replaced_session_callbacks(self):
        callback = Mock()
        guarded = self.manager._guard(callback)
        guarded('sender', 'args')
        callback.assert_called_once_with('sender', 'args')
        self.manager._closed = True
        guarded('closed sender', 'args')
        self.manager._closed = False
        self.manager.session += 1
        guarded('old sender after reopen', 'args')
        self.assertEqual(callback.call_count, 1)

    def test_ready_disables_bridges_and_denies_unsafe_subresources(self):
        core = SimpleNamespace(Settings=SimpleNamespace(), Environment=SimpleNamespace(
            CreateWebResourceResponse=Mock(return_value='blocked-response')),
            AddWebResourceRequestedFilter=Mock(), Navigate=Mock())
        for event in ('NavigationStarting', 'FrameNavigationStarting', 'NewWindowRequested',
                      'DownloadStarting', 'WebResourceRequested', 'PermissionRequested', 'NavigationCompleted'):
            setattr(core, event, EventHook())
        self.manager.view.CoreWebView2 = core
        native = SimpleNamespace(CoreWebView2PermissionState=SimpleNamespace(Deny='deny'),
                                 CoreWebView2WebResourceContext=SimpleNamespace(All='all'))
        with patch.dict(sys.modules, {'Microsoft.Web.WebView2.Core': native}):
            self.manager._ready(None, SimpleNamespace(IsSuccess=True))
        for setting in ('IsWebMessageEnabled', 'AreHostObjectsAllowed', 'AreDevToolsEnabled',
                        'IsPasswordAutosaveEnabled', 'IsGeneralAutofillEnabled'):
            self.assertIs(getattr(core.Settings, setting), False)
        core.AddWebResourceRequestedFilter.assert_called_once_with('*', 'all')
        core.Navigate.assert_called_once_with(browser.VPN_HELP)
        permission = SimpleNamespace(State=None, Handled=False)
        core.PermissionRequested.handlers[0](None, permission)
        self.assertEqual(permission.State, 'deny')
        self.assertTrue(permission.Handled)
        for uri, blocked in (('https://www.sciencedirect.com/asset.js', False),
                             ('http://127.0.0.1:54321/api/library', True),
                             ('http://localhost:54321/api/library', True),
                             ('file:///C:/private.txt', True),
                             ('https://192.168.1.2/', True)):
            with self.subTest(uri=uri):
                args = SimpleNamespace(Request=SimpleNamespace(Uri=uri), Response=None)
                core.WebResourceRequested.handlers[0](None, args)
                self.assertEqual(args.Response is not None, blocked)

    def test_download_requires_current_one_shot_arm(self):
        args = self.args()
        self.manager._download(None, args)
        self.assertTrue(args.Cancel)
        self.assertTrue(args.Handled)
        self.assertIsNone(self.manager.active)
        self.assertEqual(args.ResultFilePath, 'publisher-controlled.exe')

    def test_expired_arm_is_rejected(self):
        self.manager.armed_until = 10
        with patch.object(browser.time, 'monotonic', return_value=10):
            args = self.args()
            self.manager._download(None, args)
        self.assertTrue(args.Cancel)

    def test_arm_is_consumed_and_local_filename_is_owned(self):
        manager = self.manager
        with patch.object(browser.time, 'monotonic', return_value=100):
            manager.arm()
            self.assertEqual(manager.armed_until, 220)
            args = self.args()
            manager._download(None, args)
            second = self.args()
            manager._download(None, second)
        self.assertFalse(args.Cancel)
        self.assertTrue(second.Cancel)
        self.assertEqual(manager.armed_until, 0)
        self.assertIs(manager.active, args.DownloadOperation)
        self.assertEqual(Path(args.ResultFilePath).parent, self.root)
        self.assertRegex(Path(args.ResultFilePath).name, r'^[a-f0-9]{32}\.pdf$')
        self.assertFalse(manager.folder.Enabled)
        self.assertFalse(manager.arm_button.Enabled)

    def test_oversize_or_unsafe_download_never_starts(self):
        for kwargs in ({'total': browser.MAX_BYTES + 1}, {'uri': 'http://example.org/paper.pdf'},
                       {'uri': 'https://127.0.0.1/paper.pdf'}):
            with self.subTest(kwargs=kwargs):
                self.manager.arm()
                args = self.args(**kwargs)
                self.manager._download(None, args)
                self.assertTrue(args.Cancel)
                self.assertIsNone(self.manager.active)

    def test_unknown_length_download_enforces_running_byte_limit(self):
        self.manager.arm()
        args = self.args(total=-1)
        self.manager._download(None, args)
        args.DownloadOperation.BytesReceived = browser.MAX_BYTES + 1
        args.DownloadOperation.BytesReceivedChanged.fire()
        args.DownloadOperation.Cancel.assert_called_once_with()

    def test_interruption_resets_controls_and_cleans_download(self):
        self.manager.arm()
        args = self.args()
        self.manager._download(None, args)
        path = Path(args.ResultFilePath)
        path.write_bytes(b'partial')
        args.DownloadOperation.State = 'Interrupted'
        args.DownloadOperation.StateChanged.fire()
        self.assertIsNone(self.manager.active)
        self.assertTrue(self.manager.folder.Enabled)
        self.assertTrue(self.manager.arm_button.Enabled)
        self.assertFalse(path.exists())
        self.assertEqual(args.DownloadOperation.StateChanged.handlers, [])

    def test_stale_download_callbacks_cannot_touch_reopened_session(self):
        manager = self.manager
        manager.arm()
        args = self.args()
        manager._download(None, args)
        path = Path(args.ResultFilePath)
        path.write_bytes(b'old session')
        manager.session += 1
        current = manager.active = object()
        manager.status.Text = 'new session'
        manager.folder.Enabled = False
        args.DownloadOperation.BytesReceived = 20
        args.DownloadOperation.BytesReceivedChanged.fire()
        args.DownloadOperation.State = 'Completed'
        with patch.object(browser.threading, 'Thread') as thread:
            args.DownloadOperation.StateChanged.fire()
            thread.assert_not_called()
        self.assertIs(manager.active, current)
        self.assertEqual(manager.status.Text, 'new session')
        self.assertFalse(manager.folder.Enabled)
        self.assertFalse(path.exists())

    def test_cancel_sets_download_event_before_commit(self):
        self.manager.active = Operation()
        self.manager.phase = 'validating'
        self.manager.cancel()
        self.assertTrue(self.manager.download_cancelled.is_set())
        self.manager.active.Cancel.assert_called_once_with()

    def test_cancel_explains_irreversible_commit(self):
        self.manager.active = Operation()
        self.manager.phase = 'committing'
        self.manager.cancel()
        self.assertFalse(self.manager.download_cancelled.is_set())
        self.manager.active.Cancel.assert_not_called()
        self.assertIn('不能再取消', self.manager.status.Text)

    def test_cancelled_validation_never_fetches_token_or_posts(self):
        for event_name in ('cancelled', 'download_cancelled'):
            with self.subTest(event=event_name):
                self.manager.cancelled.clear()
                self.manager.download_cancelled.clear()
                getattr(self.manager, event_name).set()
                self.manager.http = Mock()
                path = self.import_file()
                self.run_import(path)
                self.manager.http.open.assert_not_called()
                self.assertFalse(path.exists())
                self.assertIn('已取消', self.manager.status.Text)
                self.assertEqual(self.manager.phase, 'idle')

    def test_cancel_during_token_fetch_prevents_import_post(self):
        manager = self.manager
        def token_response(*args, **kwargs):
            manager.download_cancelled.set()
            return Response({'token': 'local-token'})
        manager.http = SimpleNamespace(open=Mock(side_effect=token_response))
        path = self.import_file()
        self.run_import(path)
        manager.http.open.assert_called_once_with(manager.server_url + '/api/library', timeout=10)
        self.assertFalse(path.exists())
        self.assertIn('已取消', manager.status.Text)
        self.assertEqual(manager.results, [])

    def test_success_uses_original_bytes_no_translation_and_chosen_folder(self):
        manager = self.manager
        manager.http = SimpleNamespace(open=Mock(side_effect=[Response({'token': 'local-token'}),
                                                              Response({'id': 'paper-id', 'new': True})]))
        path = self.import_file()
        self.run_import(path, folder='chosen-folder')
        self.assertEqual(manager.http.open.call_count, 2)
        request = manager.http.open.call_args_list[1].args[0]
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.data, b'%PDF fixture')
        self.assertEqual(request.get_header('X-token'), 'local-token')
        self.assertEqual(parse_qs(urlsplit(request.full_url).query),
                         {'translate': ['0'], 'name': ['institutional-paper.pdf'], 'folder_id': ['chosen-folder']})
        self.assertEqual(manager.results, [{'id': 'paper-id', 'new': True}])
        self.assertFalse(path.exists())
        self.assertTrue(manager.folder.Enabled)
        self.assertTrue(manager.arm_button.Enabled)
        self.assertEqual(manager.phase, 'idle')

    def test_duplicate_result_preserves_existing_classification_message(self):
        self.manager.http = SimpleNamespace(open=Mock(side_effect=[Response({'token': 'local-token'}),
                                                                   Response({'id': 'paper-id', 'new': False})]))
        self.run_import(self.import_file(), folder='another-folder')
        self.assertIn('原分类保持不变', self.manager.status.Text)

    def test_failure_does_not_leak_exception_url_or_auth_data(self):
        self.manager.http = Mock()
        path = self.import_file()
        with patch('easyread.institutional_import.validate_pdf', side_effect=ValueError('https://idp.test/?token=secret')):
            self.manager._import(path, None, 1, self.manager.cancelled, self.manager.download_cancelled)
        self.manager.http.open.assert_not_called()
        self.assertNotIn('secret', self.manager.status.Text)
        self.assertNotIn('idp.test', self.manager.status.Text)
        self.assertEqual(self.manager.results, [{'error': 'validation_or_import_failed'}])
        self.assertFalse(path.exists())

    def test_old_import_completion_cannot_reset_new_session_controls(self):
        manager = self.manager
        current = object()
        def response(request, **kwargs):
            if isinstance(request, str):
                return Response({'token': 'local-token'})
            manager.session += 1
            manager.active = current
            manager.phase = 'download'
            manager.folder.Enabled = False
            manager.status.Text = 'new session'
            return Response({'id': 'old-paper', 'new': True})
        manager.http = SimpleNamespace(open=Mock(side_effect=response))
        self.run_import(self.import_file())
        self.assertIs(manager.active, current)
        self.assertEqual(manager.phase, 'download')
        self.assertFalse(manager.folder.Enabled)
        self.assertEqual(manager.status.Text, 'new session')


if __name__ == '__main__':
    unittest.main()
