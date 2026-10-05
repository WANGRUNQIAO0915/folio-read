"""Portable bridge policy tests; real WebView2 coverage runs in Windows CI."""
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import MagicMock, patch

from easyread.desktop_pdf import (
    TranslationPdfExporter, _WebView2PdfJob, _save_dialog,
    pdf_filename, trusted_reader_url,
)


class FilenameTests(unittest.TestCase):
    def test_chinese_filename_and_extension_preserved(self):
        self.assertEqual(pdf_filename('流域生态研究_译文.pdf'), '流域生态研究_译文.pdf')
        self.assertEqual(pdf_filename('题名.PDF'), '题名.pdf')

    def test_only_a_filename_can_be_suggested(self):
        for source in ('../../secret.pdf', r'C:\Windows\file.pdf', 'a\x00b?:.pdf'):
            value = pdf_filename(source)
            self.assertNotRegex(value, r'[<>:"/\\|?*\x00-\x1f]')
            self.assertTrue(value.endswith('.pdf'))
            self.assertLessEqual(len(value), 124)
        self.assertEqual(pdf_filename('...'), '论文译文.pdf')
        self.assertEqual(pdf_filename('CON.pdf'), '_CON.pdf')
        self.assertEqual(pdf_filename('LPT9.backup.pdf'), '_LPT9.backup.pdf')
        self.assertLessEqual(len(pdf_filename('题' * 500)), 124)
        with self.assertRaises(ValueError):
            pdf_filename({'path': '/tmp/file.pdf'})

    def test_exact_loopback_origin_and_reader_route_required(self):
        app = 'http://127.0.0.1:8766'
        self.assertTrue(trusted_reader_url(app + '/read/p-1234#b-one', app))
        self.assertTrue(trusted_reader_url(app + '/read/p-1234?mode=zh', app + '/read/p-5678'))
        for url in [
            'https://127.0.0.1:8766/read/p-1234', 'http://localhost:8766/read/p-1234',
            'http://127.0.0.1:8767/read/p-1234', 'http://127.0.0.1:8766.evil/read/p-1234',
            'http://user@127.0.0.1:8766/read/p-1234', 'http://127.0.0.1:bad/read/p-1234',
            app + '/', app + '/study', app + '/read/', app + '/read/a',
            app + '/read/p-1234/../elsewhere', app + '/read/p-1234%2fother',
            'file:///read/p-1234', 'https://example.org/read/p-1234', '',
        ]:
            with self.subTest(url=url):
                self.assertFalse(trusted_reader_url(url, app))


class FakeJob:
    outcome = 'valid'

    def __init__(self, window, path, url):
        self.path = path
        self.done = threading.Event()

    def start(self):
        if self.outcome == 'start-error':
            raise RuntimeError('native start failed')
        self.path.write_bytes(b'%PDF-1.7\n' + b'x' * 256 if self.outcome == 'valid' else b'invalid')
        self.done.set()

    def wait(self):
        if self.outcome == 'error':
            raise RuntimeError('native print failed')


class ExporterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.target = Path(self.directory.name) / '中文译文.pdf'
        self.window = MagicMock()
        self.window.gui.renderer = 'edgechromium'
        self.window.get_current_url.return_value = 'http://127.0.0.1:8766/read/p-1234'
        self.window.evaluate_js.return_value = True
        self.exporter = TranslationPdfExporter('http://127.0.0.1:8766')
        self.exporter._bind_window(self.window)
        self.chooser = self.exporter._choose_destination = MagicMock(return_value=str(self.target))
        self.job_patch = patch('easyread.desktop_pdf._WebView2PdfJob', FakeJob)
        self.job_patch.start()
        self.addCleanup(self.job_patch.stop)
        self.log_patch = patch('easyread.desktop_pdf.logging.exception')
        self.log_patch.start()
        self.addCleanup(self.log_patch.stop)
        FakeJob.outcome = 'valid'

    def test_saves_chosen_destination_only_after_valid_pdf(self):
        self.target.write_bytes(b'previous file')
        result = self.exporter.export_translation_pdf('我的译文.pdf')
        self.assertEqual(result, {'status': 'saved', 'path': str(self.target)})
        self.chooser.assert_called_once_with('我的译文.pdf')
        self.assertTrue(self.target.read_bytes().startswith(b'%PDF-'))
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])

    def test_cancel_is_quiet_and_writes_nothing(self):
        self.chooser.return_value = None
        self.assertEqual(self.exporter.export_translation_pdf('取消.pdf'), {'status': 'cancelled'})
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_print_failure_preserves_existing_file_and_cleans_temporary(self):
        for outcome in ('error', 'invalid', 'start-error'):
            with self.subTest(outcome=outcome):
                FakeJob.outcome = outcome
                self.target.write_bytes(b'previous file')
                result = self.exporter.export_translation_pdf('译文.pdf')
                self.assertEqual(result['status'], 'error')
                self.assertTrue(result['error'])
                self.assertEqual(self.target.read_bytes(), b'previous file')
                self.assertEqual(list(self.target.parent.iterdir()), [self.target])
        FakeJob.outcome = 'valid'
        self.assertEqual(self.exporter.export_translation_pdf('再次.pdf')['status'], 'saved')

    def test_dialog_failure_is_error_not_cancellation(self):
        self.chooser.side_effect = RuntimeError('dialog failed')
        result = self.exporter.export_translation_pdf('译文.pdf')
        self.assertEqual(result, {'status': 'error', 'error': 'dialog failed'})
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_bridge_is_unavailable_outside_trusted_prepared_reader(self):
        for current, renderer, prepared in [
            ('http://evil.example/read/p-1234', 'edgechromium', True),
            ('http://127.0.0.1:8766/study', 'edgechromium', True),
            ('http://127.0.0.1:8766/read/p-1234', 'mshtml', True),
            ('http://127.0.0.1:8766/read/p-1234', 'edgechromium', False),
        ]:
            with self.subTest(current=current, renderer=renderer, prepared=prepared):
                self.window.get_current_url.return_value = current
                self.window.gui.renderer = renderer
                self.window.evaluate_js.return_value = prepared
                self.assertEqual(self.exporter.export_translation_pdf('译文.pdf')['status'], 'error')
        self.chooser.assert_not_called()

    def test_navigation_during_save_dialog_does_not_print(self):
        self.window.get_current_url.side_effect = [
            'http://127.0.0.1:8766/read/p-1234', 'http://127.0.0.1:8766/read/p-5678']
        self.assertEqual(self.exporter.export_translation_pdf('译文.pdf')['status'], 'error')
        self.assertFalse(self.target.exists())

    def test_invalid_extension_or_relative_destination_rejected(self):
        for selected in ('relative.pdf', str(self.target.with_suffix('.txt'))):
            self.chooser.return_value = selected
            self.assertEqual(self.exporter.export_translation_pdf('译文.pdf')['status'], 'error')
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_busy_bridge_and_pending_native_job_reject_repeated_clicks(self):
        self.exporter._lock.acquire()
        try:
            self.assertEqual(self.exporter.export_translation_pdf('译文.pdf')['status'], 'error')
        finally:
            self.exporter._lock.release()
        self.exporter._pending = types.SimpleNamespace(done=threading.Event())
        self.assertEqual(self.exporter.export_translation_pdf('译文.pdf')['status'], 'error')
        self.chooser.assert_not_called()
        self.exporter._pending.done.set()
        self.assertEqual(self.exporter.export_translation_pdf('译文.pdf')['status'], 'saved')

    def test_canonical_library_source_is_protected_but_exports_are_allowed(self):
        library = self.target.parent / 'configured-library'
        article = library / 'p-1234'
        article.mkdir(parents=True)
        source = article / 'source.pdf'
        source.write_bytes(b'original PDF must survive')
        self.exporter._library_root = library.resolve()
        for chosen in (source, article / 'subdir' / '..' / 'source.pdf'):
            self.chooser.return_value = str(chosen)
            result = self.exporter.export_translation_pdf('译文.pdf')
            self.assertEqual(result['status'], 'error')
            self.assertIn('不能覆盖', result['error'])
            self.assertEqual(source.read_bytes(), b'original PDF must survive')
        translated = article / '译文.pdf'
        self.chooser.return_value = str(translated)
        self.assertEqual(self.exporter.export_translation_pdf('译文.pdf')['status'], 'saved')
        self.assertTrue(translated.read_bytes().startswith(b'%PDF-'))
        # An unrelated source.pdf outside the configured library is user-owned.
        outside = self.target.parent / 'source.pdf'
        self.chooser.return_value = str(outside)
        self.assertEqual(self.exporter.export_translation_pdf('译文.pdf')['status'], 'saved')

    def test_destination_write_error_is_reported(self):
        with patch('easyread.desktop_pdf.os.replace', side_effect=PermissionError('file is open')):
            self.assertEqual(self.exporter.export_translation_pdf('译文.pdf'),
                             {'status': 'error', 'error': 'file is open'})
        self.assertEqual(list(self.target.parent.iterdir()), [])


