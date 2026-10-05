"""Trusted-reader PDF export through the Windows WebView2 printing API.

pywebview 6.2 runs exposed functions on background Python threads. All WebView2
calls below are posted to its WinForms UI thread; waiting never blocks that
thread. Keep this adapter small because pywebview's native backend can change.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from urllib.parse import urlsplit


_READY_SCRIPT = '''(() => {
    const root = document.querySelector('#translationPrint');
    return !!root && root.children.length > 0 &&
        document.body.classList.contains('translation-print-active');
})()'''


def pdf_filename(value: str) -> str:
    """A JS-supplied title is only a filename suggestion, never a destination."""
    if not isinstance(value, str):
        raise ValueError('PDF 文件名无效。')
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', '_', value).strip(' .')
    if name.lower().endswith('.pdf'):
        name = name[:-4].rstrip(' .')
    name = name[:120].rstrip(' .') or '论文译文'
    if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', name, re.I):
        name = '_' + name
    return name + '.pdf'


def trusted_reader_url(current: str, app_url: str) -> bool:
    """Only the application's exact loopback origin and reader route may print."""
    try:
        actual, expected = urlsplit(current), urlsplit(app_url)
        return bool(
            expected.scheme == actual.scheme == 'http'
            and expected.hostname == actual.hostname == '127.0.0.1'
            and expected.port and actual.port == expected.port
            and not actual.username and not actual.password
            and not expected.username and not expected.password
            and re.fullmatch(r'/read/[A-Za-z0-9_-]{4,64}', actual.path)
        )
    except (TypeError, ValueError):
        return False


def _save_dialog(window, filename: str) -> str | None:
    # Unlike pywebview.create_file_dialog, propagate dialog failures rather than
    # silently treating them as a deliberate Cancel. Invoke also guarantees STA.
    from System import Action
    from System.Windows.Forms import DialogResult, SaveFileDialog

    result, errors = [], []

    def show():
        dialog = SaveFileDialog()
        try:
            dialog.Title = '导出译文 PDF'
            dialog.Filter = 'PDF 文件 (*.pdf)|*.pdf'
            dialog.DefaultExt = 'pdf'
            dialog.AddExtension = True
            dialog.OverwritePrompt = True
            dialog.CheckPathExists = True
            dialog.RestoreDirectory = True
            dialog.FileName = filename
            selected = dialog.ShowDialog(window.native)
            result.append(str(dialog.FileName) if selected == DialogResult.OK else None)
        except Exception as exc:
            errors.append(exc)
        finally:
            dialog.Dispose()

    window.native.Invoke(Action(show))
    if errors:
        raise errors[0]
    return result[0]


class _WebView2PdfJob:
    """One asynchronous native print, including safe late-completion handling."""

    def __init__(self, window, path: Path, expected_url: str):
        self.window = window
        self.path = path
        self.expected_url = expected_url
        self.done = threading.Event()
        self.error = None
        self.abandoned = False
        self.navigated = False
        self._state_lock = threading.Lock()
        self._navigation_handler = None
        self._core = None
        self._previous_background = None

    def start(self):
        from System import Action, Boolean, String
        from System.Drawing import Color
        from System.Threading.Tasks import Task, TaskScheduler

        def finish(error=None):
            if self._previous_background is not None:
                try:
                    self.window.native.webview.DefaultBackgroundColor = self._previous_background
                except Exception:
                    pass  # Disposing the window may precede native completion.
                self._previous_background = None
            if self._navigation_handler is not None:
                try:
                    self._core.NavigationStarting -= self._navigation_handler
                except Exception:
                    pass  # Window disposal can precede a failed print callback.
                self._navigation_handler = None
            with self._state_lock:
                self.error = error
                if self.abandoned:
                    try:
                        self.path.unlink(missing_ok=True)
                    except OSError:
                        logging.warning('无法清理已中断的译文 PDF 临时文件', exc_info=True)
                self.done.set()

        def printed(task):
            try:
                if not task.Result:
                    raise RuntimeError('WebView2 未能生成 PDF，请稍后重试。')
                if self.navigated:
                    raise RuntimeError('导出时阅读页面发生了切换，请重新导出。')
                finish()
            except Exception as exc:
                finish(exc)

        def begin():
            try:
                if self.abandoned:
                    finish(RuntimeError('PDF 导出已中断。'))
                    return
                core = self.window.native.webview.CoreWebView2
                self._core = core
                if str(core.Source) != self.expected_url:
                    raise RuntimeError('阅读页面已切换，请重新导出。')
                scheduler = TaskScheduler.FromCurrentSynchronizationContext()
                # pywebview uses the reader's cream window color as WebView2's
                # native canvas color. PDF page margins can inherit that canvas
                # even when print CSS makes the document white.
                control = self.window.native.webview
                self._previous_background = control.DefaultBackgroundColor
                control.DefaultBackgroundColor = Color.White

                def navigation_started(_sender, _args):
                    self.navigated = True

                self._navigation_handler = navigation_started
                core.NavigationStarting += navigation_started

                def validated(task):
                    try:
                        if self.abandoned or self.navigated or str(core.Source) != self.expected_url:
                            raise RuntimeError('阅读页面已切换或导出已中断。')
                        if json.loads(str(task.Result)) is not True:
                            raise RuntimeError('译文打印内容尚未准备好，请重新导出。')
                        settings = core.Environment.CreatePrintSettings()
                        settings.ShouldPrintBackgrounds = True
                        settings.ShouldPrintHeaderAndFooter = False
                        settings.ScaleFactor = 1.0
                        # A4 in inches, with the same 15 mm margins as print CSS.
                        settings.PageWidth = 210 / 25.4
                        settings.PageHeight = 297 / 25.4
                        settings.MarginTop = settings.MarginBottom = 15 / 25.4
                        settings.MarginLeft = settings.MarginRight = 15 / 25.4
                        core.PrintToPdfAsync(str(self.path), settings).ContinueWith(
                            Action[Task[Boolean]](printed), scheduler)
                    except Exception as exc:
                        finish(exc)

                core.ExecuteScriptAsync(_READY_SCRIPT).ContinueWith(
                    Action[Task[String]](validated), scheduler)
            except Exception as exc:
                finish(exc)

        # BeginInvoke returns immediately. Task.Result is read only by completion
        # continuations above, never while an unfinished Task owns the UI thread.
        self.window.native.BeginInvoke(Action(begin))

    def wait(self, timeout=120):
        deadline = time.monotonic() + timeout
        while not self.done.wait(.1):
            if self.window.events.closed.is_set() or time.monotonic() >= deadline:
                with self._state_lock:
                    if self.done.is_set():
                        break
                    self.abandoned = True
                raise RuntimeError('PDF 导出已中断或超时；未保存目标文件，请重试。')
        if self.error:
            raise self.error


