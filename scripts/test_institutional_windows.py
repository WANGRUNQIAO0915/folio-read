"""Exercise the real bridge-free institutional WebView2 on a Windows desktop.

Run with ``python scripts/test_institutional_windows.py --artifacts PATH`` after
installing ``.[desktop]`` and the official WebView2 Runtime. This is intentionally
separate from portable unit tests: it requires a real WinForms STA/message loop.
All web content, downloads, cookies, and app data are synthetic and local. No
publisher, university login, or paid-content endpoint is contacted.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# Direct script invocation must use this checkout, even after a non-editable pip
# install; the workflow records its exact commit alongside the test result.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def wait_until(predicate, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise TimeoutError(f'Timed out waiting for {label} ({timeout}s)')


def synthetic_pdf(title='Institutional WebView2 synthetic fixture'):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=200)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):
        DictionaryObject({NameObject('/F1'): font})})
    content = DecodedStreamObject()
    content.set_data(b'BT /F1 12 Tf 24 150 Td (Synthetic institutional PDF fixture.) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(content)
    writer.add_metadata({'/Title': title})
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class Fixtures:
    """A local attachment server; no actual authentication or external URLs."""

    def __init__(self):
        self.pdf = synthetic_pdf()
        self.requests = []
        self.slow_started = threading.Event()
        self.slow_stopped = threading.Event()
        self.release_slow = threading.Event()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                path = urlsplit(self.path).path
                fixture.requests.append(path)
                if path == '/':
                    body = b'''<!doctype html><html><head><meta charset="utf-8">
<title>Folio institutional download fixture</title></head><body>
<h1>Synthetic institution download fixture</h1>
<p>No credentials, external websites, or subscription resources are used.</p>
<a id="valid" href="/valid.pdf">Download a valid PDF</a><br>
<a id="duplicate" href="/duplicate.pdf">Download the same PDF again</a><br>
<a id="unarmed" href="/unarmed.pdf">Download without another permission</a><br>
<a id="malformed" href="/malformed.pdf">Download malformed PDF syntax</a><br>
<a id="html" href="/login.pdf">Download HTML disguised as a PDF</a><br>
<a id="slow" href="/slow.pdf">Download a slow PDF for cancellation</a>
</body></html>'''
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                elif path in ('/valid.pdf', '/duplicate.pdf', '/unarmed.pdf'):
                    body = fixture.pdf
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/pdf')
                    self.send_header('Content-Disposition', 'attachment; filename="fixture-paper.pdf"')
                elif path in ('/malformed.pdf', '/login.pdf'):
                    body = (b'%PDF-1.7\nthis is not a valid PDF object graph\n%%EOF\n'
                            if path == '/malformed.pdf' else b'<!doctype html><title>Please sign in</title>')
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/pdf')
                    self.send_header('Content-Disposition', 'attachment; filename="looks-valid.pdf"')
                elif path == '/slow.pdf':
                    # Enough body remains pending for a deterministic native
                    # cancel/close. Events control the fixture, never WebView2.
                    body = fixture.pdf + b' ' * (1024 * 1024)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/pdf')
                    self.send_header('Content-Disposition', 'attachment; filename="slow.pdf"')
                else:
                    body = b'not found'
                    self.send_response(404)
                    self.send_header('Content-Type', 'text/plain')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                try:
                    if path == '/slow.pdf':
                        fixture.slow_started.set()
                        self.wfile.write(body[:4096])
                        self.wfile.flush()
                        fixture.release_slow.wait(30)
                        self.wfile.write(body[4096:])
                    else:
                        self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass  # Expected when the native download is cancelled.
                finally:
                    if path == '/slow.pdf':
                        fixture.slow_stopped.set()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.release_slow.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def start_isolated_app(home):
    # Set these before the first easyread import. Never inspect a developer's
    # existing library/configuration, credentials, browser cache, or server.
    os.environ['EASYREAD_HOME'] = str(home)
    os.environ['EASYREAD_LIBRARY'] = str(home / 'library')
    os.environ.pop('COREAD_LIBRARY', None)
    (home / 'config.json').write_text(json.dumps({
        'port': 0, 'engine': 'none', 'auto_translate': False,
        'source_checks': False, 'library_dir': str(home / 'library'),
    }), encoding='utf-8')
    from easyread import config
    from easyread.log import setup
    from easyread.server import App, Handler

    setup(config.LOG_PATH)
    app = App(config.load())
    imports = []

    class RecordingHandler(Handler):
        def _json(self, code, obj):
            parsed = urlsplit(self.path)
            if self.command == 'POST' and parsed.path == '/api/import':
                # No auth header, request body, cookies, or token is recorded.
                imports.append({'status': code, 'query': parse_qs(parsed.query),
                                'result': obj})
            return super()._json(code, obj)

    RecordingHandler.app = app
    server = ThreadingHTTPServer(('127.0.0.1', 0), RecordingHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, app, imports, f'http://127.0.0.1:{server.server_port}'


def get_json(url, data=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['X-Token'] = token
    request = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                     headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read())


class NativeScenario:
    def __init__(self, home, artifacts, window, app, url, fixture, imports, report):
        self.home, self.artifacts, self.window = home, artifacts, window
        self.app, self.url, self.fixture, self.imports = app, url, fixture, imports
        self.report = report
        self.manager = None
        self.downloads, self.navigations, self.local_resources = [], [], []
        self.handlers = []  # Hold .NET event delegates alive for the full scenario.

    def check(self, name, condition, detail=None):
        self.report['checks'][name] = bool(condition)
        if detail is not None:
            self.report.setdefault('details', {})[name] = detail
        print(f'{"PASS" if condition else "FAIL"}: {name}', flush=True)
        if not condition:
            raise AssertionError(name)

    def ui(self, callback):
        from System import Action
        result = {}

        def invoke():
            try:
                result['value'] = callback()
            except BaseException as error:
                result['error'] = error

        self.window.native.Invoke(Action(invoke))
        if 'error' in result:
            raise result['error']
        return result.get('value')

    def js(self, script, timeout=15):
        def execute():
            source = urlsplit(str(self.manager.view.Source))
            origin = f'{source.scheme}://{source.netloc}'
            if origin != self.fixture.origin:
                raise AssertionError('Refusing ExecuteScriptAsync outside the exact synthetic fixture origin')
            return self.manager.view.ExecuteScriptAsync(script)

        task = self.ui(execute)
        wait_until(lambda: task.IsCompleted, 'fixture ExecuteScriptAsync', timeout)
        # The UI thread stays free to pump WebView2 completion messages.
        return json.loads(str(task.Result))

    def screenshot(self, name):
        from PIL import ImageGrab
        path = self.artifacts / f'{name}.png'
        ImageGrab.grab(all_screens=True).save(path)
        self.report.setdefault('screenshots', []).append(path.name)

    def attach_observers(self):
        def download(_, args):
            self.downloads.append({'path': urlsplit(str(args.DownloadOperation.Uri)).path,
                                   'cancelled': bool(args.Cancel), 'handled': bool(args.Handled)})

        def navigation(_, args):
            self.navigations.append({'url': str(args.Uri), 'cancelled': bool(args.Cancel)})

        def resource(_, args):
            if str(args.Request.Uri).startswith(self.url + '/'):
                self.local_resources.append({'url': str(args.Request.Uri),
                    'status': int(args.Response.StatusCode) if args.Response is not None else None})

        self.handlers.extend((download, navigation, resource))

        def attach():
            self.manager.view.CoreWebView2.DownloadStarting += download
            self.manager.view.CoreWebView2.NavigationStarting += navigation
            self.manager.view.CoreWebView2.WebResourceRequested += resource

        self.ui(attach)

    def open(self):
        self.manager.open()  # Exercise the real pywebview worker -> native STA handoff.
        wait_until(lambda: self.ui(lambda: self.manager.view.CoreWebView2 is not None),
                   'raw WebView2 initialization', 45)
        wait_until(lambda: self.ui(lambda: str(self.manager.view.Source).rstrip('/') == self.fixture.origin),
                   'fixture navigation', 30)
        wait_until(lambda: self.js('document.readyState === "complete" && !!document.querySelector("#valid")'),
                   'fixture DOM', 30)
        self.attach_observers()

    def choose_folder(self, folder_id):
        def select():
            self.manager.folder.SelectedIndex = self.manager.folder_ids.index(folder_id)
        self.ui(select)

    def click(self, link, armed=True):
        before = len(self.downloads)
        if armed:
            self.ui(lambda: self.manager.arm_button.PerformClick())
        self.js(f'document.getElementById({json.dumps(link)}).click(); true')
        wait_until(lambda: len(self.downloads) > before, f'native DownloadStarting for {link}', 30)
        event = self.downloads[-1]
        self.check(f'{link}_native_download_event', event['handled'] and event['cancelled'] is not armed, event)

    def import_link(self, link):
        before = len(self.manager.results)
        self.click(link)
        wait_until(lambda: len(self.manager.results) > before, f'{link} validation/import', 60)
        wait_until(lambda: self.ui(lambda: self.manager.active is None and self.manager.arm_button.Enabled),
                   f'{link} controls restored')
        self.check(f'{link}_staging_file_removed', not any(self.manager.download_dir.iterdir()))
        return self.manager.results[-1]

    def native_button(self, label):
        def find(control):
            if str(control.Text) == label and hasattr(control, 'PerformClick'):
                return control
            for child in control.Controls:
                found = find(child)
                if found is not None:
                    return found
            return None
        button = self.ui(lambda: find(self.manager.form))
        if button is None:
            raise AssertionError(f'Native button is missing: {label}')
        self.ui(button.PerformClick)

    def run(self):
        from easyread.institutional_browser import InstitutionalBrowser
        from easyread.organization import assignment, paper_id
        from System.Threading import Thread

        initial = get_json(self.url + '/api/library')
        self.check('isolated_library_initially_empty', not initial['items'])
        state = get_json(self.url + '/api/organization/folder', {'name': 'Fixture original folder'}, initial['token'])
        first_folder = next(iter(state['folders']))
        state = get_json(self.url + '/api/organization/folder', {'name': 'Fixture duplicate folder'}, initial['token'])
        second_folder = next(fid for fid in state['folders'] if fid != first_folder)
        self.manager = InstitutionalBrowser(self.home, self.window, self.url,
                                             allow_fixture_origin=self.fixture.origin)
        self.open()
        self.check('native_form_runs_on_sta', self.ui(lambda: str(Thread.CurrentThread.GetApartmentState())) == 'STA')
        self.check('actual_raw_webview2_control', self.ui(lambda: str(self.manager.view.GetType().FullName)) ==
                   'Microsoft.Web.WebView2.WinForms.WebView2')
        self.report['runtime'] = self.ui(lambda: str(self.manager.view.CoreWebView2.Environment.BrowserVersionString))
        self.check('fixture_has_no_pywebview_bridge', self.js('typeof window.pywebview === "undefined"'))
        settings = self.ui(lambda: {
            'web_messages': bool(self.manager.view.CoreWebView2.Settings.IsWebMessageEnabled),
            'host_objects': bool(self.manager.view.CoreWebView2.Settings.AreHostObjectsAllowed),
            'devtools': bool(self.manager.view.CoreWebView2.Settings.AreDevToolsEnabled),
            'password_autosave': bool(self.manager.view.CoreWebView2.Settings.IsPasswordAutosaveEnabled),
            'autofill': bool(self.manager.view.CoreWebView2.Settings.IsGeneralAutofillEnabled),
        })
        self.check('privileged_and_credential_features_disabled', not any(settings.values()), settings)
        profile = Path(self.manager.profile)
        self.check('institutional_profile_separate_from_app', profile.exists() and
                   profile.resolve() != (self.home / 'desktop-cache').resolve() and
                   not profile.resolve().is_relative_to(self.home.resolve()))
        self.check('institutional_profile_in_private_mode', self.ui(
            lambda: bool(self.manager.view.CreationProperties.IsInPrivateModeEnabled)))
        handle = self.ui(lambda: self.manager.form.Handle.ToInt64())
        self.manager.open()
        self.check('repeated_open_reuses_native_form', self.ui(lambda: self.manager.form.Handle.ToInt64()) == handle
                   and Path(self.manager.profile) == profile)
        self.js('localStorage.setItem("folio_fixture", "session-one"); document.cookie="folio_fixture=one; path=/"; true')

        # No permit means no import, even for a real attachment download.
        self.click('unarmed', armed=False)
        self.check('unarmed_download_not_imported', not self.imports and not self.manager.results)
        self.choose_folder(first_folder)
        first = self.import_link('valid')
        self.check('valid_pdf_imported', first.get('new') is True and bool(first.get('id')))
        ws = self.app.lib.ws(first['id'])
        self.check('import_preserves_exact_pdf_bytes', (ws.root / 'source.pdf').read_bytes() == self.fixture.pdf)
        state = get_json(self.url + '/api/organization')
        self.check('selected_folder_linked', assignment(state, paper_id(ws))['folder_id'] == first_folder)
        wait_until(lambda: (ws.load('job') or {}).get('state') not in (None, 'queued', 'running'),
                   'real local PDF preparation', 90)
        job = ws.load('job')
        self.check('prepare_only_job_completed', job.get('state') == 'done' and job.get('type') == 'prepare'
                   and job.get('translate') is False, {'state': job.get('state'), 'type': job.get('type')})
        self.screenshot('01-valid-pdf-imported')

        count = len(self.imports)
        self.click('unarmed', armed=False)
        self.check('one_shot_permission_consumed', len(self.imports) == count and len(self.manager.results) == 1)
        self.choose_folder(second_folder)
        duplicate = self.import_link('duplicate')
        self.check('duplicate_reuses_existing_paper', duplicate == {'id': first['id'], 'new': False}
                   and len(get_json(self.url + '/api/library')['items']) == 1)
        state = get_json(self.url + '/api/organization')
        self.check('duplicate_preserves_original_folder', assignment(state, paper_id(ws))['folder_id'] == first_folder)

        for link in ('malformed', 'html'):
            before = len(self.imports)
            rejected = self.import_link(link)
            self.check(f'{link}_rejected_before_import_api', 'error' in rejected and len(self.imports) == before
                       and len(get_json(self.url + '/api/library')['items']) == 1)
        self.check('all_native_imports_disable_translation', len(self.imports) == 2 and all(
            request['status'] == 200 and request['query'].get('translate') == ['0'] for request in self.imports))
        self.screenshot('02-invalid-download-rejected')

        before = len(self.navigations)
        self.ui(lambda: self.manager.navigate(self.url + '/api/library'))
        wait_until(lambda: len(self.navigations) > before, 'blocked app-origin navigation')
        self.check('remote_view_cannot_navigate_to_local_app', self.navigations[-1]['cancelled'] and
                   self.js('location.origin') == self.fixture.origin)

        before = len(self.local_resources)
        target = json.dumps(self.url + '/api/library?institutional-probe=1')
        self.js('window.__fixtureLocalFetch = "pending"; fetch(' + target +
                ', {mode:"no-cors"}).then(response => window.__fixtureLocalFetch = response.type)'
                '.catch(() => window.__fixtureLocalFetch = "blocked"); true')
        wait_until(lambda: len(self.local_resources) > before, 'native localhost subresource guard')
        wait_until(lambda: self.js('window.__fixtureLocalFetch !== "pending"'), 'blocked fetch completion')
        self.check('remote_view_cannot_fetch_local_app', self.local_resources[-1]['status'] == 403,
                   {'native_response_status': self.local_resources[-1]['status'],
                    'fixture_fetch_result': self.js('window.__fixtureLocalFetch')})

        # Exercise the actual cancel button while the server still has pending
        # bytes, then close while another download is in flight.
        self.click('slow')
        wait_until(lambda: self.ui(lambda: self.manager.active is not None), 'in-flight native download')
        self.native_button('取消下载')
        wait_until(lambda: self.ui(lambda: self.manager.active is None), 'native cancellation', 30)
        self.check('cancelled_download_not_imported', len(self.imports) == 2 and len(self.manager.results) == 4)
        self.check('cancelled_staging_file_removed', not any(self.manager.download_dir.iterdir()))
        self.fixture.release_slow.set()
        wait_until(self.fixture.slow_stopped.is_set, 'fixture observes cancelled transfer')
        self.fixture.release_slow.clear()
        self.fixture.slow_stopped.clear()
        self.click('slow')
        wait_until(lambda: self.ui(lambda: self.manager.active is not None), 'second in-flight native download')
        old_form = self.manager.form
        self.ui(old_form.Close)
        self.fixture.release_slow.set()
        wait_until(lambda: not profile.exists(), 'closed session profile cleanup', 40)
        self.check('close_cancels_download_and_deletes_profile', self.ui(lambda: old_form.IsDisposed)
                   and not profile.exists() and len(self.imports) == 2)

        self.open()
        reopened_profile = Path(self.manager.profile)
        self.check('reopen_creates_fresh_session', reopened_profile != profile and reopened_profile.exists())
        self.check('reopen_has_no_prior_session_storage', self.js(
            'localStorage.getItem("folio_fixture") === null && !document.cookie.includes("folio_fixture=")'))
        self.check('reopen_remains_bridge_free', self.js('typeof window.pywebview === "undefined"'))
        self.click('unarmed', armed=False)
        self.check('reopen_does_not_restore_download_permission', len(self.imports) == 2)
        self.screenshot('03-fresh-reopened-session')
        self.ui(self.manager.form.Close)
        wait_until(lambda: not reopened_profile.exists(), 'reopened session profile cleanup', 40)
        self.check('reopened_profile_cleaned', not reopened_profile.exists())
        self.check('library_survives_session_cleanup', (ws.root / 'source.pdf').read_bytes() == self.fixture.pdf
                   and len(get_json(self.url + '/api/library')['items']) == 1)
        self.report['pdf_sha256'] = hashlib.sha256(self.fixture.pdf).hexdigest()
        self.report['native_download_events'] = self.downloads
        self.report['import_requests'] = self.imports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, default=Path('institutional-windows-artifacts'))
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('This integration test requires Windows and a real WebView2 Runtime; it cannot be simulated.')
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    report = {'status': 'running', 'checks': {}, 'platform': platform.platform(),
              'python': sys.version, 'commit': os.environ.get('GITHUB_SHA', 'local-checkout')}
    report_path = artifacts / 'institutional-windows.json'

    def save_report():
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    def timed_out():
        report['status'] = 'failed'
        report['error'] = 'Native integration exceeded its 300-second deadline.'
        save_report()
        os._exit(2)  # Also ends a deadlocked native message loop on CI.

    watchdog = threading.Timer(300, timed_out)
    watchdog.daemon = True
    watchdog.start()
    fixture = server = scenario = None
    try:
        with tempfile.TemporaryDirectory(prefix='folio-institutional-test-', ignore_cleanup_errors=True) as directory:
            home = Path(directory)
            server, app, imports, url = start_isolated_app(home)
            fixture = Fixtures()
            import webview
            from webview.platforms import winforms
            if not winforms.is_chromium:
                raise RuntimeError('Install the official Microsoft Edge WebView2 Runtime before running this test.')
            window = webview.create_window('Folio Read institutional integration host', url,
                                            width=1000, height=760, min_size=(760, 560))
            scenario = NativeScenario(home, artifacts, window, app, url, fixture, imports, report)
            completed = threading.Event()

            def run():
                try:
                    wait_until(lambda: window.events.loaded.is_set(), 'local app host', 45)
                    scenario.run()
                    report['status'] = 'passed'
                except BaseException:
                    report['status'] = 'failed'
                    report['error'] = traceback.format_exc()
                    print(report['error'], file=sys.stderr, flush=True)
                    try:
                        scenario.screenshot('failure')
                    except Exception:
                        pass
                finally:
                    try:
                        if scenario.manager and scenario.manager.form and not scenario.manager.form.IsDisposed:
                            scenario.ui(scenario.manager.form.Close)
                    except Exception:
                        pass
                    save_report()
                    completed.set()
                    window.destroy()

            webview.start(run, gui='edgechromium', private_mode=False,
                          storage_path=str(home / 'desktop-cache'), debug=False)
            if not completed.is_set():
                raise RuntimeError('The native host closed before its integration scenario completed.')
            report['checks']['native_host_closed'] = window.events.closed.is_set()
            if not report['checks']['native_host_closed']:
                report['status'] = 'failed'
            server.shutdown()
            server.server_close()
            server = None
    except BaseException:
        report['status'] = 'failed'
        report['error'] = traceback.format_exc()
        print(report['error'], file=sys.stderr, flush=True)
    finally:
        watchdog.cancel()
        if fixture:
            fixture.close()
        if server:
            server.shutdown()
            server.server_close()
        save_report()
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return 0 if report['status'] == 'passed' and all(report['checks'].values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