class Delegate:
    def __new__(cls, callback):
        return callback

    @classmethod
    def __class_getitem__(cls, _type):
        return cls


class DotNetTask:
    """A completed .NET Task fake, checking that completion is UI-scheduled."""
    scheduler = object()

    @classmethod
    def __class_getitem__(cls, _type):
        return cls

    def __init__(self, result):
        self.Result = result

    def ContinueWith(self, callback, scheduler):
        assert scheduler is self.scheduler
        callback(self)


class NativeJobTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'native.pdf'
        self.window = MagicMock()
        self.window.events.closed.is_set.return_value = False
        self.window.native.webview.DefaultBackgroundColor = (249, 249, 247)
        self.core = self.window.native.webview.CoreWebView2
        self.core.Source = 'http://127.0.0.1:8766/read/p-1234'
        self.core.ExecuteScriptAsync.return_value = DotNetTask('true')
        self.core.PrintToPdfAsync.return_value = DotNetTask(True)
        self.window.native.BeginInvoke.side_effect = lambda callback: callback()
        modules = {
            'System': types.SimpleNamespace(Action=Delegate, Boolean=bool, String=str),
            'System.Drawing': types.SimpleNamespace(Color=types.SimpleNamespace(White=(255, 255, 255))),
            'System.Threading.Tasks': types.SimpleNamespace(
                Task=DotNetTask, TaskScheduler=types.SimpleNamespace(
                    FromCurrentSynchronizationContext=lambda: DotNetTask.scheduler)),
        }
        self.modules_patch = patch.dict('sys.modules', modules)
        self.modules_patch.start()
        self.addCleanup(self.modules_patch.stop)

    def job(self):
        return _WebView2PdfJob(self.window, self.path, str(self.core.Source))

    def test_real_api_is_ui_dispatched_and_completion_is_awaited(self):
        job = self.job()
        job.start()
        job.wait()
        self.window.native.BeginInvoke.assert_called_once()
        self.core.PrintToPdfAsync.assert_called_once_with(
            str(self.path), self.core.Environment.CreatePrintSettings.return_value)
        settings = self.core.Environment.CreatePrintSettings.return_value
        self.assertFalse(settings.ShouldPrintHeaderAndFooter)
        self.assertTrue(settings.ShouldPrintBackgrounds)
        self.assertAlmostEqual(settings.PageWidth, 210 / 25.4)
        self.assertAlmostEqual(settings.PageHeight, 297 / 25.4)

    def test_native_canvas_is_white_only_during_print_and_restored(self):
        observed = []
        def print_pdf(*_args):
            observed.append(self.window.native.webview.DefaultBackgroundColor)
            return DotNetTask(True)
        self.core.PrintToPdfAsync.side_effect = print_pdf
        job = self.job()
        job.start()
        job.wait()
        self.assertEqual(observed, [(255, 255, 255)])
        self.assertEqual(self.window.native.webview.DefaultBackgroundColor, (249, 249, 247))

    def test_native_canvas_is_restored_if_preparation_fails(self):
        self.core.ExecuteScriptAsync.side_effect = RuntimeError('script dispatch failed')
        job = self.job()
        job.start()
        with self.assertRaisesRegex(RuntimeError, 'script dispatch failed'):
            job.wait()
        self.assertEqual(self.window.native.webview.DefaultBackgroundColor, (249, 249, 247))

    def test_native_false_is_not_success(self):
        self.core.PrintToPdfAsync.return_value = DotNetTask(False)
        job = self.job()
        job.start()
        with self.assertRaisesRegex(RuntimeError, '未能生成'):
            job.wait()
        self.assertEqual(self.window.native.webview.DefaultBackgroundColor, (249, 249, 247))

    def test_rechecks_source_and_prepared_dom_on_native_thread(self):
        job = self.job()
        self.core.Source = 'https://example.com/'
        job.start()
        with self.assertRaisesRegex(RuntimeError, '已切换'):
            job.wait()
        self.core.PrintToPdfAsync.assert_not_called()
        job = self.job()
        self.core.ExecuteScriptAsync.return_value = DotNetTask('false')
        job.start()
        with self.assertRaisesRegex(RuntimeError, '尚未准备'):
            job.wait()
        self.core.PrintToPdfAsync.assert_not_called()

    def test_navigation_during_print_rejects_output(self):
        job = self.job()
        def print_pdf(*_args):
            job._navigation_handler(None, None)
            return DotNetTask(True)
        self.core.PrintToPdfAsync.side_effect = print_pdf
        job.start()
        with self.assertRaisesRegex(RuntimeError, '发生了切换'):
            job.wait()

    def test_timeout_does_not_publish_late_output(self):
        callbacks = []
        self.window.native.BeginInvoke.side_effect = callbacks.append
        job = self.job()
        job.start()
        with self.assertRaisesRegex(RuntimeError, '超时'):
            job.wait(timeout=0)
        self.assertTrue(job.abandoned)
        self.path.write_bytes(b'unfinished temporary file')
        callbacks[0]()
        self.assertTrue(job.done.is_set())
        self.assertFalse(self.path.exists())
        self.core.PrintToPdfAsync.assert_not_called()