class TranslationPdfExporter:
    """The only exposed method takes a title; the native chooser owns the path."""

    def __init__(self, app_url: str, library_root: Path | None = None):
        self._app_url = app_url
        self._library_root = Path(library_root).resolve() if library_root is not None else None
        self._window = None
        self._lock = threading.Lock()
        self._pending = None

    def _bind_window(self, window):
        self._window = window

    def _choose_destination(self, filename):
        return _save_dialog(self._window, filename)

    def export_translation_pdf(self, filename):
        if not self._lock.acquire(blocking=False):
            return {'status': 'error', 'error': '已有 PDF 正在导出，请稍后再试。'}
        temporary = None
        try:
            if self._pending is not None and not self._pending.done.is_set():
                raise RuntimeError('上一次 PDF 导出仍在结束中，请稍后再试。')
            window = self._window
            if window is None or getattr(window.gui, 'renderer', '') != 'edgechromium':
                raise RuntimeError('译文 PDF 导出需要 Microsoft Edge WebView2 桌面窗口。')
            expected_url = window.get_current_url() or ''
            if not trusted_reader_url(expected_url, self._app_url):
                raise RuntimeError('请在 Folio Read 的论文阅读页面导出译文。')
            if window.evaluate_js(_READY_SCRIPT) is not True:
                raise RuntimeError('译文打印内容尚未准备好，请重新导出。')
            selected = self._choose_destination(pdf_filename(filename))
            if not selected:
                return {'status': 'cancelled'}
            target = Path(selected)
            if not target.is_absolute() or target.suffix.lower() != '.pdf':
                raise ValueError('请选择扩展名为 .pdf 的完整保存路径。')
            resolved = target.resolve()
            if (self._library_root is not None and resolved.name.casefold() == 'source.pdf'
                    and resolved.parent.parent == self._library_root
                    and re.fullmatch(r'[A-Za-z0-9_-]{4,64}', resolved.parent.name)):
                raise ValueError('不能覆盖文献库中的原始 PDF，请选择其他文件名或保存位置。')
            if window.get_current_url() != expected_url:
                raise RuntimeError('阅读页面已切换，请重新导出。')
            # Native printing overwrites its output. Print to a unique sibling
            # first so an error cannot truncate an existing user-selected PDF.
            fd, name = tempfile.mkstemp(prefix='.folio-translation-', suffix='.pdf', dir=target.parent)
            os.close(fd)
            temporary = Path(name)
            job = self._pending = _WebView2PdfJob(window, temporary, expected_url)
            try:
                job.start()
            except Exception:
                job.done.set()
                raise
            job.wait()
            with temporary.open('rb') as output:
                if output.read(5) != b'%PDF-' or temporary.stat().st_size < 100:
                    raise RuntimeError('生成的文件不是有效 PDF，请重新导出。')
            os.replace(temporary, target)
            return {'status': 'saved', 'path': str(target)}
        except Exception as exc:
            logging.exception('译文 PDF 导出失败')
            return {'status': 'error', 'error': str(exc) or '译文 PDF 导出失败，请重试。'}
        finally:
            # An abandoned native task may still be writing. Its completion
            # callback removes the temporary file; no late result is published.
            if temporary is not None and (self._pending is None or self._pending.done.is_set()):
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    logging.warning('无法清理译文 PDF 临时文件', exc_info=True)
            self._lock.release()
