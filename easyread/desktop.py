"""Windows application: an independent window with persistent external data."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import io
import json
import logging
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import unquote, urlparse


def data_home(app_dir: Path, override: str | None = None) -> Path:
    if override or os.environ.get('EASYREAD_HOME'):
        return Path(override or os.environ['EASYREAD_HOME']).expanduser().resolve()
    # A delivered EXE beside the existing local project must use its real data.
    for candidate in (app_dir, app_dir / 'folio-read', app_dir / 'FolioRead',
                      app_dir / 'folio-personal', app_dir / 'easyread-personal'):
        if (candidate / 'library').is_dir() and (candidate / 'pyproject.toml').is_file():
            return candidate.resolve()
    for name in ('EasyRead数据', 'Folio数据', 'FolioRead数据'):
        candidate = app_dir / name
        if candidate.is_dir():
            return candidate.resolve()
    return (app_dir / 'FolioRead数据').resolve()


def prepare_home(app_dir: Path, override: str | None = None) -> Path:
    home = data_home(app_dir, override)
    try:
        home.mkdir(parents=True, exist_ok=True)
        probe = home / ('.desktop-write-check-' + str(os.getpid()))
        with probe.open('xb'):
            pass
        probe.unlink()
    except PermissionError:
        # Installed in a protected directory: only a NEW library may fall back.
        if override or os.environ.get('EASYREAD_HOME') or (home / 'library').exists():
            raise PermissionError(f'数据目录不可写：{home}。请把程序放到可写的目录。')
        user_local = Path(os.environ.get('LOCALAPPDATA', app_dir))
        home = next((user_local / name for name in ('EasyRead', 'Folio', 'FolioRead')
                     if (user_local / name / 'library').is_dir()), user_local / 'FolioRead')
        home.mkdir(parents=True, exist_ok=True)
    os.environ['EASYREAD_HOME'] = str(home)
    os.chdir(home)
    return home


def existing_server(home: Path) -> str | None:
    try:
        info = json.loads((home / '.server.json').read_text(encoding='utf-8'))
        url = info.get('url', '')
        parsed = urlparse(url)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port:
            return None
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            return None
        with urllib.request.urlopen(url + '/api/library', timeout=1.5) as response:
            data = json.loads(response.read())
        if isinstance(data.get('items'), list) and data.get('version') and isinstance(data.get('token'), str):
            return url
    except (OSError, ValueError, KeyError):
        pass
    return None


def acquire_mutex(home: Path):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    name = instance_name(home)
    handle = kernel.CreateMutexW(None, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    return kernel, handle, ctypes.get_last_error() == 183


def instance_name(home: Path) -> str:
    return 'Local\\EasyReadDesktop-' + hashlib.sha256(str(home).casefold().encode()).hexdigest()[:24]


def activation_event(kernel, home: Path):
    kernel.CreateEventW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateEventW.restype = ctypes.c_void_p
    kernel.SetEvent.argtypes = [ctypes.c_void_p]
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    handle = kernel.CreateEventW(None, False, False, instance_name(home) + '-Activate')
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    return handle


def error_dialog(message: str):
    ctypes.windll.user32.MessageBoxW(None, message, 'Folio Read', 0x10)


def app_icon():
    from PIL import Image, ImageDraw
    image = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((4, 4, 124, 124), radius=27, fill='#cc7d5e')
    draw.polygon([(27, 29), (57, 35), (57, 101), (27, 93)], fill='#f9f9f7')
    draw.polygon([(64, 35), (101, 29), (101, 93), (64, 101)], fill='#f4f4f2')
    draw.line([(61, 35), (61, 102)], fill='#b5917f', width=4)
    for y in (46, 59, 72):
        draw.line([(33, y), (50, y + 3)], fill='#b5917f', width=3)
        draw.line([(72, y + 3), (93, y)], fill='#b5917f', width=3)
    return image


def create_window(home: Path, url: str, title: str = 'Folio Read · 阅读'):
    import webview

    webview.settings['ALLOW_DOWNLOADS'] = True
    window = webview.create_window(title, url, width=1280, height=880,
                                  min_size=(760, 560), background_color='#f9f9f7')
    # Keep local PDFs in this window; deliberate external links use the browser.
    def local_links():
        if urlparse(window.get_current_url() or '').netloc != urlparse(url).netloc:
            return
        window.evaluate_js('''(() => {
          if (window.__easyreadDesktop) return;
          window.__easyreadDesktop = true;
          const local = href => {
            try { return new URL(href, location.href).origin === location.origin; }
            catch (_) { return false; }
          };
          document.addEventListener('click', event => {
            const link = event.target.closest && event.target.closest('a[target="_blank"]');
            if (link && local(link.href) && !link.download) link.target = '_self';
          }, true);
          const open = window.open.bind(window);
          window.open = (href, ...args) => {
            if (href && local(href)) { location.assign(href); return null; }
            return open(href, ...args);
          };
        })()''')
    window.events.loaded += local_links
    return window


def start_window(home: Path, window, callback=None):
    import webview
    from webview.menu import Menu, MenuAction, MenuSeparator
    from webview.platforms import winforms

    if not winforms.is_chromium:
        raise RuntimeError('独立窗口需要 Microsoft Edge WebView2 Runtime。请安装微软官方 WebView2 Runtime 后重试。')
    icon = home / '.desktop-icon.ico'
    app_icon().save(icon, sizes=[(16, 16), (32, 32), (48, 48), (128, 128)])
    from .institutional_browser import InstitutionalBrowser
    institutional = InstitutionalBrowser(home, window, window.original_url.split("/read/")[0])
    # Keep the session reachable and close its owned native form with the app.
    window._institutional_browser = institutional
    def close_institutional():
        if institutional.form is not None and not institutional.form.IsDisposed:
            institutional._ui(lambda: institutional.form.Close())
    window.events.closing += close_institutional
    root = window.original_url.split('/read/')[0]
    menus = [Menu('文件', [
        MenuAction('回到文献库', lambda: window.load_url(root)),
        MenuAction('打开数据文件夹', lambda: os.startfile(home)),
        MenuAction('机构访问并导入 PDF（临时会话）', institutional.open),
        MenuSeparator(), MenuAction('退出 Folio Read', window.destroy),
    ]), Menu('阅读', [
        MenuAction('返回', lambda: window.evaluate_js('history.back()')),
        MenuAction('前进', lambda: window.evaluate_js('history.forward()')),
        MenuAction('刷新', lambda: window.evaluate_js('location.reload()')),
    ])]
    webview.start(callback, gui='edgechromium', private_mode=False,
                  storage_path=str(home / 'desktop-cache'), icon=str(icon), menu=menus,
                  localization={'global.quitConfirmation': '退出 Folio Read？',
                                'global.ok': '确定', 'global.cancel': '取消',
                                'windows.fileFilter.allFiles': '所有文件'})


def check_reading_tools(window, home: Path, paper_id: str, checks: dict, wait_for_ui):
    """Use an isolated article to verify selection, annotations and the OS clipboard."""
    window.evaluate_js('''(() => {
        window.__readingTestSelect = (start, end = start) => {
            const a = document.querySelector(start), b = document.querySelector(end);
            const r = document.createRange(); r.setStart(a, 0); r.setEnd(b, b.childNodes.length);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
            return s.toString();
        };
        window.__readingTestKey = (key, modifiers = {}, target = document.body) => {
            const e = new KeyboardEvent('keydown', Object.assign({key, bubbles:true, cancelable:true}, modifiers));
            target.dispatchEvent(e); return e.defaultPrevented;
        };
    })()''')
    checks['visible_reading_toolbar'] = window.evaluate_js('''
        document.querySelectorAll('#readingTools [data-read-tool]').length === 7 &&
        document.querySelectorAll('#readingTools [data-read-color]').length === 4 &&
        getComputedStyle(document.querySelector('#b-p1-link .zh')).userSelect === 'text'
    ''')
    checks['ctrl_f_opens_page_search'] = window.evaluate_js('''
        __readingTestKey('f', {ctrlKey:true}) && !document.querySelector('#pageFind').hidden &&
        document.activeElement.getAttribute('aria-label') === '查找文字'
    ''')
    window.evaluate_js('''(() => {
        const input = document.querySelector('#pageFind input'); input.value = '资料';
        input.dispatchEvent(new Event('input', {bubbles:true}));
    })()''')
    checks['page_search_counts_and_marks'] = wait_for_ui("document.querySelector('#pageFind output').textContent === '1 / 2' && CSS.highlights.get('folio-find').size === 2")
    checks['page_search_next_and_previous'] = window.evaluate_js('''(() => {
        const input = document.querySelector('#pageFind input');
        __readingTestKey('Enter', {}, input);
        const next = document.querySelector('#pageFind output').textContent === '2 / 2';
        __readingTestKey('Enter', {shiftKey:true}, input);
        return next && document.querySelector('#pageFind output').textContent === '1 / 2';
    })()''')
    window.evaluate_js('''(() => {
        const input = document.querySelector('#pageFind input'); input.value = '[not found]';
        input.dispatchEvent(new Event('input', {bubbles:true}));
    })()''')
    checks['page_search_literal_and_empty_results'] = wait_for_ui("document.querySelector('#pageFind output').textContent === '0 / 0' && document.querySelector('[data-find=next]').disabled")
    checks['escape_closes_page_search'] = window.evaluate_js('''
        __readingTestKey('Escape', {}, document.querySelector('#pageFind input')) &&
        document.querySelector('#pageFind').hidden && !CSS.highlights.has('folio-find')
    ''')
    checks['double_click_does_not_edit_translation'] = window.evaluate_js('''(() => {
        document.querySelector('#b-p1-link .zh').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
        return !PR.editingKey && !document.querySelector('#paper .editor-wrap');
    })()''')
    checks['cross_paragraph_highlight_preserves_links'] = window.evaluate_js('''(() => {
        __readingTestSelect('#b-p1-link .zh', '#b-p1-url .zh');
        document.querySelector('[data-read-tool=marker]').click();
        const n = PR.myNotes().at(-1); window.__readingTestCross = n.id;
        return n.segments.length === 2 && n.segments[0].quote === '查看补充材料' &&
            !!document.querySelector('#b-p1-link .zh mark.hl') && !!document.querySelector('#b-p1-url .zh mark.hl') &&
            document.querySelector('#b-p1-link .zh a').href === 'https://example.org/supplement';
    })()''')
    checks['english_underline_shortcut'] = window.evaluate_js('''(() => {
        PR.setPref('mode', 'bi', true); __readingTestSelect('#b-p1-link .en');
        __readingTestKey('u', {ctrlKey:true, shiftKey:true});
        const n = PR.myNotes().at(-1);
        return n.lang === 'en' && n.quote === 'View supplementary material' &&
            n.style === 'underline' && !!document.querySelector('#b-p1-link .en mark.s-ul');
    })()''')
    checks['ctrl_z_undoes_only_new_annotation'] = window.evaluate_js('''
        __readingTestKey('z', {ctrlKey:true}) && !document.querySelector('#b-p1-link .en mark.hl') &&
        !!document.querySelector('#b-p1-link .zh mark.hl') && PR.myNotes().length === 1
    ''')
    checks['note_shortcut_preserves_selection'] = window.evaluate_js('''(() => {
        __readingTestSelect('#b-p1-url .zh'); __readingTestKey('n', {ctrlKey:true, shiftKey:true});
        const n = PR.myNotes().at(-1), ta = document.querySelector('#notespanel .card textarea');
        window.__readingTestNote = n.id;
        if (ta) { ta.value = '阅读工具持久化验证'; ta.dispatchEvent(new Event('input', {bubbles:true}));
            __readingTestKey('Enter', {ctrlKey:true}, ta); }
        return n.segments.length === 1 && n.anchor === 'p1-url' && !!ta;
    })()''')
    checks['annotation_saved_to_disk'] = wait_for_ui("PR.store.status === 'saved' && !PR.store.pending")
    reader = json.loads((home / 'library' / paper_id / 'reader.json').read_text(encoding='utf-8'))
    checks['cross_paragraph_segments_persisted'] = any(len(n.get('segments', [])) == 2 and not n.get('deleted') for n in reader['notes'].values())
    checks['note_body_persisted'] = any(n.get('body') == '阅读工具持久化验证' for n in reader['notes'].values())
    window.evaluate_js('''(() => {
        PR.toggleNotesPanel(false); __readingTestSelect('#b-p1-link .zh');
    })()''')
    # Keep every original clipboard format in memory, never in a log or report.
    from System import Action
    from System.Windows.Forms import Clipboard, DataObject, TextBox
    saved = []
    def snapshot_clipboard():
        original = Clipboard.GetDataObject()
        if original is None:
            saved.append(None)
            return
        clone = DataObject()
        for name in original.GetFormats(False):
            clone.SetData(name, False, original.GetData(name, False))
        saved.append(clone)
    window.native.Invoke(Action(snapshot_clipboard))
    try:
        checks['ctrl_c_remains_native'] = window.evaluate_js("!__readingTestKey('c', {ctrlKey:true}) && getSelection().toString() === '查看补充材料'")
        window.evaluate_js("PR.copyText(getSelection().toString()).then(ok => { document.body.dataset.clipboardCheck = String(ok); })")
        checks['copy_action_completes'] = wait_for_ui("document.body.dataset.clipboardCheck === 'true'")
        pasted = []
        def paste_in_windows_textbox():
            textbox = TextBox()
            try:
                textbox.CreateControl()
                textbox.Paste()
                pasted.append(textbox.Text == '查看补充材料')
            finally:
                textbox.Dispose()
        window.native.Invoke(Action(paste_in_windows_textbox))
        checks['copy_pastes_into_windows_textbox'] = bool(pasted and pasted[0])
    finally:
        def restore_clipboard():
            if saved[0] is None:
                Clipboard.Clear()
            else:
                Clipboard.SetDataObject(saved[0], True)
        window.native.Invoke(Action(restore_clipboard))
    checks['visible_shortcut_guide'] = window.evaluate_js('''(() => {
        document.querySelector('[data-read-tool=shortcuts]').click();
        const dlg = document.querySelector('.reading-shortcuts');
        const opened = dlg.open && dlg.textContent.includes('Ctrl+F'); dlg.close(); return opened;
    })()''')
    window.load_url(window.original_url)
    checks['annotations_restored_after_reopen'] = wait_for_ui('''
        !!document.querySelector('#b-p1-link .zh mark.hl') && !!document.querySelector('#b-p1-url .zh mark.hl') &&
        PR.myNotes().some(n => n.body === '阅读工具持久化验证')
    ''', 15)
    window.resize(780, 600)
    checks['toolbar_accessible_in_small_window'] = wait_for_ui("document.querySelector('#readingTools').clientWidth <= innerWidth && document.querySelector('#readingTools [data-read-tool=shortcuts]').getBoundingClientRect().width > 0")
    window.resize(1280, 880)


def check_pdf_naming(window, url: str, paper_id: str, checks: dict, wait_for_ui):
    """Exercise the reviewed local naming flow in the real packaged WebView."""
    window.load_url(url + '/')
    deadline = time.monotonic() + 15
    ready = False
    while time.monotonic() < deadline:
        try:
            ready = window.evaluate_js("location.pathname === '/' && !!window.PR?.lib?.openNaming && PR.lib.items.length > 0")
        except Exception:
            ready = False
        if ready:
            break
        time.sleep(.1)
    checks['naming_library_ready'] = bool(ready)
    if not ready:
        return
    pid = json.dumps(paper_id)
    reviewed = json.dumps('地理信息与生态环境：中文文件名验证', ensure_ascii=True)
    window.evaluate_js('PR.lib.openNaming([' + pid + '])')
    checks['naming_local_preview_visible'] = wait_for_ui("!!document.querySelector('#namingDlg.open [data-naming-title]')")
    checks['naming_original_filename_visible'] = window.evaluate_js("document.querySelector('#namingDlg').textContent.includes('1-s2.0-standalone-test.pdf')")
    checks['naming_preview_does_not_apply'] = window.evaluate_js('!PR.lib.byId(' + pid + ').naming?.title')
    window.evaluate_js('''(() => {
        const input = document.querySelector('[data-naming-title]');
        input.value = ''' + reviewed + ''';
        input.dispatchEvent(new Event('input', {bubbles:true}));
        document.querySelector('#namingSave').click();
    })()''')
    checks['naming_reviewed_name_applied'] = wait_for_ui('!document.querySelector("#namingDlg.open") && PR.lib.byId(' + pid + ').display_title === ' + reviewed)
    checks['naming_display_name_visible'] = window.evaluate_js('document.querySelector("#list").textContent.includes(' + reviewed + ')')
    window.evaluate_js('PR.lib.openNaming([' + pid + '])')
    checks['naming_reopen_preserves_title'] = wait_for_ui('document.querySelector("#namingDlg.open [data-naming-title]")?.value === ' + reviewed)
    window.evaluate_js('''(() => {
        const input = document.querySelector('[data-naming-title]');
        input.value = 'Cancelled name must not persist';
        input.dispatchEvent(new Event('input', {bubbles:true}));
        document.querySelector('[data-naming-close]').click();
    })()''')
    checks['naming_cancel_preserves_reviewed_title'] = wait_for_ui('!document.querySelector("#namingDlg.open") && PR.lib.byId(' + pid + ').display_title === ' + reviewed)
    window.load_url(url + '/read/' + paper_id)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if window.evaluate_js('document.querySelector(".bar-title")?.textContent === ' + reviewed):
                break
        except Exception:
            pass
        time.sleep(.1)
    checks['naming_reader_bar_uses_reviewed_title'] = window.evaluate_js('document.querySelector(".bar-title")?.textContent === ' + reviewed)
    checks['naming_reader_retains_original_details'] = window.evaluate_js('document.querySelector(".paper-head h1")?.textContent === ' + reviewed + ' && document.querySelector(".paper-information").textContent.includes("1-s2.0-standalone-test")')


def check_window(home: Path, url: str, paper_id: str, checks: dict):
    """Exercise the actual WebView2 window in source and frozen builds."""
    window = create_window(home, url + '/read/' + paper_id, 'Folio Read · 桌面验证')
    finished = threading.Event()
    def wait_for_ui(expression, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if window.evaluate_js(expression):
                return True
            time.sleep(.05)
        return False
    def verify():
        try:
            if not window.events.loaded.wait(25):
                raise RuntimeError('独立窗口未能在 25 秒内加载')
            checks['native_window'] = window.native is not None
            checks['webview2_renderer'] = window.gui.renderer == 'edgechromium'
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                state = window.evaluate_js('''JSON.stringify({
                  nav: !!document.querySelector('#workspaceNav a'),
                  reader: document.body.classList.contains('reader-page'),
                  companion: document.body.innerText.includes('陪读'),
                  figure: !!document.querySelector('.figure-image img') && document.querySelector('.figure-image img').complete && document.querySelector('.figure-image img').naturalWidth > 0,
                  width: innerWidth,
                  localLinks: !!window.__easyreadDesktop
                })''')
                state = json.loads(state)
                if state['nav'] and state['reader'] and state['companion'] and state['localLinks'] and state['figure']:
                    break
                time.sleep(.1)
            checks['reader_in_native_window'] = all(state[key] for key in ('nav', 'reader', 'companion', 'localLinks')) and state['width'] >= 600
            checks['inline_figure_in_native_window'] = state['figure']
            checks['folio_brand_in_native_window'] = window.evaluate_js(
                "document.querySelector('#workspaceNav .workspace-brand').textContent === 'Folio Read'")
            checks['reading_first_navigation'] = window.evaluate_js(
                "Array.from(document.querySelectorAll('#workspaceNav nav a')).map(a => a.textContent).join('|') === '阅读|文献库|知识问答|研究主题'")
            checks['compact_paper_information'] = window.evaluate_js(
                "!!document.querySelector('.paper-meta-line') && !document.querySelector('.paper-information').open")
            checks['phone_original_readable_without_translation'] = window.evaluate_js('''(() => {
                const original=document.querySelector('#b-phone-original .en.original-primary');
                return original && getComputedStyle(original).display==='block' && original.textContent==='Original PDF text imported on a phone.';
            })()''')
            checks['translated_source_link_in_native_window'] = window.evaluate_js('''(() => {
                const link = document.querySelector('#b-p1-link .zh a');
                return !!link && link.textContent === '查看补充材料' &&
                    link.href === 'https://example.org/supplement' && link.target === '_blank';
            })()''')
            checks['plain_url_in_native_window'] = window.evaluate_js('''(() => {
                const link = document.querySelector('#b-p1-url .zh a');
                return !!link && link.href === 'https://example.org/data?a=1&b=2';
            })()''')
            checks['figure_zoom_in_native_window'] = window.evaluate_js('''(() => {
                document.querySelector('.figure-image').click();
                const dlg = document.querySelector('#figureDlg');
                const open = !!dlg && dlg.open && !!dlg.querySelector('.figure-dialog-image');
                if (open) dlg.querySelector('[data-fig-dialog="close"]').click();
                return open;
            })()''')
            checks['gui_persistent_profile'] = (home / 'desktop-cache').is_dir()
            checks['gui_exports_enabled'] = __import__('webview').settings['ALLOW_DOWNLOADS']
            # Windows DPI scaling can make a 1280px native window narrower than
            # the docked-layout breakpoint in CSS pixels.
            window.resize(1600, 1000)
            checks['outline_wide_viewport'] = wait_for_ui('innerWidth >= 1100', 5)
            checks['outline_deduplicates_page_headings'] = window.evaluate_js('''(() => {
                document.querySelector('[data-act=drawer]').click();
                return document.querySelectorAll('#drawer [data-go]').length === 3 &&
                    document.querySelectorAll('#drawer [data-go="outline-method"]').length === 1 &&
                    !document.querySelector('#drawer [data-go="outline-repeat"]');
            })()''')
            checks['outline_docked_without_covering_text'] = wait_for_ui('''(() => {
                const drawer = document.querySelector('#drawer').getBoundingClientRect();
                const paper = document.querySelector('#paper').getBoundingClientRect();
                return paper.left >= drawer.right && getComputedStyle(document.querySelector('#scrim')).pointerEvents === 'none';
            })()''')
            checks['outline_three_level_fold'] = window.evaluate_js('''(() => {
                const child = document.querySelector('#drawer [data-go="outline-third"]');
                const indent = parseFloat(getComputedStyle(child.parentElement).paddingLeft);
                document.querySelector('#drawer [data-fold="outline-method"]').click();
                return indent >= 28 && document.querySelector('#drawer [data-fold="outline-method"]').getAttribute('aria-expanded') === 'false' &&
                    document.querySelector('#drawer [data-outline-id="outline-method"] > ul').hidden;
            })()''')
            checks['outline_close_accessible'] = window.evaluate_js('''(() => {
                document.querySelector('[data-drawer-close]').click();
                return !document.body.classList.contains('drawer-open') && document.querySelector('#drawer').inert &&
                    document.querySelector('[data-act=drawer]').getAttribute('aria-expanded') === 'false';
            })()''')
            check_reading_tools(window, home, paper_id, checks, wait_for_ui)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                ready = window.evaluate_js("!!document.querySelector('#questionScope option[value=library]') && !document.querySelector('#questionScopeControls').hidden")
                if ready:
                    break
                window.evaluate_js("document.querySelector('#studyBtn').click()")
                time.sleep(.2)
            checks['library_scope_in_reader'] = bool(ready)
            if ready:
                checks['question_before_records_and_collection'] = window.evaluate_js('''(() => {
                    const form = document.querySelector('#analysisForm');
                    return !!document.querySelector('.reader-study-toolbar .analysis-options') &&
                        !!(form.compareDocumentPosition(document.querySelector('.history-disclosure')) & Node.DOCUMENT_POSITION_FOLLOWING) &&
                        !!(form.compareDocumentPosition(document.querySelector('.reader-collection')) & Node.DOCUMENT_POSITION_FOLLOWING);
                })()''')
                checks['switch_to_library_scope'] = window.evaluate_js('''(() => {
                    const scope = document.querySelector('#questionScope');
                    scope.value = 'library'; scope.dispatchEvent(new Event('change', {bubbles:true}));
                    return document.querySelector('#modeTitle').textContent === '问资料库' && !document.querySelector('#knowledgeControls').hidden;
                })()''')
            window.load_url(url + '/study?mode=knowledge')
            deadline = time.monotonic() + 15
            knowledge_ready = False
            while time.monotonic() < deadline:
                try:
                    knowledge_ready = window.evaluate_js("document.title.includes('知识问答') && document.querySelector('#modeTitle').textContent === '问资料库' && !document.querySelector('#knowledgeControls').hidden")
                except Exception:
                    knowledge_ready = False
                if knowledge_ready:
                    break
                time.sleep(.2)
            checks['knowledge_page_in_native_window'] = bool(knowledge_ready)
            if knowledge_ready:
                checks['model_gear_aligned_with_heading'] = window.evaluate_js('''(() => {
                    const heading = document.querySelector('.workspace-heading').getBoundingClientRect();
                    const title = document.querySelector('.workspace-heading h1').getBoundingClientRect();
                    const gear = document.querySelector('.workspace-heading .analysis-options summary').getBoundingClientRect();
                    return gear.width > 0 && gear.right >= heading.right - 10 && gear.top < title.bottom;
                })()''')
                checks['distinct_study_navigation'] = window.evaluate_js('''(() => {
                    return document.querySelectorAll('.study-tabs button').length === 2 &&
                        !document.querySelector('#knowledgeControls').open &&
                        !!document.querySelector('.study-sidebar #studyHistory');
                })()''')
                window.load_url(url + '/study?mode=knowledge&run=run-f000000000000001')
                deadline = time.monotonic() + 15
                answer_ready = False
                while time.monotonic() < deadline:
                    try:
                        answer_ready = window.evaluate_js("!!document.querySelector('.answer-heading h2') && !!document.querySelector('.evidence-group')")
                    except Exception:
                        answer_ready = False
                    if answer_ready:
                        break
                    time.sleep(.2)
                checks['saved_answer_restored_in_gui'] = bool(answer_ready)
                if answer_ready:
                    window.evaluate_js("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'f',ctrlKey:true,bubbles:true,cancelable:true})); const q = document.querySelector('#pageFind input'); q.value = '隔离数据'; q.dispatchEvent(new Event('input',{bubbles:true}));")
                    checks['ctrl_f_searches_saved_knowledge_answer'] = wait_for_ui("document.querySelector('#pageFind output').textContent === '1 / 1'")
                    window.evaluate_js('PR.closeFind()')
                    window.evaluate_js("document.querySelector('[data-focus-followup]').click()")
                    checks['followup_shortcut_focuses_composer'] = wait_for_ui("document.activeElement.id === 'followupQuestion'")
                    checks['question_visible_and_evidence_collapsed'] = window.evaluate_js('''(() => {
                        const question = document.querySelector('.answer-heading h2');
                        const evidence = document.querySelector('.evidence-group');
                        return question.textContent === '独立窗口界面验证问题' &&
                            question.getBoundingClientRect().height > 0 && !evidence.open &&
                            getComputedStyle(document.querySelector('#analysisForm')).display === 'none';
                    })()''')
                    checks['evidence_expands_with_source_link'] = window.evaluate_js('''(() => {
                        const evidence = document.querySelector('.evidence-group');
                        evidence.querySelector('summary').click();
                        return evidence.open && evidence.querySelector('a').getAttribute('href').startsWith('/read/');
                    })()''')
                    theme_check = '''(() => {
                        PR.applyTheme(THEME);
                        const answer = getComputedStyle(document.querySelector('.answer-document'));
                        const evidence = getComputedStyle(document.querySelector('.evidence-group summary'));
                        const luminance = color => {
                            const rgb = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => {
                                v /= 255;
                                return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
                            });
                            return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
                        };
                        const contrast = (a, b) => {
                            const values = [luminance(a), luminance(b)].sort((a, b) => a - b);
                            return (values[1] + .05) / (values[0] + .05);
                        };
                        const expected = THEME === 'dark' ? 'rgb(45, 45, 43)' : 'rgb(249, 249, 247)';
                        return answer.backgroundColor === expected &&
                            contrast(answer.color, answer.backgroundColor) >= 4.5 &&
                            contrast(evidence.color, answer.backgroundColor) >= 4.5 &&
                            contrast(evidence.color, getComputedStyle(document.body).backgroundColor) >= 4.5;
                    })()'''
                    for theme in ('light', 'dark'):
                        checks[theme + '_theme_keeps_answer_readable'] = window.evaluate_js(
                            theme_check.replace('THEME', json.dumps(theme)))
                    window.evaluate_js("PR.applyTheme('light')")
                    window.evaluate_js("document.querySelector('[data-follow]').click()")
                    checks['followup_suggestion_fills_composer'] = wait_for_ui(
                        "document.querySelector('#followupQuestion').value === '继续核对这条资料'")
                    window.evaluate_js("document.querySelector('[data-edit-run]').click()")
                    checks['edit_question_reopens_form'] = wait_for_ui('''
                        getComputedStyle(document.querySelector('#analysisForm')).display !== 'none' &&
                        document.querySelector('#studyQuestion').value === '独立窗口界面验证问题'
                    ''')
                    window.evaluate_js("document.querySelector('#newStudy').click()")
                    checks['new_question_clears_result_and_keeps_history'] = wait_for_ui('''
                        document.querySelector('#studyQuestion').value === '' &&
                        document.querySelector('#studyResult').textContent === '' &&
                        !!document.querySelector('#studyHistory [data-history="run-f000000000000001"]')
                    ''')
                window.load_url(url + '/study?mode=research')
                deadline = time.monotonic() + 15
                research_ready = False
                while time.monotonic() < deadline:
                    try:
                        research_ready = window.evaluate_js("!!document.querySelector('.research-mode') && !!document.querySelector('.research-empty')")
                    except Exception:
                        research_ready = False
                    if research_ready:
                        break
                    time.sleep(.2)
                checks['empty_research_has_creation_entry'] = bool(research_ready)
                if research_ready:
                    checks['new_topic_can_be_cancelled'] = window.evaluate_js('''(() => {
                        document.querySelector('[data-new-topic]').click();
                        const opened = getComputedStyle(document.querySelector('.knowledge-collection')).display !== 'none';
                        document.querySelector('#cancelTopic').click();
                        return opened && getComputedStyle(document.querySelector('.knowledge-collection')).display === 'none' &&
                            document.querySelector('#researchRecords').textContent.includes('建立自己的研究主题');
                    })()''')
            check_pdf_naming(window, url, paper_id, checks, wait_for_ui)
        except Exception as exc:
            checks['native_window_test'] = False
            logging.exception('独立窗口验证失败：%s', exc)
        finally:
            window.destroy()
            finished.set()
    start_window(home, window, verify)
    checks['window_closed'] = finished.wait(5) and window.events.closed.is_set()


def start_server():
    import socket
    from http.server import ThreadingHTTPServer
    from . import __version__, config, detect
    from .log import setup as setup_log, log
    from .server import App, Handler
    from .store import now_iso, write_json_atomic

    setup_log(config.LOG_PATH)
    cfg = config.load()
    app = App(cfg)
    handler = type('DesktopHandler', (Handler,), {'app': app})
    class DesktopHTTPServer(ThreadingHTTPServer):
        allow_reuse_address = False

        def server_bind(self):
            if os.name == 'nt':
                # On Windows SO_REUSEADDR permits two apps to bind one port,
                # which can route a request to the wrong library.
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    try:
        httpd = DesktopHTTPServer(('127.0.0.1', cfg['port']), handler)
    except OSError:
        httpd = DesktopHTTPServer(('127.0.0.1', 0), handler)
    url = f'http://127.0.0.1:{httpd.server_address[1]}'
    write_json_atomic(config.SERVER_INFO, {'url': url, 'pid': os.getpid(), 'started': now_iso()})
    detect.warm(cfg)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True, name='EasyReadServer')
    thread.start()
    log.info('Folio Read %s 桌面版启动：%s  文献库：%s', __version__, url, app.lib.root)
    return httpd, app, url


def stop_server(httpd, app):
    from . import config, study
    from .store import now_iso, read_json, write_json_atomic

    with app.jobs.lock:
        jobs = list(app.jobs.cancels)
    for pid in jobs:
        app.jobs.cancel(pid)
    with app.study.lock:
        runs = list(app.study.events)
        for event in app.study.events.values():
            event.set()
    # Persist interruption before exiting, including requests still waiting on an API.
    for rid in runs:
        path = study.run_dir() / (rid + '.json')
        record = read_json(path, {}) or {}
        if record.get('state') in ('queued', 'running'):
            record.update(state='cancelled', message='程序已退出；已保存的内容保留。', finished=now_iso())
            write_json_atomic(path, record)
    app.study.pool.shutdown(wait=False, cancel_futures=True)
    httpd.shutdown()
    httpd.server_close()
    info = read_json(config.SERVER_INFO, {}) or {}
    if info.get('pid') == os.getpid():
        config.SERVER_INFO.unlink(missing_ok=True)


def smoke_test(report: Path):
    """Run inside the frozen executable without installing Python or calling an AI."""
    from pypdf import PdfWriter
    from pypdf.annotations import Link
    from pypdf.generic import DictionaryObject, NameObject, NumberObject, DecodedStreamObject
    from . import config, figures, knowledge, pdfwork, study
    from .store import now_iso, write_json_atomic

    checks = {}
    writer = PdfWriter()
    page = writer.add_blank_page(width=400, height=240)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    image = DecodedStreamObject()
    image.set_data(bytes([40, 100, 200]) * 80 * 40)
    image.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
                  NameObject('/Width'): NumberObject(80), NameObject('/Height'): NumberObject(40),
                  NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8)})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)}),
        NameObject('/XObject'): DictionaryObject({NameObject('/Im1'): writer._add_object(image)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 16 Tf 30 170 Td (EasyRead standalone PDF test) Tj ET\n'
                    b'BT /F1 12 Tf 30 140 Td (View supplementary material) Tj ET\n'
                    b'q 200 0 0 50 30 80 cm /Im1 Do Q\n'
                    b'BT /F1 12 Tf 30 60 Td (Figure 1. Standalone image test.) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    writer.add_annotation(0, Link(rect=(29, 136, 231, 154), url='https://example.org/supplement'))
    buffer = io.BytesIO()
    writer.write(buffer)
    httpd, app, url = start_server()
    try:
        ws, fresh = app.lib.create_from_pdf(buffer.getvalue(), '1-s2.0-standalone-test.pdf')
        pages = pdfwork.prepare(ws.root)
        ws.update('paper', lambda p: p['meta'].update(pages=pages, page_count=len(pages)))
        ws.update('paper', lambda p: p.update(blocks=[
                                                     {'id':'outline-method','type':'heading','num':'2','level':1,'zh':'方法','page':1},
                                                     {'id':'outline-child','type':'heading','num':'2.1','level':2,'zh':'步骤','page':1},
                                                     {'id':'outline-repeat','type':'heading','num':'2','level':1,'zh':'方法','page':1},
                                                     {'id':'outline-child-repeat','type':'heading','num':'2.1','level':2,'zh':'步骤','page':1},
                                                     {'id':'outline-third','type':'heading','num':'2.1.1','level':3,'zh':'具体操作','page':1},
                                                     {'id': 'fig1', 'type': 'figure', 'page': 1, 'num': '1', 'src': '',
                                                      'caption_en': 'Figure 1. Standalone image test.', 'caption_zh': '图 1：桌面图片验证'},
                                                     {'id': 'p1-link', 'type': 'para', 'page': 1,
                                                      'en': 'View supplementary material', 'zh': '查看补充材料'},
                                                     {'id': 'p1-url', 'type': 'para', 'page': 1,
                                                      'en': 'Website', 'zh': '资料网站：https://example.org/data?a=1&b=2'},
                                                     {'id': 'p1-more', 'type': 'para', 'page': 1,
                                                      'en': 'Another passage for search verification.', 'zh': '第二条资料用于查找验证。'},
                                                     {'id':'phone-original','type':'para','page':1,'en':'Original PDF text imported on a phone.','zh':''}],
                                              translation={'done_pages': [1]}))
        pdfwork.locate(ws.root)
        checks['automatic_figure_crop'] = figures.ensure(ws) == 1 and bool(next(b for b in ws.load('paper')['blocks'] if b['id']=='fig1').get('src'))
        checks['pdf_import'] = fresh
        checks['pdf_render'] = len(pages) == 1 and (ws.root / pages[0]['img']).stat().st_size > 100
        checks['pdf_text'] = 'EasyRead standalone PDF test' in (ws.root / 'extract/page-001.txt').read_text(encoding='utf-8')
        for rel, expected in [('/', b'workspace.css'), ('/read/' + ws.id, b'study-entry.js'), ('/study', b'study-ui.js'), ('/web/css/workspace.css', b'companion'), ('/web/js/common/navigation.js', b'workspaceNav')]:
            with urllib.request.urlopen(url + rel, timeout=10) as response:
                checks[rel] = response.status == 200 and expected in response.read()
        with urllib.request.urlopen(url + '/api/library', timeout=10) as response:
            listing = json.loads(response.read())
        checks['library_api'] = any(item['id'] == ws.id for item in listing['items'])
        for asset in ('common/citations.js','common/journal-rank.js','common/settings-scholar.js','reader/references.js','reader/outline.js'):
            with urllib.request.urlopen(url+'/web/js/'+asset,timeout=10) as response:
                checks['bundled_'+asset] = response.status == 200 and len(response.read()) > 100
        with urllib.request.urlopen(url+'/api/easyscholar',timeout=10) as response:
            scholar_status = json.loads(response.read())
        checks['journal_api_no_credentials'] = not scholar_status['configured'] and 'secret_key' not in scholar_status
        checks['server_reuse'] = existing_server(config.HOME) == url
        checks['bundled_katex'] = (config.WEB / 'vendor/katex/katex.min.js').is_file()
        checks['external_data'] = str(config.HOME) not in str(config.WEB)
        # Persist a note through the real local API, then read the disk state.
        req = urllib.request.Request(url + '/api/p/' + ws.id + '/ops',
            data=json.dumps({'ops': [{'op': 'paper_note', 'body': 'standalone persistence check'}]}).encode(),
            headers={'X-Token': listing['token'], 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                checks['note_saved'] = 'paper_note' in json.loads(response.read())['applied']
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'笔记保存接口 {req.full_url}：{exc.read().decode("utf-8")}') from exc
        checks['data_persisted'] = ws.load('reader')['paper_note']['body'] == 'standalone persistence check'
        sources, retrieval = knowledge.retrieve(app.lib, knowledge.scope(app.lib, {'question': 'Standalone image test persistence'}))
        checks['bundled_sqlite_library_index'] = bool(sources) and retrieval['scope_papers'] == 1
        checks['personal_notes_in_library_index'] = any(s['type'] == 'reader_note' for s in sources)
        req = urllib.request.Request(url + '/api/p/' + ws.id + '/figure',
            data=json.dumps({'id': 'fig1', 'page': 1, 'box': [.073, .455, .578, .67]}).encode(),
            headers={'X-Token': listing['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as response:
            saved_image = json.loads(response.read())
        checks['manual_figure_crop_saved'] = (ws.root / saved_image['src']).is_file() and next(b for b in ws.load('paper')['blocks'] if b['id']=='fig1')['image_method'] == 'manual'
        # A saved answer exercises the packaged UI without consuming an AI request.
        write_json_atomic(study.run_dir() / 'run-f000000000000001.json', {
            'id': 'run-f000000000000001', 'mode': 'knowledge', 'state': 'done', 'created': now_iso(),
            'model': '界面验证', 'papers': [ws.id], 'question': '独立窗口界面验证问题',
            'retrieval': {'scope_papers': 1, 'selected_passages': 1}, 'coverage': [],
            'result': {'sections': [{'title': '回答', 'claims': [{'kind': 'source',
                'text': '这是隔离数据目录内的界面验证资料。', 'citations': [{
                    'paper': ws.id, 'title': '界面验证资料', 'page': 1,
                    'url': '/read/' + ws.id + '#b-fig1', 'quote': 'Figure 1. Standalone image test.'}]}]}],
                'rows': [], 'followups': ['继续核对这条资料']},
        })
        original_paper = ws.load('paper')
        check_window(config.HOME, url, ws.id, checks)
        with urllib.request.urlopen(url + '/api/p/' + ws.id + '/pdf', timeout=10) as response:
            checks['naming_download_original_pdf_bytes'] = response.read() == buffer.getvalue()
            disposition = response.headers.get('Content-Disposition', '')
            decoded = unquote(disposition)
            checks['naming_download_utf8_filename'] = "filename*=UTF-8''" in disposition and '地理信息与生态环境' in decoded and '.pdf' in decoded
        checks['naming_source_and_translation_unchanged'] = ws.load('paper') == original_paper and (ws.root / 'source.pdf').read_bytes() == buffer.getvalue()
        named_item = ws.load('item').get('naming') or {}
        checks['naming_original_provenance_preserved'] = named_item.get('original_filename') == '1-s2.0-standalone-test.pdf' and bool(named_item.get('original_title'))
        write_json_atomic(report, {'status': 'passed' if all(checks.values()) else 'failed', 'at': now_iso(), 'home': str(config.HOME), 'url': url, 'checks': checks})
        if not all(checks.values()):
            return 1
    finally:
        stop_server(httpd, app)
    saved = json.loads(report.read_text(encoding='utf-8'))
    saved['checks']['server_stopped'] = existing_server(config.HOME) is None
    saved['status'] = 'passed' if all(saved['checks'].values()) else 'failed'
    write_json_atomic(report, saved)
    return 0 if saved['status'] == 'passed' else 1


def run_desktop(home: Path):
    kernel, handle, duplicate = acquire_mutex(home)
    event = None
    httpd = app = None
    closed = threading.Event()
    listener_done = threading.Event()
    listener_done.set()
    try:
        event = activation_event(kernel, home)
        if duplicate:
            kernel.SetEvent(event)
            return 0
        url = existing_server(home)
        if not url:
            httpd, app, url = start_server()
        window = create_window(home, url)
        window.events.closed += closed.set
        def activation_listener():
            listener_done.clear()
            try:
                window.events.shown.wait(25)
                while not closed.is_set():
                    if kernel.WaitForSingleObject(event, 300) == 0 and not closed.is_set():
                        window.restore()
                        window.show()
            finally:
                listener_done.set()
        start_window(home, window, activation_listener)
        return 0
    finally:
        closed.set()
        listener_done.wait(1)
        if httpd:
            stop_server(httpd, app)
        if event:
            kernel.CloseHandle(event)
        kernel.CloseHandle(handle)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Folio Read Windows 桌面启动程序')
    parser.add_argument('--data-dir')
    parser.add_argument('--smoke-test', type=Path)
    args = parser.parse_args(argv)
    if sys.stdout is None:
        sys.stdout = open(os.devnull, 'w', encoding='utf-8')
    if sys.stderr is None:
        sys.stderr = open(os.devnull, 'w', encoding='utf-8')
    report = args.smoke_test.resolve() if args.smoke_test else None
    # pywebview resolves resources relative to argv[0], even after data-home chdir.
    sys.argv[0] = str(Path(sys.argv[0]).resolve())
    try:
        if report and not args.data_dir:
            raise ValueError('隔离测试必须明确指定 --data-dir，避免改动真实文献库。')
        app_dir = Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[1]
        home = prepare_home(app_dir, args.data_dir)
        if report:
            return smoke_test(report)
        return run_desktop(home)
    except Exception as exc:
        if report:
            import traceback
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps({'status': 'failed', 'error': str(exc), 'traceback': traceback.format_exc()}, ensure_ascii=False, indent=2), encoding='utf-8')
        else:
            error_dialog(f'启动失败：{exc}\n\n已有文献和笔记保留。详情请查看数据目录内的 easyread.log。')
        return 1