class DialogTests(unittest.TestCase):
    def test_save_dialog_is_owned_pdf_only_and_confirms_overwrite(self):
        dialog = MagicMock()
        dialog.ShowDialog.return_value = 'ok'
        window = MagicMock()
        window.native.Invoke.side_effect = lambda callback: callback()
        modules = {
            'System': types.SimpleNamespace(Action=Delegate),
            'System.Windows.Forms': types.SimpleNamespace(
                DialogResult=types.SimpleNamespace(OK='ok'), SaveFileDialog=lambda: dialog),
        }
        with patch.dict('sys.modules', modules):
            self.assertEqual(_save_dialog(window, '译文.pdf'), '译文.pdf')
            self.assertTrue(dialog.OverwritePrompt)
            self.assertEqual(dialog.DefaultExt, 'pdf')
            self.assertTrue(dialog.AddExtension)
            self.assertTrue(dialog.CheckPathExists)
            dialog.ShowDialog.assert_called_once_with(window.native)
            dialog.Dispose.assert_called_once()
            dialog.ShowDialog.return_value = 'cancel'
            self.assertIsNone(_save_dialog(window, '译文.pdf'))
            dialog.ShowDialog.side_effect = RuntimeError('native dialog failed')
            with self.assertRaisesRegex(RuntimeError, 'native dialog failed'):
                _save_dialog(window, '译文.pdf')


if __name__ == '__main__':
    unittest.main()
